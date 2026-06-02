// src/recall.ts — autoRecall / autoRetain / 作用域解析 / 格式化
//
// 参考 SPEC.md §7 Recall / Retain 逻辑

import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MemsearchConfig } from "./config";
import type { MemsearchSessionState } from "./state";
import type { BankScope, SearchResult } from "./types";

// ── autoRecall ──

/**
 * 首次 agent_start 时自动 recall 记忆。
 * @param state - session 状态
 * @param recentTurns - 最近 N 个 turn 的文本内容（可省略，用 sessionId 兜底）
 * @returns 搜索结果列表
 */
export async function autoRecall(
  state: MemsearchSessionState,
  recentTurns?: string[],
): Promise<SearchResult[]> {
  if (!state.config.autoRecall) return [];
  if (state.hasRecalledForFirstTurn) return [];

  const query = recentTurns?.length
    ? composeRecallQuery(recentTurns)
    : `session:${state.sessionId}`;

  const results = await state.client.search(query, state.config.recallLimit);
  state.hasRecalledForFirstTurn = true;
  return results;
}

// ── autoRetain ──

/**
 * 每个 turn 结束后判断是否需要 retain 记忆。
 * turnCount % retainEveryNTurns === 0 时触发。
 * 写入 .memsearch/memory/YYYY-MM-DD.md，然后触发索引。
 */
export async function autoRetain(state: MemsearchSessionState): Promise<void> {
  if (!state.config.autoRetain) return;

  state.turnCount++;

  if (state.turnCount % state.config.retainEveryNTurns !== 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const filePath = join(state.config.memoryDir, `${today}.md`);

  const entry = formatRetainEntry(state.turnCount, state.sessionId, today);

  await mkdir(state.config.memoryDir, { recursive: true });
  await appendFile(filePath, entry, "utf-8");
  await state.client.index();
}

// ── computeBankScope ──

/**
 * 根据 scoping 配置解析 BankScope。
 * - global: 所有项目共享同一 collection
 * - per-project: 每个项目独立 collection（collection_{项目名}）
 * - per-project-tagged: 同一 collection + 项目标签过滤
 */
export function computeBankScope(
  config: MemsearchConfig,
  cwd: string,
): BankScope {
  switch (config.scoping) {
    case "global":
      return { collectionName: config.collection };

    case "per-project": {
      const label = basename(cwd).replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
      return { collectionName: `${config.collection}_${label}` };
    }

    case "per-project-tagged":
      return {
        collectionName: config.collection,
        tags: [`project:${basename(cwd)}`],
      };
  }
}

// ── formatMemories ──

/**
 * 将搜索结果格式化为 <memories> markdown 块。
 * 注入到 system prompt 中供 LLM 参考。
 */
export function formatMemories(results: SearchResult[]): string {
  if (results.length === 0) {
    return "<memories>\n</memories>";
  }

  const entries = results.map((r) => {
    const score = r.score.toFixed(2);
    return `<memory source="${r.source}" score="${score}" chunk_hash="${r.chunk_hash}">\n${r.content}\n</memory>`;
  });

  return `<memories>\n${entries.join("\n")}\n</memories>`;
}

// ── composeRecallQuery ──

/**
 * 将最近 N 个 turn 的文本拼接为搜索查询。
 * memsearch search 的 query 参数。
 */
export function composeRecallQuery(recentTurns: string[]): string {
  return recentTurns.join("\n");
}

// ── 内部辅助 ──

/**
 * 生成 retain 写入的 markdown 条目。
 * 写入格式：## Session {sessionId} (Turn {turnCount}) + 日期
 */
function formatRetainEntry(
  turnCount: number,
  sessionId: string,
  date: string,
): string {
  return `\n## Session ${sessionId} (Turn ${turnCount})\n**日期**: ${date}\n\n`;
}
