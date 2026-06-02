// src/config.ts — MemsearchConfig 类型定义 + 配置加载

/**
 * 记忆作用域：记忆在哪个 collection 中存储。
 * - "global": 所有项目共享同一 collection
 * - "per-project": 每个项目独立 collection
 * - "per-project-tagged": 每个项目独立 collection + 带子话题标签
 */
export type MemsearchScoping = "global" | "per-project" | "per-project-tagged";

/**
 * Memsearch 记忆后端配置。
 * 所有字段均来自 oh-my-pi Settings（omp.config.yml 的 memsearch 块）。
 */
export interface MemsearchConfig {
  /** 嵌入提供者 */
  embeddingProvider:
    | "onnx"
    | "openai"
    | "ollama"
    | "local"
    | "google"
    | "voyage"
    | "jina"
    | "mistral";
  /** 嵌入模型名，空串 = 使用提供者默认 */
  embeddingModel: string;
  /** 嵌入 API Key，支持 "env:VAR_NAME" 语法 */
  embeddingApiKey: string;
  /** Milvus Lite 数据库 URI（本地 sqlite 文件路径） */
  milvusUri: string;
  /** Milvus collection 名 */
  collection: string;
  /** 分块最大大小（字符数） */
  maxChunkSize: number;
  /** 分块重叠行数 */
  overlapLines: number;
  /** 作用域策略 */
  scoping: MemsearchScoping;
  /** bank 名（空 = 自动从项目目录名生成） */
  bankName: string;
  /** agent_start 时自动 recall */
  autoRecall: boolean;
  /** agent_end 时自动 retain */
  autoRetain: boolean;
  /** 每 N 个 turn 触发一次 retain */
  retainEveryNTurns: number;
  /** 每次 recall 返回的最大结果数 */
  recallLimit: number;
  /** recall 查询中使用的最近 turn 数 */
  recallContextTurns: number;
  /** 记忆 Markdown 文件目录 */
  memoryDir: string;
  /** 调试模式 */
  debug: boolean;
}

/** 默认配置（与 SPEC.md 4.3 一致） */
const DEFAULTS: MemsearchConfig = {
  embeddingProvider: "onnx",
  embeddingModel: "",
  embeddingApiKey: "",
  milvusUri: "~/.memsearch/milvus.db",
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

const VALID_SCOPINGS: MemsearchScoping[] = [
  "global",
  "per-project",
  "per-project-tagged",
];

const KEY_PREFIX = "memsearch.";

// ── 内部转换辅助 ──

/** 解析 scoping 枚举，无效值 fallback 到 "per-project-tagged" */
function toScoping(value: string | undefined): MemsearchScoping {
  if (
    value !== undefined &&
    value !== "" &&
    VALID_SCOPINGS.includes(value as MemsearchScoping)
  ) {
    return value as MemsearchScoping;
  }
  return "per-project-tagged";
}

/** 字符串 → number，undefined/空/NaN 时用 fallback */
function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/** 字符串 → boolean，"true"（忽略大小写）为 true，其余为 false */
function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

// ── 主加载函数 ──

/**
 * 从 oh-my-pi Settings 对象加载 memsearch 配置。
 * Settings.get(key) 返回 string | undefined，所有 memsearch 配置
 * 使用 "memsearch." 前缀。
 */
export function loadMemsearchConfig(settings: {
  get(key: string): string | undefined;
}): MemsearchConfig {
  const get = (key: string) => settings.get(`${KEY_PREFIX}${key}`);

  return {
    embeddingProvider:
      (get("embeddingProvider") as MemsearchConfig["embeddingProvider"]) ||
      DEFAULTS.embeddingProvider,
    embeddingModel: get("embeddingModel") || DEFAULTS.embeddingModel,
    embeddingApiKey: get("embeddingApiKey") || DEFAULTS.embeddingApiKey,
    milvusUri: get("milvusUri") || DEFAULTS.milvusUri,
    collection: get("collection") || DEFAULTS.collection,
    maxChunkSize: toNumber(get("maxChunkSize"), DEFAULTS.maxChunkSize),
    overlapLines: toNumber(get("overlapLines"), DEFAULTS.overlapLines),
    scoping: toScoping(get("scoping")),
    bankName: get("bankName") || DEFAULTS.bankName,
    autoRecall: toBoolean(get("autoRecall"), DEFAULTS.autoRecall),
    autoRetain: toBoolean(get("autoRetain"), DEFAULTS.autoRetain),
    retainEveryNTurns: Math.max(
      1,
      toNumber(get("retainEveryNTurns"), DEFAULTS.retainEveryNTurns),
    ),
    recallLimit: Math.max(
      1,
      toNumber(get("recallLimit"), DEFAULTS.recallLimit),
    ),
    recallContextTurns: toNumber(
      get("recallContextTurns"),
      DEFAULTS.recallContextTurns,
    ),
    memoryDir: get("memoryDir") || DEFAULTS.memoryDir,
    debug: toBoolean(get("debug"), DEFAULTS.debug),
  };
}
