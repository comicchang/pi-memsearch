// src/state.ts — MemsearchSessionState Symbol-keyed 存储（Mnemopi 风格）
import type { MemsearchConfig } from "./config";
import type { BankScope, MemsearchClient, MemsearchSessionStateOptions } from "./types";

/** Symbol-keyed 存储键 — 挂载到 oh-my-pi AgentSession 对象上 */
export const kMemsearchSessionState = Symbol("memsearch.sessionState");

/** 从 session 对象上获取 MemsearchSessionState */
export function getMemsearchSessionState(
  session: any,
): MemsearchSessionState | undefined {
  return (session as any)[kMemsearchSessionState];
}

/**
 * 向 session 对象上挂载或删除 MemsearchSessionState。
 * 返回 previous（旧值），与 Mnemopi setHindsightSessionState 风格一致。
 */
export function setMemsearchSessionState(
  session: any,
  state: MemsearchSessionState | undefined,
): MemsearchSessionState | undefined {
  const prev = (session as any)[kMemsearchSessionState];
  if (state !== undefined) {
    (session as any)[kMemsearchSessionState] = state;
  } else {
    delete (session as any)[kMemsearchSessionState];
  }
  return prev;
}

export class MemsearchSessionState {
  sessionId: string;
  config: MemsearchConfig;
  bankScope: BankScope;
  client: MemsearchClient;
  session: any;
  taskDepth: number;

  /** 子代理 alias 到父 state（复用 client/config，跳过 auto-recall/retain） */
  aliasOf?: MemsearchSessionState;

  /** 子代理默认 true（无需首次 recall），基 state 默认 false */
  hasRecalledForFirstTurn: boolean;

  /** 缓存上次 recall 结果，供 buildDeveloperInstructions 注入到 System Prompt */
  lastRecallSnippet?: string;

  /** 已完成的 turn 计数，用于 retainEveryNTurns 判断 */
  turnCount: number = 0;

  /** session.subscribe 返回的取消订阅函数 */
  private unsubscribe?: () => void;

  constructor(
    options: MemsearchSessionStateOptions & {
      aliasOf?: MemsearchSessionState;
      hasRecalledForFirstTurn?: boolean;
    },
  ) {
    this.sessionId = options.sessionId;
    this.config = options.config;
    this.client = options.client;
    this.bankScope = options.bankScope;
    this.session = options.session;
    this.taskDepth = options.taskDepth;
    this.aliasOf = options.aliasOf;
    this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
  }

  /**
   * 监听 AgentSession 事件。
   * agent_start → 触发 recall（逻辑在 recall.ts 中实现，此处为占位）
   * agent_end   → 触发 retain（同上）
   */
  attachSessionListeners(): void {
    // 防御：先取消旧订阅
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe(
      (event: { type: string; messages?: unknown[] }) => {
        if (event.type === "agent_start") {
          // recall 逻辑由 recall.ts 负责
        } else if (event.type === "agent_end") {
          // retain 逻辑由 recall.ts 负责
        }
      },
    );
  }

  /** 取消订阅，释放资源。二次调用幂等。 */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
