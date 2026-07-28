// src/backend.ts — memsearchBackend MemoryBackend 实现
import { mkdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { loadMemsearchConfig } from "./config";
import { MemsearchClient } from "./client";
import { MemsearchSessionState, getMemsearchSessionState, setMemsearchSessionState } from "./state";
import { computeBankScope, autoRecall, autoRetain, formatMemories } from "./recall";
import type { SearchResult } from "./types";

// ── 静态 System Prompt 指令 ──
const STATIC_INSTRUCTIONS = `## Memory (memsearch)

You have access to persistent Memory tools for recalling and expanding past context:

- **memory_search(query, top_k)** — 语义检索过去的记忆片段，返回最相关的 top_k 个结果
- **memory_get(chunk_hash)** — 展开指定 chunk_hash 对应的完整原文

Memory 内容跨 session 持久化，可用于恢复历史上下文。`;

// ── memsearchBackend 对象 ──
export const memsearchBackend = {
  id: "memsearch" as const,

  // ── start ──
  async start(options: {
    sessionId: string;
    session: any;
    taskDepth: number;
    agentDir: string;
    cwd: string;
    settings: { get(key: string): string | undefined };
  }): Promise<void> {
    if (!options.sessionId) return;

    const config = loadMemsearchConfig(options.settings);
    const bankScope = computeBankScope(config, options.cwd);

    if (options.taskDepth > 0) {
      // 子代理：复用父 state 的 client/config
      const parentState = getMemsearchSessionState(options.session);
      const client = parentState?.client ?? new MemsearchClient(config, bankScope.collectionName, config.memoryDir);

      const state = new MemsearchSessionState({
        sessionId: options.sessionId,
        config: parentState?.config ?? config,
        client,
        bankScope,
        session: options.session,
        taskDepth: options.taskDepth,
        aliasOf: parentState,
        hasRecalledForFirstTurn: true,
      });

      setMemsearchSessionState(options.session, state);
    } else {
      // 主代理：新建 client 和 state
      const client = new MemsearchClient(config, bankScope.collectionName, config.memoryDir);

      const state = new MemsearchSessionState({
        sessionId: options.sessionId,
        config,
        client,
        bankScope,
        session: options.session,
        taskDepth: 0,
      });

      setMemsearchSessionState(options.session, state);
      state.attachSessionListeners();
    }
  },

  // ── buildDeveloperInstructions ──
  async buildDeveloperInstructions(
    _agentDir: string,
    _settings: any,
    session: any,
  ): Promise<string | undefined> {
    const state = getMemsearchSessionState(session);
    if (!state) return undefined;

    const parts = [STATIC_INSTRUCTIONS];
    if (state.lastRecallSnippet) {
      parts.push(state.lastRecallSnippet);
    }

    return parts.join("\n\n");
  },

  // ── clear ──
  async clear(
    _agentDir: string,
    _cwd: string,
    session: any,
  ): Promise<void> {
    const state = getMemsearchSessionState(session);
    if (state) {
      state.dispose();
      state.client.reset();
    }
    setMemsearchSessionState(session, undefined);
  },

  // ── enqueue ──
  async enqueue(
    _agentDir: string,
    _cwd: string,
    session: any,
  ): Promise<void> {
    const state = getMemsearchSessionState(session);
    if (state) {
      await autoRetain(state);
    }
  },

  // ── stats ──
  async stats(
    _agentDir: string,
    _cwd: string,
    session: any,
  ): Promise<string | undefined> {
    const state = getMemsearchSessionState(session);
    if (!state) return undefined;

    return String(state.client.stats());
  },

  // ── beforeAgentStartPrompt ──
  async beforeAgentStartPrompt(
    session: any,
    _promptText: string,
  ): Promise<string | undefined> {
    const state = getMemsearchSessionState(session);
    if (!state) return undefined;
    if (state.aliasOf) return formatMemories([]);  // 子代理: 跳过
    const results = await autoRecall(state);
    return formatMemories(results);
  },

  // ── status ──
  async status(context: { agentDir: string; cwd: string; session?: any }): Promise<{
    backend: string;
    active: boolean;
    writable: boolean;
    searchable: boolean;
    scope?: string;
    database?: string;
    message?: string;
  }> {
    const state = getMemsearchSessionState(context.session);
    if (!state) {
      return {
        backend: "memsearch",
        active: false,
        writable: false,
        searchable: false,
        message: "memsearch 后端未初始化。",
      };
    }
    return {
      backend: "memsearch",
      active: true,
      writable: true,
      searchable: true,
      scope: state.config.scoping,
      database: state.config.milvusUri,
    };
  },

  // ── search ──
  async search(
    context: { session?: any },
    query: string,
    options?: { limit?: number },
  ): Promise<{
    backend: string;
    query: string;
    count: number;
    items: Array<{ content: string; source?: string; score?: number }>;
    message?: string;
  }> {
    const state = getMemsearchSessionState(context.session);
    if (!state) {
      return { backend: "memsearch", query, count: 0, items: [], message: "后端未初始化。" };
    }
    const results = await state.client.search(query, options?.limit ?? state.config.recallLimit);
    return {
      backend: "memsearch",
      query,
      count: results.length,
      items: results.map((r) => ({
        content: r.content,
        source: r.source,
        score: r.score,
      })),
    };
  },

  // ── save ──
  async save(
    context: { cwd: string; session?: any },
    input: { content: string; source?: string; importance?: number },
  ): Promise<{
    backend: string;
    stored: number;
    message?: string;
  }> {
    const state = getMemsearchSessionState(context.session);
    if (!state) {
      return { backend: "memsearch", stored: 0, message: "后端未初始化。" };
    }
    const content = input.content?.trim();
    if (!content) {
      return { backend: "memsearch", stored: 0, message: "记忆内容不能为空。" };
    }
    try {
      const memoryDir = resolve(state.config.memoryDir);
      await mkdir(memoryDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(memoryDir, `${today}.md`);
      const timestamp = new Date().toTimeString().slice(0, 5);
      const source = input.source || "backend-save";
      const entry = `\n### ${timestamp}\n<!-- source:${source} session:${state.sessionId} -->\n- ${content}\n`;
      await appendFile(filePath, entry, "utf-8");
      await state.client.index();
      return { backend: "memsearch", stored: 1 };
    } catch (e: any) {
      return { backend: "memsearch", stored: 0, message: `保存失败: ${e.message}` };
    }
  },

  // ── diagnose ──
  async diagnose(
    _agentDir: string,
    _cwd: string,
    session?: any,
  ): Promise<string | undefined> {
    const state = getMemsearchSessionState(session);
    const checks: string[] = [];

    // CLI
    try {
      const version = await new Promise<string>((resolveVersion, reject) => {
        execFile("memsearch", ["--version"], { timeout: 10000 }, (err, stdout) => {
          if (err) reject(err); else resolveVersion(stdout as string);
        });
      });
      checks.push(`[OK] memsearch CLI: ${version.trim()}`);
    } catch {
      checks.push("[FAIL] memsearch CLI 不可用");
    }

    if (state) {
      checks.push(`[OK] Session: ${state.sessionId}, turns=${state.turnCount}`);
      try {
        const total = await state.client.stats();
        checks.push(`[OK] 索引: ${total} chunks`);
      } catch {
        checks.push("[FAIL] 索引查询失败");
      }
    } else {
      checks.push("[WARN] Session 状态未初始化");
    }

    return `## memsearch Diagnostics\n\n${checks.join("\n")}`;
  },

  // ── preCompactionContext ──
  async preCompactionContext(
    messages: Array<{ role: string; content: string }>,
    _settings: any,
    session: any,
  ): Promise<string | undefined> {
    const state = getMemsearchSessionState(session);
    if (!state) return undefined;

    // 提取用户消息构造 recall 查询
    const userMessages = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    const query = userMessages.slice(-2000); // 截断
    const results = await state.client.search(query, state.config.recallLimit);

    return formatMemories(results);
  },
};
