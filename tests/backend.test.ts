// tests/backend.test.ts — memsearchBackend TDD 测试套件
// 全部外部依赖 mock：config、client、state、recall
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock helpers ──
const loadMemsearchConfigMock = vi.fn();
const MemsearchClientMock = vi.fn();
const computeBankScopeMock = vi.fn();
const autoRecallMock = vi.fn();
const autoRetainMock = vi.fn();
const formatMemoriesMock = vi.fn();
const getMemsearchSessionStateMock = vi.fn();
const setMemsearchSessionStateMock = vi.fn();
const attachSessionListenersMock = vi.fn();
const disposeMock = vi.fn();
const clientResetMock = vi.fn();
const clientStatsMock = vi.fn();
const clientSearchMock = vi.fn();

// ── Mock 模块 ──
vi.mock("../src/config", () => ({
  loadMemsearchConfig: loadMemsearchConfigMock,
}));

vi.mock("../src/client", () => ({
  MemsearchClient: MemsearchClientMock,
}));

vi.mock("../src/recall", () => ({
  computeBankScope: computeBankScopeMock,
  autoRecall: autoRecallMock,
  autoRetain: autoRetainMock,
  formatMemories: formatMemoriesMock,
}));

vi.mock("../src/state", () => ({
  getMemsearchSessionState: getMemsearchSessionStateMock,
  setMemsearchSessionState: setMemsearchSessionStateMock,
  MemsearchSessionState: vi.fn(),
}));

// 延迟导入，确保 mock 先生效
const { memsearchBackend } = await import("../src/backend");

// ── 测试用 fixture ──
function makeSettings(overrides: Record<string, string> = {}) {
  return { get: (key: string) => overrides[key] };
}

function makeConfig() {
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
  } as const;
}

function makeBankScope() {
  return { collectionName: "test_collection", tags: ["test-bank"] };
}

function makeClientInstance() {
  return {
    reset: clientResetMock,
    stats: clientStatsMock,
    search: clientSearchMock,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    subscribe: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
}

function makeSearchResults() {
  return [
    {
      content: "记忆片段1",
      source: "/f1.md",
      heading: "Title1",
      chunk_hash: "abc",
      heading_level: 1,
      start_line: 1,
      end_line: 3,
      score: 0.9,
    },
  ];
}

// ── 所有测试重置 mock ──
beforeEach(() => {
  vi.clearAllMocks();
  // 默认 mock 行为
  loadMemsearchConfigMock.mockReturnValue(makeConfig());
  computeBankScopeMock.mockReturnValue(makeBankScope());
  formatMemoriesMock.mockReturnValue("FORMATTED_MEMORIES");
  clientStatsMock.mockReturnValue(42);
  clientSearchMock.mockReturnValue(makeSearchResults());
  autoRecallMock.mockResolvedValue(makeSearchResults());
  autoRetainMock.mockResolvedValue(undefined);
});

// ═══════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════

describe("memsearchBackend", () => {
  // ── 1. start() 正常流程 ──
  describe("start() 正常", () => {
    it("taskDepth=0: 加载配置 → 创建 client → computeScope → newState → attach", async () => {
      const config = makeConfig();
      const bankScope = makeBankScope();
      loadMemsearchConfigMock.mockReturnValue(config);
      computeBankScopeMock.mockReturnValue(bankScope);

      const clientInstance = makeClientInstance();
      MemsearchClientMock.mockReturnValue(clientInstance);

      const session = makeSession();
      const settings = makeSettings();

      const { MemsearchSessionState } = await import("../src/state");
      const stateInstance = {
        attachSessionListeners: attachSessionListenersMock,
      };
      (MemsearchSessionState as any).mockReturnValue(stateInstance);

      await memsearchBackend.start({
        sessionId: "s1",
        session,
        taskDepth: 0,
        agentDir: "/tmp/agent",
        cwd: "/tmp/cwd",
        settings,
      });

      // 验证调用链
      expect(loadMemsearchConfigMock).toHaveBeenCalledWith(settings);
      expect(computeBankScopeMock).toHaveBeenCalledWith(config, "/tmp/cwd");
      expect(MemsearchClientMock).toHaveBeenCalledWith(
        config,
        bankScope.collectionName,
        config.memoryDir,
      );
      expect(MemsearchSessionState).toHaveBeenCalledWith({
        sessionId: "s1",
        config,
        client: clientInstance,
        bankScope,
        session,
        taskDepth: 0,
      });
      expect(setMemsearchSessionStateMock).toHaveBeenCalledWith(
        session,
        stateInstance,
      );
      expect(attachSessionListenersMock).toHaveBeenCalled();
    });
  });

  // ── 2. start() subagent ──
  describe("start() subagent", () => {
    it("taskDepth=1: 子代理 alias 父 state，共享 client/config", async () => {
      const config = makeConfig();
      const bankScope = makeBankScope();
      loadMemsearchConfigMock.mockReturnValue(config);
      computeBankScopeMock.mockReturnValue(bankScope);

      const session = makeSession();
      const settings = makeSettings();

      // 父 state
      const parentState = {
        sessionId: "parent",
        client: makeClientInstance(),
        config,
      };
      getMemsearchSessionStateMock.mockReturnValue(parentState);

      const { MemsearchSessionState } = await import("../src/state");
      const childStateInstance = {};
      (MemsearchSessionState as any).mockReturnValue(childStateInstance);

      await memsearchBackend.start({
        sessionId: "child",
        session,
        taskDepth: 1,
        agentDir: "/tmp/agent",
        cwd: "/tmp/cwd",
        settings,
      });

      // 验证子代理 state 构造参数
      expect(MemsearchSessionState).toHaveBeenCalledWith({
        sessionId: "child",
        config,
        client: parentState.client,
        bankScope,
        session,
        taskDepth: 1,
        aliasOf: parentState,
        hasRecalledForFirstTurn: true,
      });
      expect(setMemsearchSessionStateMock).toHaveBeenCalledWith(
        session,
        childStateInstance,
      );
    });
  });

  // ── 3. start() no sessionId ──
  describe("start() no sessionId", () => {
    it("sessionId 为空字符串时直接 return", async () => {
      await memsearchBackend.start({
        sessionId: "",
        session: makeSession(),
        taskDepth: 0,
        agentDir: "/tmp/agent",
        cwd: "/tmp/cwd",
        settings: makeSettings(),
      });

      expect(loadMemsearchConfigMock).not.toHaveBeenCalled();
      expect(MemsearchClientMock).not.toHaveBeenCalled();
      expect(setMemsearchSessionStateMock).not.toHaveBeenCalled();
    });
  });

  // ── 4. buildDeveloperInstructions ──
  describe("buildDeveloperInstructions", () => {
    it("state.lastRecallSnippet 存在时返回含 RECALL + Memory 的字符串", async () => {
      const session = makeSession();
      const state = { lastRecallSnippet: "RECALL" };
      getMemsearchSessionStateMock.mockReturnValue(state);

      const result = await memsearchBackend.buildDeveloperInstructions(
        "/tmp/agent",
        makeSettings(),
        session,
      );

      expect(typeof result).toBe("string");
      expect(result).toContain("RECALL");
      expect(result).toContain("Memory");
    });
  });

  // ── 5. buildDeveloperInstructions no state ──
  describe("buildDeveloperInstructions no state", () => {
    it("state 不存在时返回 undefined", async () => {
      getMemsearchSessionStateMock.mockReturnValue(undefined);

      const result = await memsearchBackend.buildDeveloperInstructions(
        "/tmp/agent",
        makeSettings(),
        makeSession(),
      );

      expect(result).toBeUndefined();
    });
  });

  // ── 6. clear ──
  describe("clear", () => {
    it("dispose 旧 state → client.reset → setState(undefined)", async () => {
      const session = makeSession();
      const clientInstance = makeClientInstance();
      const state = {
        dispose: disposeMock,
        client: clientInstance,
      };
      getMemsearchSessionStateMock.mockReturnValue(state);

      await memsearchBackend.clear("/tmp/agent", "/tmp/cwd", session);

      expect(disposeMock).toHaveBeenCalled();
      expect(clientResetMock).toHaveBeenCalled();
      expect(setMemsearchSessionStateMock).toHaveBeenCalledWith(
        session,
        undefined,
      );
    });
  });

  // ── 7. enqueue ──
  describe("enqueue", () => {
    it("获取 state → autoRetain 被调用", async () => {
      const session = makeSession();
      const state = { turnCount: 3 };
      getMemsearchSessionStateMock.mockReturnValue(state);

      await memsearchBackend.enqueue("/tmp/agent", "/tmp/cwd", session);

      expect(autoRetainMock).toHaveBeenCalledWith(state);
    });
  });

  // ── 8. stats ──
  describe("stats", () => {
    it("client.stats() 返回结果转为字符串", async () => {
      const session = makeSession();
      const state = { client: { stats: clientStatsMock } };
      getMemsearchSessionStateMock.mockReturnValue(state);
      clientStatsMock.mockReturnValue(42);

      const result = await memsearchBackend.stats(
        "/tmp/agent",
        "/tmp/cwd",
        session,
      );

      expect(clientStatsMock).toHaveBeenCalled();
      expect(result).toBe("42");
    });
  });

  // ── 9. beforeAgentStartPrompt ──
  describe("beforeAgentStartPrompt", () => {
    it("autoRecall 返回结果 → formatMemories 返回文本", async () => {
      const session = makeSession();
      const results = makeSearchResults();
      autoRecallMock.mockResolvedValue(results);
      formatMemoriesMock.mockReturnValue("MEM_BLOCK");

      const state = {};
      getMemsearchSessionStateMock.mockReturnValue(state);

      const result = await memsearchBackend.beforeAgentStartPrompt(
        session,
        "user prompt",
      );

      expect(autoRecallMock).toHaveBeenCalledWith(state);
      expect(formatMemoriesMock).toHaveBeenCalledWith(results);
      expect(result).toBe("MEM_BLOCK");
    });
  });

  // ── 10. preCompactionContext ──
  describe("preCompactionContext", () => {
    it("client.search 查询 → formatMemories 返回文本", async () => {
      const session = makeSession();
      const results = makeSearchResults();
      const clientInstance = makeClientInstance();
      clientSearchMock.mockReturnValue(results);
      formatMemoriesMock.mockReturnValue("COMPACTED_MEM");

      const state = {
        client: clientInstance,
        config: makeConfig(),
      };
      getMemsearchSessionStateMock.mockReturnValue(state);

      const messages = [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好！有什么可以帮你的？" },
      ];

      const result = await memsearchBackend.preCompactionContext(
        messages,
        makeSettings(),
        session,
      );

      expect(clientSearchMock).toHaveBeenCalled();
      expect(formatMemoriesMock).toHaveBeenCalledWith(results);
      expect(result).toBe("COMPACTED_MEM");
    });
  });
});
