// tests/state.test.ts — MemsearchSessionState Symbol-keyed 存储 TDD 测试
import { describe, it, expect, vi } from "vitest";
import {
  MemsearchSessionState,
  kMemsearchSessionState,
  getMemsearchSessionState,
  setMemsearchSessionState,
} from "../src/state";
import type { MemsearchConfig } from "../src/config";
import type { BankScope, MemsearchClient } from "../src/types";

// ── 测试辅助：创建 mock 对象 ──

/** 创建最小可用的 duck-type session 对象 */
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    subscribe: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
}

/** 创建最简 MemsearchConfig */
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

/** 创建 mock MemsearchClient */
function makeClient(): MemsearchClient {
  return {} as MemsearchClient;
}

/** 创建 BankScope */
function makeBankScope(overrides: Partial<BankScope> = {}): BankScope {
  return {
    collectionName: "test_collection",
    tags: ["tag1"],
    ...overrides,
  };
}

// ── 测试套件 ──

describe("Symbol-keyed get/set 函数", () => {
  it("set + get 返回同一个对象", () => {
    const session = {};
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    setMemsearchSessionState(session, state);
    expect(getMemsearchSessionState(session)).toBe(state);
  });

  it("set 返回 previous (旧 state)", () => {
    const session = {};
    const state1 = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });
    const state2 = new MemsearchSessionState({
      sessionId: "s2",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    // 首次 set — previous 应为 undefined
    const prev1 = setMemsearchSessionState(session, state1);
    expect(prev1).toBeUndefined();

    // 替换 — previous 应为 state1
    const prev2 = setMemsearchSessionState(session, state2);
    expect(prev2).toBe(state1);

    // get 返回最新的
    expect(getMemsearchSessionState(session)).toBe(state2);
  });

  it("set(session, undefined) 删除 state，返回 previous", () => {
    const session = {};
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    setMemsearchSessionState(session, state);
    expect(getMemsearchSessionState(session)).toBe(state);

    const prev = setMemsearchSessionState(session, undefined);
    expect(prev).toBe(state);
    expect(getMemsearchSessionState(session)).toBeUndefined();
    // Symbol key 应该被删除，不是设成 undefined 值
    expect((session as any)[kMemsearchSessionState]).toBeUndefined();
  });

  it("get 在无 state 时返回 undefined", () => {
    const session = {};
    expect(getMemsearchSessionState(session)).toBeUndefined();
  });
});

describe("MemsearchSessionState 构造", () => {
  it("所有属性正确赋值", () => {
    const session = makeSession();
    const config = makeConfig({ bankName: "my-bank" });
    const client = makeClient();
    const bankScope = makeBankScope({ collectionName: "col", tags: ["a", "b"] });

    const state = new MemsearchSessionState({
      sessionId: "session-1",
      config,
      client,
      bankScope,
      session,
      taskDepth: 2,
    });

    expect(state.sessionId).toBe("session-1");
    expect(state.config).toBe(config);
    expect(state.client).toBe(client);
    expect(state.bankScope).toBe(bankScope);
    expect(state.session).toBe(session);
    expect(state.taskDepth).toBe(2);
  });

  it("默认 hasRecalledForFirstTurn = false", () => {
    const session = makeSession();
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    expect(state.hasRecalledForFirstTurn).toBe(false);
  });

  it("默认 turnCount = 0", () => {
    const session = makeSession();
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    expect(state.turnCount).toBe(0);
  });

  it("lastRecallSnippet 默认 undefined", () => {
    const session = makeSession();
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    expect(state.lastRecallSnippet).toBeUndefined();
  });
});

describe("aliasOf 子代理", () => {
  it("child.aliasOf === parent", () => {
    const session = makeSession();
    const parent = new MemsearchSessionState({
      sessionId: "parent",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    const child = new MemsearchSessionState({
      sessionId: "child",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 1,
      aliasOf: parent,
    });

    expect(child.aliasOf).toBe(parent);
  });

  it("child.client === parent.client, child.config === parent.config", () => {
    const session = makeSession();
    const config = makeConfig({ bankName: "shared-bank" });
    const client = makeClient();

    const parent = new MemsearchSessionState({
      sessionId: "parent",
      config,
      client,
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    const child = new MemsearchSessionState({
      sessionId: "child",
      config, // 相同 config
      client, // 相同 client
      bankScope: makeBankScope(),
      session,
      taskDepth: 1,
      aliasOf: parent,
    });

    expect(child.client).toBe(parent.client);
    expect(child.config).toBe(parent.config);
  });

  it("child.hasRecalledForFirstTurn === true（构造时传入）", () => {
    const session = makeSession();
    const parent = new MemsearchSessionState({
      sessionId: "parent",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    const child = new MemsearchSessionState({
      sessionId: "child",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 1,
      aliasOf: parent,
      hasRecalledForFirstTurn: true,
    });

    expect(child.hasRecalledForFirstTurn).toBe(true);
    expect(parent.hasRecalledForFirstTurn).toBe(false);
  });
});

describe("attachSessionListeners", () => {
  it("subscribe 被调用", () => {
    const session = makeSession();
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    state.attachSessionListeners();
    expect(session.subscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribe 回调接收 agent_start 事件", () => {
    const session = makeSession();
    const subscribeSpy = vi.fn();
    session.subscribe = vi.fn((cb) => {
      subscribeSpy.mockImplementation(cb);
      return vi.fn();
    });

    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    state.attachSessionListeners();

    // 模拟 agent_start 事件
    subscribeSpy({ type: "agent_start" });
    // 不抛异常即为通过
    expect(session.subscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribe 回调接收 agent_end 事件", () => {
    const session = makeSession();
    const subscribeSpy = vi.fn();
    session.subscribe = vi.fn((cb) => {
      subscribeSpy.mockImplementation(cb);
      return vi.fn();
    });

    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    state.attachSessionListeners();

    // 模拟 agent_end 事件（带 messages）
    subscribeSpy({ type: "agent_end", messages: [] });
    expect(session.subscribe).toHaveBeenCalledTimes(1);
  });

  it("subscribe 回调忽略未知事件类型", () => {
    const session = makeSession();
    const subscribeSpy = vi.fn();
    session.subscribe = vi.fn((cb) => {
      subscribeSpy.mockImplementation(cb);
      return vi.fn();
    });

    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    state.attachSessionListeners();

    // 未知事件类型 → 不抛异常
    subscribeSpy({ type: "unknown_event" });
  });
});

describe("dispose", () => {
  it("attach → dispose → unsubscribe 被调用", () => {
    const unsubscribeFn = vi.fn();
    const session = { subscribe: vi.fn().mockReturnValue(unsubscribeFn) };

    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    state.attachSessionListeners();
    expect(session.subscribe).toHaveBeenCalledTimes(1);

    state.dispose();
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it("二次 dispose 不报错（幂等）", () => {
    const session = { subscribe: vi.fn().mockReturnValue(vi.fn()) };

    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    state.attachSessionListeners();
    state.dispose();
    // 二次 dispose 不应抛异常
    expect(() => state.dispose()).not.toThrow();
  });

  it("未 attach 直接 dispose 不报错", () => {
    const session = { subscribe: vi.fn().mockReturnValue(vi.fn()) };

    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    expect(() => state.dispose()).not.toThrow();
  });
});

describe("hasRecalledForFirstTurn", () => {
  it("基 state 默认 false", () => {
    const session = makeSession();
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    expect(state.hasRecalledForFirstTurn).toBe(false);
  });

  it("构造选项可显式设为 true", () => {
    const session = makeSession();
    const state = new MemsearchSessionState({
      sessionId: "s1",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
      hasRecalledForFirstTurn: true,
    });

    expect(state.hasRecalledForFirstTurn).toBe(true);
  });

  it("子代理 hasRecalledForFirstTurn = true（构造传入）", () => {
    const session = makeSession();
    const parent = new MemsearchSessionState({
      sessionId: "parent",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 0,
    });

    const child = new MemsearchSessionState({
      sessionId: "child",
      config: makeConfig(),
      client: makeClient(),
      bankScope: makeBankScope(),
      session,
      taskDepth: 1,
      aliasOf: parent,
      hasRecalledForFirstTurn: true,
    });

    expect(child.hasRecalledForFirstTurn).toBe(true);
    expect(child.aliasOf?.hasRecalledForFirstTurn).toBe(false);
  });
});
