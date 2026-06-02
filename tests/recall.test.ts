// tests/recall.test.ts — recall.ts TDD 测试套件
// 全部 mock fs/promises，不依赖真实文件系统

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemsearchConfig, MemsearchScoping } from "../src/config";
import type { BankScope, SearchResult } from "../src/types";

// ── Mock fs/promises ──
const appendFileMock = vi.fn();
const mkdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  appendFile: appendFileMock,
  mkdir: mkdirMock,
}));

// ── 延迟导入，确保 mock 先生效 ──
const {
  autoRecall,
  autoRetain,
  computeBankScope,
  formatMemories,
  composeRecallQuery,
} = await import("../src/recall");

// ── Fixtures ──

function makeConfig(overrides: Partial<MemsearchConfig> = {}): MemsearchConfig {
  return {
    embeddingProvider: "onnx",
    embeddingModel: "",
    embeddingApiKey: "",
    milvusUri: "~/.memsearch/milvus.db",
    collection: "memsearch_chunks",
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

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    content: "用户上次讨论了 React 组件的性能优化策略",
    source: "/Users/dev/projects/my-app/memories/2026-05-28.md",
    heading: "React 性能优化讨论",
    chunk_hash: "abc123def456",
    heading_level: 2,
    start_line: 10,
    end_line: 25,
    score: 0.92,
    ...overrides,
  };
}

/** 创建 mock MemsearchClient */
function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    search: vi.fn().mockResolvedValue([]),
    index: vi.fn().mockResolvedValue(0),
    reset: vi.fn(),
    ...overrides,
  };
}

/** 创建最小可用的 duck-type MemsearchSessionState */
function makeState(overrides: Record<string, unknown> = {}) {
  const config = (overrides.config as MemsearchConfig) ?? makeConfig();
  const client = (overrides.client as ReturnType<typeof makeClient>) ?? makeClient();
  return {
    sessionId: "session-test-1",
    config,
    client,
    bankScope: {
      collectionName: config.collection,
    } as BankScope,
    hasRecalledForFirstTurn: false,
    turnCount: 0,
    lastRecallSnippet: undefined,
    session: {},
    taskDepth: 0,
    ...overrides,
  };
}

// ── autoRecall 测试 ──

describe("autoRecall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("首次调用：hasRecalledForFirstTurn=false → client.search 被调用，返回 results，flag 设为 true", async () => {
    const results = [makeSearchResult()];
    const client = makeClient({ search: vi.fn().mockResolvedValue(results) });
    const state = makeState({ client });

    const returned = await autoRecall(state as any, ["最近的对话内容..."]);

    expect(client.search).toHaveBeenCalledTimes(1);
    expect(state.hasRecalledForFirstTurn).toBe(true);
    expect(returned).toEqual(results);
  });

  it("第二次调用：hasRecalledForFirstTurn=true → client.search 未调用，返回空数组", async () => {
    const client = makeClient({ search: vi.fn().mockResolvedValue([makeSearchResult()]) });
    const state = makeState({ client, hasRecalledForFirstTurn: true });

    const returned = await autoRecall(state as any, ["最近的对话内容..."]);

    expect(client.search).not.toHaveBeenCalled();
    expect(returned).toEqual([]);
  });

  it("config.autoRecall=false → 返回空数组，不调用 search", async () => {
    const client = makeClient({ search: vi.fn().mockResolvedValue([makeSearchResult()]) });
    const state = makeState({ client, config: makeConfig({ autoRecall: false }) });

    const returned = await autoRecall(state as any, ["最近的对话内容..."]);

    expect(client.search).not.toHaveBeenCalled();
    expect(returned).toEqual([]);
  });

  it("无 recentTurns 时仍调用 search（用 sessionId 作为 fallback）", async () => {
    const client = makeClient({ search: vi.fn().mockResolvedValue([]) });
    const state = makeState({ client });

    await autoRecall(state as any);

    expect(client.search).toHaveBeenCalledTimes(1);
    const callArgs = client.search.mock.calls[0];
    expect(callArgs[0]).toContain(state.sessionId);
  });

  it("传递 recallLimit 给 client.search", async () => {
    const client = makeClient({ search: vi.fn().mockResolvedValue([]) });
    const state = makeState({ client, config: makeConfig({ recallLimit: 12 }) });

    await autoRecall(state as any, ["query"]);

    expect(client.search).toHaveBeenCalledWith(
      expect.any(String),
      12,
    );
  });
});

// ── autoRetain 测试 ──

describe("autoRetain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // freeze time to have deterministic filename
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
  });

  it("turnCount=4, retainEveryNTurns=4 → 触发 retain，fs.appendFile + client.index 被调用", async () => {
    const client = makeClient({});
    const state = makeState({ client, turnCount: 3 }); // turnCount before increment

    await autoRetain(state as any);

    expect(state.turnCount).toBe(4);
    expect(appendFileMock).toHaveBeenCalledTimes(1);

    const [filePath, content] = appendFileMock.mock.calls[0];
    expect(filePath).toContain("2026-06-01.md");
    expect(content).toBeTruthy();
    expect(client.index).toHaveBeenCalledTimes(1);
  });

  it("turnCount=3, retainEveryNTurns=4 → 不触发 retain，不写文件", async () => {
    const client = makeClient({});
    const state = makeState({ client, turnCount: 2 }); // 2 → 3

    await autoRetain(state as any);

    expect(state.turnCount).toBe(3);
    expect(appendFileMock).not.toHaveBeenCalled();
    expect(client.index).not.toHaveBeenCalled();
  });

  it("config.autoRetain=false → turnCount 不增加，不触发任何操作", async () => {
    const client = makeClient({});
    const state = makeState({ client, config: makeConfig({ autoRetain: false }) });

    await autoRetain(state as any);

    expect(state.turnCount).toBe(0);
    expect(appendFileMock).not.toHaveBeenCalled();
    expect(client.index).not.toHaveBeenCalled();
  });

  it("多次调用后周期触发：第8个turn触发第二次", async () => {
    const client = makeClient({});
    const state = makeState({ client, turnCount: 7 }); // 7 → 8

    await autoRetain(state as any);

    expect(state.turnCount).toBe(8);
    expect(appendFileMock).toHaveBeenCalledTimes(1);
    expect(client.index).toHaveBeenCalledTimes(1);
  });

  it("使用 state.config.memoryDir 作为文件路径", async () => {
    const client = makeClient({});
    const memoryDir = "/custom/memory/path";
    const state = makeState({
      client,
      config: makeConfig({ memoryDir }),
      turnCount: 3,
    });

    await autoRetain(state as any);

    expect(appendFileMock.mock.calls[0][0]).toContain(memoryDir);
    expect(appendFileMock.mock.calls[0][0]).toContain("2026-06-01.md");
  });
});

// ── computeBankScope 测试 ──

describe("computeBankScope", () => {
  it("scoping='global' → 返回 { collectionName: config.collection }", () => {
    const config = makeConfig({ collection: "my_chunks", scoping: "global" });
    const result = computeBankScope(config, "/Users/dev/my-project");

    expect(result).toEqual({ collectionName: "my_chunks" });
  });

  it("scoping='per-project' → 返回 collectionName 带项目名后缀", () => {
    const config = makeConfig({ collection: "my_chunks", scoping: "per-project" });
    const result = computeBankScope(config, "/Users/dev/my-project");

    expect(result).toEqual({ collectionName: "my_chunks_my_project" });
  });

  it("scoping='per-project' 清理特殊字符", () => {
    const config = makeConfig({ collection: "mem", scoping: "per-project" });
    const result = computeBankScope(config, "/Users/dev/my-project!@special");

    // basename: "my-project!@special" → clean: "my_project_special"
    expect(result.collectionName).toBe("mem_my_project_special");
  });

  it("scoping='per-project-tagged' → 返回 collectionName + tags", () => {
    const config = makeConfig({ collection: "my_chunks", scoping: "per-project-tagged" });
    const result = computeBankScope(config, "/Users/dev/my-app");

    expect(result).toEqual({
      collectionName: "my_chunks",
      tags: ["project:my-app"],
    });
  });
});

// ── formatMemories 测试 ──

describe("formatMemories", () => {
  it("空数组返回空 <memories> 块", () => {
    const result = formatMemories([]);
    expect(result).toBe("<memories>\n</memories>");
  });

  it("单条结果：包含 source/score/chunk_hash 属性", () => {
    const results: SearchResult[] = [makeSearchResult()];
    const formatted = formatMemories(results);

    expect(formatted).toContain("<memories>");
    expect(formatted).toContain("</memories>");
    expect(formatted).toContain("source=");
    expect(formatted).toContain("score=");
    expect(formatted).toContain("chunk_hash=");
    expect(formatted).toContain(results[0].content);
  });

  it("多条结果：每条独立 <memory> 标签", () => {
    const results: SearchResult[] = [
      makeSearchResult({ content: "mem1", score: 0.9 }),
      makeSearchResult({ content: "mem2", score: 0.7 }),
    ];
    const formatted = formatMemories(results);

    const memoryTags = formatted.match(/<memory\b/g);
    expect(memoryTags).toHaveLength(2);
    expect(formatted).toContain("mem1");
    expect(formatted).toContain("mem2");
  });

  it("source 和 score 为有效数值格式化", () => {
    const results: SearchResult[] = [
      makeSearchResult({ source: "/mem/2026-05-28.md", score: 0.954321 }),
    ];
    const formatted = formatMemories(results);

    expect(formatted).toContain('source="/mem/2026-05-28.md"');
    expect(formatted).toContain('score="0.95"');
  });
});

// ── composeRecallQuery 测试 ──

describe("composeRecallQuery", () => {
  it("单条 turn → 直接返回内容", () => {
    const result = composeRecallQuery(["用户询问 React 组件优化"]);
    expect(result).toBe("用户询问 React 组件优化");
  });

  it("多条 turn → 用换行符连接", () => {
    const result = composeRecallQuery([
      "用户询问 React 组件优化",
      "助手建议使用 useMemo",
      "用户要求提供示例代码",
    ]);

    expect(result).toBe(
      "用户询问 React 组件优化\n助手建议使用 useMemo\n用户要求提供示例代码",
    );
  });

  it("空数组 → 返回空字符串", () => {
    const result = composeRecallQuery([]);
    expect(result).toBe("");
  });
});
