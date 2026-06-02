import * as fs from "node:fs";

// tests/client.test.ts — MemsearchClient TDD 测试套件
// 全部 mock child_process.execFile（回调风格），不依赖真实 CLI

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemsearchConfig } from "../src/config";

// ── Mock execFile（回调风格） ──
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));
vi.mock("node:fs");

// 延迟导入，确保 mock 先生效
const { MemsearchClient } = await import("../src/client");

// ── 测试用 fixture ──
function makeConfig(overrides: Partial<MemsearchConfig> = {}): MemsearchConfig {
  return {
    embeddingProvider: "onnx",
    embeddingModel: "",
    embeddingApiKey: "",
    milvusUri: "~/.memsearch/milvus.db",
    collection: "test_collection",
    maxChunkSize: 1500,
    overlapLines: 2,
    scoping: "per-project-tagged",
    bankName: "test-bank",
    autoRecall: true,
    autoRetain: true,
    retainEveryNTurns: 4,
    recallLimit: 8,
    recallContextTurns: 5,
    memoryDir: ".memsearch/memory",
    debug: false,
    ...overrides,
  };
}

function makeClient(
  overrides: Partial<MemsearchConfig> = {},
  collectionName = "test_collection",
  memoryPath = "/tmp/test-memory",
): MemsearchClient {
  return new MemsearchClient(makeConfig(overrides), collectionName, memoryPath);
}

// ── 将 mock 输出转为 execFile 回调风格的工具函数 ──
function resolveWith(returnValue: string) {
  // execFile(file, args, options, callback) → 异步调用 callback(null, stdout)
  execFileMock.mockImplementationOnce((_file: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
    setImmediate(() => cb(null, returnValue));
    return { on: vi.fn(), kill: vi.fn() };
  });
}

function rejectWithEnoint() {
  const enoent = new Error("spawn memsearch ENOENT");
  (enoent as NodeJS.ErrnoException).code = "ENOENT";
  execFileMock.mockImplementationOnce((_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
    setImmediate(() => cb(enoent));
    return { on: vi.fn(), kill: vi.fn() };
  });
}

// ── 单条搜索结果 fixture ──
function mockSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    content: "test content",
    source: "/f.md",
    chunk_hash: "abc123",
    heading: "H1",
    heading_level: 1,
    start_line: 1,
    end_line: 3,
    score: 0.99,
    ...overrides,
  };
}

describe("MemsearchClient", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  // ── 1. search 返回 JSON 结果 ──
  it("search() 应解析 JSON 输出为 SearchResult[]", async () => {
    const result = mockSearchResult();
    resolveWith(JSON.stringify([result]));

    const client = makeClient();
    const results = await client.search("query", 5);

    expect(results).toEqual([result]);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const callArgs = execFileMock.mock.calls[0];
    expect(callArgs[0]).toBe("memsearch");
    expect(callArgs[1]).toContain("search");
    expect(callArgs[1]).toContain("query");
    expect(callArgs[1]).toContain("--top-k");
    expect(callArgs[1]).toContain("5");
    expect(callArgs[1]).toContain("--json-output");
  });

  // ── 2. search 返回空数组 ──
  it("search() 应处理空 JSON 数组", async () => {
    resolveWith("[]");

    const client = makeClient();
    const results = await client.search("nothing", 5);

    expect(results).toEqual([]);
  });

  // ── 3. stats 有数据 ──
  it("stats() 应解析文本输出返回总数", async () => {
    resolveWith("Total indexed chunks: 142\n");

    const client = makeClient();
    const count = await client.stats();

    expect(count).toBe(142);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][1]).toContain("stats");
  });

  // ── 4. stats 为零 ──
  it("stats() 应返回 0 当无索引数据", async () => {
    resolveWith("Total indexed chunks: 0\n");

    const client = makeClient();
    const count = await client.stats();

    expect(count).toBe(0);
  });

  // ── 5. index ──
  it("index() 应解析索引输出返回 chunk 数", async () => {
    resolveWith("Indexed 42 chunks.\n");

    const client = makeClient();
    const count = await client.index();

    expect(count).toBe(42);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const callArgs = execFileMock.mock.calls[0];
    expect(callArgs[1]).toContain("index");
    expect(callArgs[1]).toContain("/tmp/test-memory");
  });

  // ── 6. reset ──
  it("reset() 应不抛异常", async () => {
    resolveWith("");

    const client = makeClient();
    await expect(client.reset()).resolves.toBeUndefined();
    expect(execFileMock.mock.calls[0][1]).toContain("reset");
    expect(execFileMock.mock.calls[0][1]).toContain("--yes");
  });

  // ── 7. ENOENT search 降级 ──
  it("search() 应在 CLI 不存在时返回空数组", async () => {
    rejectWithEnoint();

    const client = makeClient();
    const results = await client.search("query", 5);

    expect(results).toEqual([]);
  });

  // ── 8. ENOENT index 降级 ──
  it("index() 应在 CLI 不存在时返回 0", async () => {
    rejectWithEnoint();

    const client = makeClient();
    const count = await client.index();

    expect(count).toBe(0);
  });

  // ── 9. JSON 解析异常 ──
  it("search() 应在 JSON 解析失败时返回空数组", async () => {
    resolveWith("garbage output not json");

    const client = makeClient();
    const results = await client.search("query", 5);

    expect(results).toEqual([]);
  });

  // ── 10. ensureConfig ──
  it("ensureConfig() should write .memsearch.toml", () => {
    const client = makeClient();
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    client.ensureConfig();
    expect(writeSpy).toHaveBeenCalled();
    const callArgs = writeSpy.mock.calls[0];
    expect(callArgs[0]).toContain(".memsearch.toml");
    const content = callArgs[1] as string;
    expect(content).toContain("collection =");
    expect(content).toContain("provider =");
    writeSpy.mockRestore();
  });
});
