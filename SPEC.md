# pi-memsearch: oh-my-pi Memory Backend for zilliztech/memsearch

## TL;DR

为 [oh-my-pi](https://github.com/can1357/oh-my-pi) 实现一个新的 `memory-backend`（`"memsearch"`），底层使用 [zilliztech/memsearch](https://github.com/zilliztech/memsearch) 的 Python CLI 做向量索引和混合语义搜索。

**不同于现有的 Hindsight/Mnemopi，memsearch 的核心价值在于**：
- Markdown 作为 Source of Truth（可版本控制、人类可读）
- 向量索引是**可重建的影子**（Milvus Lite），从不锁定数据
- 同一后端可跨 Claude Code / OpenCode / oh-my-pi 共享记忆

---

## 1. 项目结构

```
pi-memsearch/
├── src/
│   ├── index.ts              # 入口：export memsearchBackend + 类型
│   ├── backend.ts            # MemoryBackend 接口实现
│   ├── config.ts             # MemsearchConfig 类型 + 加载逻辑
│   ├── client.ts             # memsearch CLI 封装（child_process）
│   ├── state.ts              # MemsearchSessionState（Symbol-keyed）
│   ├── recall.ts             # recall/retain 逻辑
│   └── types.ts              # 内部类型
├── tests/
│   ├── backend.test.ts
│   ├── client.test.ts
│   └── integration.test.ts
├── package.json
├── tsconfig.json
├── README.md
├── SPEC.md                   # 本文件
└── .gitignore
```

## 2. 核心架构

### 2.1 数据流

```
oh-my-pi session
  │
  ├── agent_start  →  autoRecall() → memsearch search "latest context" → 注入 <memories>
  │
  ├── turn_end     →  autoRetain() → 提取摘要 → 写入 .memsearch/memory/YYYY-MM-DD.md
  │                                    → memsearch index .memsearch/memory/
  │
  ├── /memory search <query>  →  memsearch search <query> --json-output
  ├── /memory stats           →  memsearch stats
  ├── /memory clear           →  memsearch reset --yes
  └── /memory enqueue         →  同 autoRetain（手动触发）
```

### 2.2 与现有 Backend 的关系

| 组件 | Hindsight (参考) | Mnemopi (参考) | **memsearch (本项目)** |
|------|-----------------|---------------|----------------------|
| 存储 | 远程 HTTP API | 本地 SQLite + 内置向量 | 本地 Markdown + Milvus Lite |
| 嵌入 | API 端处理 | 内置（@oh-my-pi/pi-mnemopi） | memsearch Python CLI（ONNX/openai/ollama） |
| 搜索 | HTTP API recall | SQL + 内置向量搜索 | `memsearch search` CLI（混合 BM25+dense+RRF） |
| 作用域 | global/per-project/per-project-tagged | 同 | 同（通过 `--collection` 参数） |

### 2.3 与 dotai 现有配置的关系

当前模板中 `memory.backend: local` 是硬编码的。需要改为 `memory.backend: memsearch`。

dotai 需要的改动（本项目完成后，作为下游集成步骤）：
- `profiles/templates/omp.config.{work,home}.yml`：`memory.backend: local` → `memory.backend: memsearch`
- `profiles/policy/components.json`：添加 pi-memsearch 到 omp 的 plugins 数组

---

## 3. 接口实现

### 3.1 MemoryBackend 接口（来自 oh-my-pi）

```typescript
// 实现 oh-my-pi 的 MemoryBackend 接口
// 参考文件：oh-my-pi/packages/coding-agent/src/memory-backend/types.ts

export interface MemoryBackend {
    readonly id: MemoryBackendId;  // "memsearch"

    start(options: MemoryBackendStartOptions): void | Promise<void>;

    buildDeveloperInstructions(
        agentDir: string,
        settings: Settings,
        session?: AgentSession,
    ): Promise<string | undefined>;

    clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

    enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

    stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

    diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

    beforeAgentStartPrompt?(
        session: AgentSession,
        promptText: string
    ): Promise<string | undefined>;

    preCompactionContext?(
        messages: AgentMessage[],
        settings: Settings,
        session?: AgentSession,
    ): Promise<string | undefined>;
}
```

**MemoryBackendId 扩展**：需要在 oh-my-pi 的类型联合中添加 `"memsearch"`：
```typescript
// oh-my-pi/packages/coding-agent/src/memory-backend/types.ts
export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "memsearch";
```

注意：`MemoryBackendId` 的修改属于 oh-my-pi 仓库的改动，本项目无法直接修改。实现时假设此类型已扩展。

### 3.2 MemoryBackendStartOptions 扩展

```typescript
export interface MemoryBackendStartOptions {
    session: AgentSession;
    settings: Settings;
    modelRegistry: ModelRegistry;
    agentDir: string;
    taskDepth: number;
    parentHindsightSessionState?: HindsightSessionState;
    parentMnemopiSessionState?: MnemopiSessionState;
    // 本项目新增：
    parentMemsearchSessionState?: MemsearchSessionState;
}
```

### 3.3 Session State 模式（遵循 Hindsight/Mnemopi 惯例）

```typescript
// src/state.ts
// 使用 Symbol 键存储在 AgentSession 上

const kMemsearchSessionState = Symbol("memsearch.sessionState");

export class MemsearchSessionState {
    readonly sessionId: string;
    readonly config: MemsearchConfig;
    readonly bankScope: BankScope;
    readonly client: MemsearchClient;
    private autoRecallEnabled: boolean;
    private autoRetainEnabled: boolean;
    private turnCount: number;
    hasRecalledForFirstTurn: boolean;
    private disposeFns: Array<() => void>;

    constructor(options: MemsearchSessionStateOptions);

    attachSessionListeners(): void;
    dispose(): void;
    autoRecall(): Promise<SearchResult[]>;
    autoRetain(messages: AgentMessage[]): Promise<void>;
    getRecentTurns(contextTurns: number): Promise<HindsightMessage[]>;
}

export interface MemsearchSessionStateOptions {
    sessionId: string;
    config: MemsearchConfig;
    client: MemsearchClient;
    bankScope: BankScope;
    session: AgentSession;
    taskDepth: number;
}
```

### 3.4 AgentSession 注入

```typescript
// 需要在 oh-my-pi 的 AgentSession 中添加：
declare module "@oh-my-pi/pi-agent-core" {
    interface AgentSession {
        getMemsearchSessionState(): MemsearchSessionState | undefined;
        setMemsearchSessionState(state: MemsearchSessionState): MemsearchSessionState | undefined;
    }
}
```

---

## 4. 配置 Schema

### 4.1 omp.config.yml 中的配置块

```yaml
# ~/.omp/agent/config.yml

memory:
  backend: memsearch   # 改为 "memsearch"

# memsearch 专有配置
memsearch:
  # ── 嵌入 ──
  embeddingProvider: onnx        # onnx | openai | ollama | local | google | voyage | jina | mistral
  embeddingModel: ""             # 空 = 提供者默认值。onnx 默认 bge-m3-int8
  embeddingApiKey: ""            # 支持 "env:VAR_NAME" 语法

  # ── Milvus ──
  milvusUri: "~/.memsearch/milvus.db"   # 本地 Milvus Lite
  collection: "memsearch_chunks"         # 集合名

  # ── 分块 ──
  maxChunkSize: 1500
  overlapLines: 2

  # ── 作用域 ──
  scoping: per-project-tagged    # global | per-project | per-project-tagged
  bankName: ""                   # 空 = 自动从项目目录名生成

  # ── 自动行为 ──
  autoRecall: true               # agent_start 时自动查询近期上下文
  autoRetain: true               # agent_end 时自动写入 .memsearch/memory/
  retainEveryNTurns: 4           # 每 N 个 turn 触发一次 retain
  recallLimit: 8                 # 每次 recall 返回的最大结果数
  recallContextTurns: 5          # recall 查询中使用的最近 turn 数

  # ── 内存目录 ──
  memoryDir: ".memsearch/memory"

  # ── 调试 ──
  debug: false
```

### 4.2 MemsearchConfig TypeScript 类型

```typescript
// src/config.ts

export interface MemsearchConfig {
    embeddingProvider: "onnx" | "openai" | "ollama" | "local" | "google" | "voyage" | "jina" | "mistral";
    embeddingModel: string;
    embeddingApiKey: string;
    milvusUri: string;
    collection: string;
    maxChunkSize: number;
    overlapLines: number;
    scoping: MemsearchScoping;
    bankName: string;
    autoRecall: boolean;
    autoRetain: boolean;
    retainEveryNTurns: number;
    recallLimit: number;
    recallContextTurns: number;
    memoryDir: string;
    debug: boolean;
}

export type MemsearchScoping = "global" | "per-project" | "per-project-tagged";

// 从 oh-my-pi Settings 对象加载
export function loadMemsearchConfig(settings: Settings): MemsearchConfig;
```

### 4.3 配置加载（默认值）

```typescript
const DEFAULTS: Partial<MemsearchConfig> = {
    embeddingProvider: "onnx",
    milvusUri: "~/.memsearch/milvus.db",
    collection: "memsearch_chunks",
    maxChunkSize: 1500,
    overlapLines: 2,
    scoping: "per-project-tagged",
    autoRecall: true,
    autoRetain: true,
    retainEveryNTurns: 4,
    recallLimit: 8,
    recallContextTurns: 5,
    memoryDir: ".memsearch/memory",
    debug: false,
};
```

---

## 5. CLI 封装（MemsearchClient）

### 5.1 接口设计

```typescript
// src/client.ts

export class MemsearchClient {
    private config: MemsearchConfig;
    private collectionName: string;
    private memoryPath: string;

    constructor(config: MemsearchConfig, collectionName: string, memoryPath: string);

    async index(): Promise<void>;
    // → memsearch index <memoryPath> --provider <embeddingProvider> --collection <name> --milvus-uri <uri> --max-chunk-size <n>

    async search(query: string, topK: number): Promise<SearchResult[]>;
    // → memsearch search "<query>" --top-k <topK> --provider ... --json-output

    async expand(chunkHash: string): Promise<string>;
    // → memsearch expand <chunkHash> --provider ... --json-output

    async stats(): Promise<string>;
    // → memsearch stats --collection <name> --milvus-uri <uri>

    async reset(): Promise<void>;
    // → memsearch reset --yes --collection <name> --milvus-uri <uri>

    ensureConfig(): void;
    // → 在项目根目录生成 .memsearch.toml

    private buildBaseArgs(): string[];
}

export interface SearchResult {
    content: string;
    source: string;
    heading: string;
    chunk_hash: string;
    heading_level: number;
    start_line: number;
    end_line: number;
    score: number;
}
```

### 5.2 CLI 命令映射

| 方法 | CLI 命令 |
|------|---------|
| `index()` | `memsearch index <memoryPath> --provider onnx --collection memsearch_chunks --milvus-uri ~/.memsearch/milvus.db` |
| `search(q, k)` | `memsearch search "<q>" --top-k <k> --provider onnx --collection ... --json-output` |
| `expand(hash)` | `memsearch expand <hash> --provider onnx --collection ... --json-output` |
| `stats()` | `memsearch stats --collection ... --milvus-uri ...`（解析输出字符串） |
| `reset()` | `memsearch reset --yes --collection ... --milvus-uri ...` |

### 5.3 错误处理

```typescript
// 超时处理
const SEARCH_TIMEOUT_MS = 30_000;
const INDEX_TIMEOUT_MS = 120_000;

// memsearch CLI 不存在时的处理
// → 输出友好提示：pip install "memsearch[onnx]"
// → 不崩溃，返回空结果或跳过操作
```

---

## 6. Backend 实现

### 6.1 start()

```typescript
// src/backend.ts

export const memsearchBackend: MemoryBackend = {
    id: "memsearch",

    async start(options: MemoryBackendStartOptions): Promise<void> {
        // Step 1: 子代理处理（taskDepth > 0）
        if (options.taskDepth > 0) {
            const parent = options.parentMemsearchSessionState;
            if (!parent) return;
            const childState = new MemsearchSessionState({
                sessionId: options.session.sessionId,
                config: parent.config,
                client: parent.client,
                bankScope: parent.bankScope,
                session: options.session,
                taskDepth: options.taskDepth,
            });
            childState.hasRecalledForFirstTurn = true;  // 跳过首轮 auto-recall
            const old = options.session.setMemsearchSessionState(childState);
            old?.dispose();
            childState.attachSessionListeners();
            return;
        }

        // Step 2: 加载配置
        const config = loadMemsearchConfig(options.settings);
        if (!config.autoRecall && !config.autoRetain) return;

        // Step 3: 解析作用域
        const cwd = options.session.sessionManager.getCwd();
        const bankScope = computeBankScope(config, cwd);
        const collectionName = config.collection + (bankScope.suffix ?? "");
        const memoryPath = resolveMemoryPath(config, cwd);

        // Step 4: 初始化 client 并确保配置
        const client = new MemsearchClient(config, collectionName, memoryPath);
        client.ensureConfig();

        // Step 5: 初始索引
        await client.index();

        // Step 6: 创建 session state 并附加到 session
        const state = new MemsearchSessionState({
            sessionId: options.session.sessionId,
            config, client, bankScope,
            session: options.session,
            taskDepth: options.taskDepth,
        });

        const previous = options.session.setMemsearchSessionState(state);
        previous?.dispose();
        state.attachSessionListeners();
    },

    // 其余方法见下文...
};
```

### 6.2 其余方法

```typescript
async buildDeveloperInstructions(agentDir, settings, session) {
    // → 注入 memory_search/memory_get/memory_stats/memory_clear 工具的使用说明
    // → 返回 <memories_instructions> markdown 块
}

async clear(agentDir, cwd, session) {
    // → state.client.reset()
}

async enqueue(agentDir, cwd, session) {
    // → state.autoRetain(recentMessages)
}

async stats(agentDir, cwd, session) {
    // → return state.client.stats()
}

async beforeAgentStartPrompt(session, promptText) {
    // → autoRecall → format → 注入 <memories> 块到 prompt 开头
}

async preCompactionContext(messages, settings, session) {
    // → 提取关键主题 → search → formatCompactMemories
}
```

---

## 7. Recall / Retain 逻辑

### 7.1 autoRecall()

```typescript
// src/recall.ts

async function autoRecall(state: MemsearchSessionState): Promise<SearchResult[]> {
    if (!state.config.autoRecall) return [];
    if (state.hasRecalledForFirstTurn) return [];

    const recentTurns = await state.getRecentTurns(state.config.recallContextTurns);
    const query = composeRecallQuery(recentTurns);

    const results = await state.client.search(query, state.config.recallLimit);
    state.hasRecalledForFirstTurn = true;
    return results;
}
```

### 7.2 autoRetain()

```typescript
async function autoRetain(
    state: MemsearchSessionState,
    messages: AgentMessage[],
): Promise<void> {
    if (!state.config.autoRetain) return;

    state.turnCount++;
    if (state.turnCount % state.config.retainEveryNTurns !== 0) return;

    const transcript = prepareRetentionTranscript(messages);
    if (!transcript) return;

    const today = new Date().toISOString().slice(0, 10);
    const memoryFile = path.join(state.memoryPath, `${today}.md`);
    const entry = formatMemoryEntry(transcript);

    await fs.appendFile(memoryFile, entry, "utf-8");
    await state.client.index();
}
```

### 7.3 作用域解析

```typescript
export function computeBankScope(config: MemsearchConfig, cwd: string): BankScope {
    switch (config.scoping) {
        case "global":
            return { collectionName: config.collection };
        case "per-project":
            const label = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_");
            return { collectionName: `${config.collection}_${label}` };
        case "per-project-tagged":
            return {
                collectionName: config.collection,
                tags: [`project:${path.basename(cwd)}`],
            };
    }
}
```

---

## 8. package.json

```json
{
  "name": "pi-memsearch",
  "version": "0.1.0",
  "description": "oh-my-pi memory backend using zilliztech/memsearch for hybrid semantic search",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src/ tests/",
    "prepare": "npm run build"
  },
  "dependencies": {
    "toml": "^3.0.0"
  },
  "peerDependencies": {
    "@oh-my-pi/pi-agent-core": "*",
    "@oh-my-pi/pi-coding-agent": "*"
  },
  "devDependencies": {
    "typescript": "^5.0",
    "vitest": "^1.0",
    "@types/node": "^20"
  },
  "files": ["dist/", "README.md"],
  "keywords": ["oh-my-pi", "memsearch", "memory", "rag", "vector-search"],
  "license": "MIT"
}
```

### 系统依赖

- **Python 3.10+** + `pip install "memsearch[onnx]"`（推荐 ONNX：纯 CPU，bge-m3-int8，无需 API key）
- 可选：`memsearch[openai]`, `memsearch[ollama]`, `memsearch[local]`

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["tests", "dist"]
}
```

---

## 9. 测试

### 9.1 client.test.ts — 单元测试

- Mock `child_process.execFileSync` / `spawn`
- 测试 `MemsearchClient.search()` JSON 输出解析
- 测试 `MemsearchClient.index()` 错误处理
- 测试 `MemsearchClient.ensureConfig()` 生成 .memsearch.toml
- 测试 CLI 不存在时的错误提示

### 9.2 backend.test.ts — Backend 测试

- Mock `MemsearchClient` + AgentSession
- 测试 `start()` 完整流程
- 测试 `start()` with taskDepth > 0（子代理模式）
- 测试 `buildDeveloperInstructions()` 返回正确格式
- 测试 `clear()`, `stats()`, `enqueue()`
- 测试 `beforeAgentStartPrompt()` 注入 `<memories>` 块
- 测试 `preCompactionContext()` 返回压缩上下文

### 9.3 integration.test.ts — 集成测试

- 需要 `memsearch` CLI 可执行
- 完整 `index → search → expand` 流程
- 验证结果格式

---

## 10. 实现优先级

### Wave 1: 核心通路
1. `config.ts` — MemsearchConfig 类型 + loadMemsearchConfig()
2. `types.ts` — BankScope, SearchResult 等
3. `client.ts` — MemsearchClient 封装 memsearch CLI
4. `state.ts` — MemsearchSessionState
5. `recall.ts` — autoRecall() + autoRetain()
6. `backend.ts` — memsearchBackend 对象
7. `index.ts` — 导出入口

### Wave 2: 测试 + 文档
8. `tests/client.test.ts`
9. `tests/backend.test.ts`
10. `README.md`
11. `package.json` + `tsconfig.json`

### Wave 3: dotai 集成（本项目完成后的下游步骤）
12. 修改 `profiles/templates/omp.config.{work,home}.yml`：`memory.backend: local` → `memory.backend: memsearch`，添加 `memsearch:` 配置块
13. 修改 `profiles/policy/components.json`：添加 pi-memsearch 到 omp plugins

---

## 11. 关键参考

### oh-my-pi 源码
| 文件 | 用途 |
|------|------|
| `packages/coding-agent/src/memory-backend/types.ts` | MemoryBackend 接口 |
| `packages/coding-agent/src/memory-backend/resolve.ts` | Backend 解析 |
| `packages/coding-agent/src/mnemopi/backend.ts` | 最接近本项目架构的参考实现 |
| `packages/coding-agent/src/hindsight/backend.ts` | Hindsight 参考 |
| `packages/coding-agent/src/hindsight/state.ts` | SessionState Symbol-keyed 模式 |
| `packages/coding-agent/src/hindsight/config.ts` | Config 加载 |
| `packages/coding-agent/src/hindsight/bank.ts` | Bank Scope 作用域 |
| `packages/coding-agent/src/hindsight/content.ts` | recall/retain 辅助函数 |

### memsearch 文档
| 文件 | 用途 |
|------|------|
| `docs/python-api.md` | Python API（MemSearch, search, index） |
| `docs/cli.md` | CLI 命令参考 |
| `docs/home/configuration.md` | TOML 配置 schema |
| `docs/getting-started.md` | 快速开始 |
