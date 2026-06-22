// tests/integration.test.ts — memsearch CLI 集成测试
//
// 默认跳过（不依赖真实 CLI 环境）。
// 设置 RUN_MEMSEARCH_INTEGRATION=1 启用：
//
//   RUN_MEMSEARCH_INTEGRATION=1 npx vitest run
//
// 测试用例：index → search → expand → stats → reset 完整通路

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { loadMemsearchConfig } from "../src/config";
import { MemsearchClient } from "../src/client";
import type { MemsearchConfig } from "../src/config";

// ── ENV Gate ──
const runIntegration = process.env.RUN_MEMSEARCH_INTEGRATION === "1";
const describeIf = runIntegration ? describe : describe.skip;

// ── Helpers ──

function makeSettings(
  overrides: Record<string, string> = {},
): { get(key: string): string | undefined } {
  return { get: (key: string) => overrides[key] };
}

function makeConfig(): MemsearchConfig {
  return loadMemsearchConfig(makeSettings());
}

// ── Tests ──

describeIf("memsearch CLI integration", () => {
  const testDir = `/tmp/pi-memsearch-integration-${Date.now()}`;
  const memoryDir = `${testDir}/memory`;
  const collectionName = `pi_memsearch_test_${Date.now()}`;
  const milvusUri = `${testDir}/milvus.db`;

  let client: MemsearchClient;

  beforeAll(async () => {
    // 在 /tmp 下创建临时目录和测试内容
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      `${memoryDir}/test-001.md`,
      [
        "# Test Memory Alpha",
        "",
        "This is the first integration test memory.",
        "It contains information about AI agent memory systems.",
        "",
        "## Details",
        "",
        "The pi-memsearch project implements memory for oh-my-pi agents.",
        "It uses the memsearch CLI under the hood.",
      ].join("\n"),
    );
    await writeFile(
      `${memoryDir}/test-002.md`,
      [
        "# Test Memory Beta",
        "",
        "This is the second integration test memory.",
        "Memsearch supports semantic search over markdown files.",
        "",
        "## Features",
        "",
        "- Semantic search with embeddings",
        "- Chunk-based indexing",
        "- Milvus Lite backend",
      ].join("\n"),
    );

    const config: MemsearchConfig = {
      ...makeConfig(),
      milvusUri,
      collection: collectionName,
    };
    client = new MemsearchClient(config, collectionName, memoryDir);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("index — 应索引 markdown 文件并返回 chunk 数", async () => {
    const count = await client.index();
    expect(count).toBeGreaterThan(0);
  });

  it("search — 应返回匹配结果", async () => {
    const results = await client.search("memory system", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("content");
    expect(results[0]).toHaveProperty("chunk_hash");
    expect(results[0]).toHaveProperty("source");
    expect(results[0]).toHaveProperty("score");
  });

  it("expand — 应根据 chunk_hash 展开原文", async () => {
    const results = await client.search("memory system", 5);
    expect(results.length).toBeGreaterThan(0);

    const hash = results[0].chunk_hash;
    const expanded = await client.expand(hash);
    expect(expanded).toBeTruthy();
    expect(expanded.length).toBeGreaterThan(0);
  });

  it("stats — 应返回已索引 chunk 总数", async () => {
    const total = await client.stats();
    expect(total).toBeGreaterThan(0);
  });

  it("reset — 应清空索引", async () => {
    await client.reset();
    const total = await client.stats();
    expect(total).toBe(0);
  });
});
