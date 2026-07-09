// src/plugin.ts — oh-my-pi 插件入口（不修改 oh-my-pi 源码）
// 通过 ExtensionAPI 生命周期钩子接入，而非 MemoryBackend 注册
//
// 使用 duck-type any 避免 peer dependency 问题：
//   不导入 @oh-my-pi/pi-coding-agent 或 @oh-my-pi/pi-agent-core 的任何类型。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { MemsearchClient, warmupMemsearch } from "./client";
import { autoRecall, autoRetain, computeBankScope, formatMemories } from "./recall";
import {
  MemsearchSessionState,
  getMemsearchSessionState,
  setMemsearchSessionState,
} from "./state";
import type { MemsearchConfig } from "./config";

// 辅助：异步 execFile
function execFileAsync(file: string, args: string[], options: { timeout: number; encoding: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as string);
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, options.timeout);
    child.on("exit", () => clearTimeout(timer));
  });
}
export default function (pi: any) {
  let config: MemsearchConfig | null = null;

  // 用 capturedRef 解决 registerTool execute 闭包里拿不到 ctx 的问题
  let capturedRef: { ctx: any; state: MemsearchSessionState | undefined } = {
    ctx: null,
    state: undefined,
  };

  // ── session_start: 初始化 backend ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    // 直接检查 ~/.omp/agent/config.yml 是否配置了 memsearch
    let isEnabled = false;
    try {
      const configPath = join(homedir(), ".omp", "agent", "config.yml");
      const raw = readFileSync(configPath, "utf-8");
      isEnabled = /^\s*backend:\s*memsearch\s*$/m.test(raw);
    } catch {}
    if (!isEnabled) return;

    // P1: 预热 memsearch CLI（fire-and-forget，触发 uvx 缓存 + onnxruntime 加载）
    warmupMemsearch();

    // 使用默认配置（暂不从 omp.config.yml 的 memsearch 块读取）
    const cwd: string = ctx.cwd ?? process.cwd();
    const defaultConfig: MemsearchConfig = {
      embeddingProvider: "onnx",
      embeddingModel: "",
      embeddingApiKey: "",
      milvusUri: join(homedir(), ".memsearch", "milvus.db"),
      collection: "memsearch_chunks",
      maxChunkSize: 1500,
      overlapLines: 2,
      scoping: "per-project-tagged",
      bankName: "",
      autoRecall: true,
      autoRetain: true,
      retainEveryNTurns: 4,
      recallLimit: 8,
      recallContextTurns: 5,
      memoryDir: ".memsearch/memory",
      debug: false,
    };
    config = defaultConfig;

    const bankScope = computeBankScope(config, cwd);
    const client = new MemsearchClient(
      config,
      bankScope.collectionName,
      config.memoryDir,
    );



    const state = new MemsearchSessionState({
      sessionId: (ctx as any).sessionId ?? "unknown",
      config,
      client,
      bankScope,
      session: {} as any,
      taskDepth: 0,
    });

    setMemsearchSessionState(ctx, state);
    capturedRef.ctx = ctx;
    capturedRef.state = state;
  });

  // ── before_agent_start: 注入记忆到 system prompt ──
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!config?.autoRecall) return;

    const state = getMemsearchSessionState(ctx);
    if (!state || state.hasRecalledForFirstTurn) return;

    try {
      const results = await autoRecall(state);
      if (!results.length) return;

      state.lastRecallSnippet = formatMemories(results);

      const prompt: string[] = Array.isArray(event.systemPrompt)
        ? event.systemPrompt
        : [event.systemPrompt ?? ""];

      return { systemPrompt: [...prompt, "", state.lastRecallSnippet] };
    } catch {
      // recall 失败不影响 agent
    }
  });

  // ── agent_end: 触发 autoRetain ──
  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (!config?.autoRetain) return;

    const state = getMemsearchSessionState(ctx);
    if (!state) return;

    try {
      await autoRetain(state);
    } catch {
      // retain 失败不影响 agent
    }
  });

  // ── session_shutdown: 清理 ──
  pi.on("session_shutdown", () => {
    if (capturedRef.state) {
      capturedRef.state.dispose();
    }
    if (capturedRef.ctx) {
      setMemsearchSessionState(capturedRef.ctx, undefined);
    }
    config = null;
    capturedRef.ctx = null;
    capturedRef.state = undefined;
  });

  // ── 注册 memory_search 工具 ──
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "搜索 persist 记忆库，返回相关历史对话片段。使用 memsearch 的混合语义搜索（BM25 + dense + RRF）。",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "搜索关键词" },
        top_k: { type: "number", description: "最多返回几条（默认5）" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      const state = capturedRef.state;
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: "记忆后端未初始化。请检查 omp.config.yml 中 memory.backend 是否为 memsearch。",
            },
          ],
          details: {},
        };
      }

      try {
        const results = await state.client.search(
          params.query,
          params.top_k ?? 5,
        );
        return {
          content: [
            {
              type: "text",
              text: results.length
                ? formatMemories(results)
                : "未找到相关记忆。",
            },
          ],
          details: {},
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: `搜索失败: ${e.message}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // ── 注册 memory_get 工具（展开完整段落）──
  pi.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description:
      "根据 memory_search 返回的 chunk_hash 展开完整原文段落，包含上下文和来源信息。",
    parameters: {
      type: "object" as const,
      properties: {
        chunk_hash: { type: "string", description: "从 memory_search 结果中获取的 chunk_hash" },
      },
      required: ["chunk_hash"],
    },
    async execute(_id: string, params: any) {
      const state = capturedRef.state;
      if (!state) return { content: [{ type: "text", text: "记忆后端未初始化。" }], details: {} };
      try {
        const text = await state.client.expand(params.chunk_hash);
        return { content: [{ type: "text", text: text || "未找到该记忆原文。" }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `展开失败: ${e.message}` }], details: {} };
      }
    },
  });

  // ── 注册 memory_stats 工具（索引统计）──
  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "显示记忆索引入统计：已索引的 chunk 数量、存储路径等。",
    parameters: {
      type: "object" as const,
      properties: {},
    },
    async execute() {
      const state = capturedRef.state;
      if (!state) return { content: [{ type: "text", text: "记忆后端未初始化。" }], details: {} };
      try {
        const total = await state.client.stats();
        return {
          content: [{
            type: "text",
            text: `已索引 chunk: ${total}\n记忆目录: ${state.config.memoryDir}\nMilvus: ${state.config.milvusUri}\nCollection: ${state.bankScope.collectionName}`
          }],
          details: {},
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `获取统计失败: ${e.message}` }], details: {} };
      }
    },
  });

  // ── 注册 memory_transcript 工具（读取 OpenCode SQLite 原文）──
  pi.registerTool({
    name: "memory_transcript",
    label: "Memory Transcript",
    description:
      "读取指定 session 的原始对话记录（从 OpenCode SQLite 数据库）。可查看之前对话的完整上下文。",
    parameters: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session ID（可从 memory_search 结果的 source 注释中提取）" },
        limit: { type: "number", description: "最多返回几条消息（默认20）" },
      },
      required: ["session_id"],
    },
    async execute(_id: string, params: any) {
      const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
      try {
        // 查 session 信息
        const sessionInfo = await execFileAsync("sqlite3", [dbPath, "-json", 
          `SELECT id, directory, title, model, datetime(time_created/1000,'unixepoch') as time FROM session WHERE id='${params.session_id}'`],
          { timeout: 5000, encoding: "utf8" });
        const sessions = JSON.parse(sessionInfo || "[]") as any[];
        
        if (!sessions.length) {
          return { content: [{ type: "text", text: `未找到 session: ${params.session_id}` }], details: {} };
        }

        const limit = params.limit ?? 20;
        // 查消息和文本 part
        const rows = await execFileAsync("sqlite3", [dbPath, "-json",
          `SELECT m.id as msg_id, json_extract(m.data,'$.role') as role, 
                  datetime(m.time_created/1000,'unixepoch') as time,
                  json_extract(p.data,'$.type') as part_type,
                  json_extract(p.data,'$.text') as text
           FROM message m 
           JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
           WHERE m.session_id='${params.session_id}' 
             AND json_extract(p.data,'$.type') IN ('text','reasoning')
           ORDER BY m.time_created ASC, p.time_created ASC
           LIMIT ${limit * 5}`],
          { timeout: 10000, encoding: "utf8" });
        
        const parts = JSON.parse(rows || "[]") as any[];
        
        if (!parts.length) {
          return { content: [{ type: "text", text: `Session ${params.session_id} 无对话记录。` }], details: {} };
        }

        const header = `## 对话记录: ${sessions[0].title}\n**时间**: ${sessions[0].time}\n**目录**: ${sessions[0].directory}\n\n`;
        let lastMsgId = "";
        const lines: string[] = [header];
        
        for (const p of parts) {
          if (p.msg_id !== lastMsgId) {
            lastMsgId = p.msg_id;
            const label = p.role === "user" ? "[Human]" : p.role === "assistant" ? "[Assistant]" : `[${p.role}]`;
            lines.push(`\n${label} (${p.time}):`);
          }
          if (p.text && p.text.trim()) {
            const prefix = p.part_type === "reasoning" ? "  > " : "  ";
            lines.push(prefix + p.text.trim());
          }
        }
        
        return { content: [{ type: "text", text: lines.join("\n").slice(0, 8000) }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `读取 transcript 失败: ${e.message}. DB: ${dbPath}` }], details: {} };
      }
    },
  });
  }
