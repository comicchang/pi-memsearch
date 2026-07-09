# pi-memsearch

[![license](https://img.shields.io/badge/license-MIT-yellow)](https://github.com/comicchang/pi-memsearch/blob/master/LICENSE)
[![test](https://img.shields.io/badge/test-67%20passed-brightgreen)](.)

> oh-my-pi memory backend: Markdown-based hybrid semantic search via zilliztech/memsearch + Milvus Lite

**GitHub**: [comicchang/pi-memsearch](https://github.com/comicchang/pi-memsearch)

---

pi-memsearch 是 oh-my-pi 的 memory-backend 插件，通过 ExtensionAPI 生命周期钩子接入，不修改 oh-my-pi 核心代码。

提供 `MemoryBackend` 接口实现（`backend.ts`）和 ExtensionAPI 插件入口（`plugin.ts`）两种接入方式。

### 文件职责

| 文件 | 职责 |
|------|------|
| `plugin.ts` | ExtensionAPI 插件入口，注册 4 个工具 + 生命周期钩子 |
| `types.ts` | BankScope / SearchResult / MemsearchSessionStateOptions 类型 |
| `config.ts` | MemsearchConfig（15 字段） + loadMemsearchConfig() |
| `client.ts` | MemsearchClient 类，封装 memsearch CLI（search/index/stats/reset/expand） |
| `state.ts` | MemsearchSessionState 类，Symbol-keyed 存储到 AgentSession |
| `recall.ts` | autoRecall / autoRetain / computeBankScope / formatMemories |
| `backend.ts` | memsearchBackend 对象，实现 MemoryBackend 全部方法 |
| `index.ts` | barrel export，导出所有公开 API |

### Symbol-keyed 存储

Session 状态通过 Symbol("memsearch.sessionState") 挂载到 oh-my-pi AgentSession 对象上（Mnemopi 风格）。
外部函数 `getMemsearchSessionState(session)` / `setMemsearchSessionState(session, state)` 进行操作。
子代理通过 aliasOf 复用父 state。

---

## 安装

```bash
# 通过 oh-my-pi 安装（推荐）
pi install git:github.com/comicchang/pi-memsearch

# 手动安装
git clone https://github.com/comicchang/pi-memsearch.git
cp -r pi-memsearch ~/.omp/extensions/pi-memsearch
cd ~/.omp/extensions/pi-memsearch && npm install
```


### 前置条件

- **Python 3.10+** — memsearch CLI 运行环境
- **Node.js 18+** — oh-my-pi / pi-memsearch 运行
- **[oh-my-pi](https://github.com/can1357/oh-my-pi)** — pi-memsearch 作为其 memory-backend 插件运行

### 安装 memsearch CLI

memsearch 是 zilliztech 的 Python 包，提供语义搜索命令行工具。

```bash
# 推荐：ONNX 嵌入（纯 CPU，无需 API key）
pip install "memsearch[onnx]"

# 其他嵌入方案
pip install "memsearch[openai]"    # OpenAI 嵌入
pip install "memsearch[ollama]"    # Ollama 本地模型
```

验证：

```bash
memsearch --version   # 应输出 0.4.6+
```

### 启用

安装后在 oh-my-pi 的 omp.config.yml 中启用：

```yaml
# ~/.omp/agent/config.yml 或项目 omp.config.yml
memory:
  backend: memsearch

memsearch:
  embeddingProvider: onnx
  # ... 其余配置见下方 [配置](#配置) 章节
```

插件启动时自动检测 `memory.backend` 配置，若非 `"memsearch"` 则跳过初始化。


### 故障排查

| 现象 | 解决 |
|------|------|
| `memsearch: command not found` | `pip install "memsearch[onnx]"`，确认 `which memsearch` |
| `spawn memsearch ENOENT` | pipx/uvx 安装的需确认 PATH |
| `no such collection` | 首次 `start()` 自动 index，或手动 `memsearch index .memsearch/memory/` |
| 搜索无结果 | 检查 `.memsearch/memory/` 是否有 markdown 文件 |
| `database is locked` 偶发 | 多 session 并发时正常，插件自动重试（最多 3 次） |
| 写锁等待超时 | 检查 `~/.memsearch/.write.lock` 是否残留，手动删除即可 |
| 首次搜索很慢 | 正常：uvx 冷启动 + onnxruntime 加载约 30-60s，session_start 已自动预热 |
---
## 配置

安装 memsearch CLI 和 pi-memsearch 后，在 oh-my-pi 的 omp.config.yml 中启用本 backend：

```yaml
memory:
  backend: memsearch

memsearch:
  embeddingProvider: onnx               # onnx | openai | ollama | local | google | voyage | jina | mistral
  embeddingModel: ""                    # 空 = 提供者默认（onnx: bge-m3-int8）
  embeddingApiKey: ""                   # 支持 env:VAR_NAME 语法
  milvusUri: "~/.memsearch/milvus.db"   # Milvus Lite 本地路径
  collection: "memsearch_chunks"        # Milvus 集合名
  maxChunkSize: 1500                    # 分块最大字符数
  overlapLines: 2                       # 分块重叠行数
  scoping: per-project-tagged           # global | per-project | per-project-tagged
  bankName: ""                          # 空 = 自动从项目目录名生成
  autoRecall: true                      # agent_start 时自动 recall
  autoRetain: true                      # agent_end 时自动 retain
  retainEveryNTurns: 4                  # 每 N 个 turn 触发一次 retain
  recallLimit: 8                        # 每次 recall 返回的最大结果数
  recallContextTurns: 5                 # recall 查询使用的最近 turn 数
  memoryDir: ".memsearch/memory"        # Markdown 记忆文件目录
  debug: false                          # 调试模式
```

---

## 文件布局

```
项目/
├── omp.config.yml              # memory.backend: memsearch
├── .memsearch.toml             # memsearch CLI 配置（pi-memsearch 自动生成）
└── .memsearch/
    ├── milvus.db               # Milvus Lite 向量索引
    └── memory/
        ├── 2026-06-01.md       # 每日记忆文件（autoRetain 自动写入）
        ├── 2026-05-30.md
        └── ...
```

---

## 工作原理

### 自动 Recall（before_agent_start）

每次 agent 启动时，pi-memsearch 自动搜索记忆库，将相关记忆注入 system prompt：

1. 提取最近 `recallContextTurns` 轮对话内容
2. 拼接为搜索 query → `memsearch search`
3. 将搜索结果格式化为 `<memories>` block
4. 通过 `before_agent_start` 钩子注入到 system prompt

### 自动 Retain（agent_end）

每 `retainEveryNTurns` 轮对话结束时，pi-memsearch 自动保存记忆：

1. 提取对话文本 → 生成 markdown 条目
2. 写入 `.memsearch/memory/YYYY-MM-DD.md`
3. 触发 `memsearch index` 重建向量索引

### 记忆注入格式

LLM 看到的 `<memories>` block 格式：

```xml
<memories>
<memory source="/path/to/2026-06-01.md" score="0.95" chunk_hash="abc123">
... 记忆内容 ...
</memory>
</memories>
```

### 作用域（Scoping）

| scoping | collection 行为 | 适用场景 |
|---------|----------------|---------|
| `global` | 所有项目共享 `memsearch_chunks` | 单项目 |
| `per-project` | 独立 collection `memsearch_chunks_{项目名}` | 多项目隔离 |
| `per-project-tagged` | 同一 collection + `project:xxx` tag 过滤 | 多项目共享索引 |

### 并发安全

多 OMP session 同时启动时共享 `~/.memsearch/milvus.db`（MilvusLite 底层 SQLite），可能触发 `database is locked`。
插件采用两层防御：

1. **外部写锁**（P0）：`index`/`reset` 操作前获取 `~/.memsearch/.write.lock` 排他锁，预防写-写冲突。读操作（search/stats/expand）不加锁，完全并发。
2. **指数退避重试**（P1）：所有操作在检测到 SQLite 锁错误时自动重试（读 3 次/1s 基础延迟，写 5 次/2s）。
3. **启动预热**：`session_start` 时 fire-and-forget 触发 `memsearch --version`，预加载 uvx 缓存 + onnxruntime，减少首次搜索冷启动感知。

---

## 工具

pi-memsearch 通过 ExtensionAPI 注册以下工具，供 Agent 在对话中使用：

| 工具 | 说明 |
|------|------|
| `memory_search` | 语义检索 persist 记忆库（BM25 + dense + RRF 混合搜索） |
| `memory_get` | 根据 chunk_hash 展开完整原文段落 |
| `memory_stats` | 显示记忆索引入统计（chunk 数量、存储路径等） |
| `memory_transcript` | 读取指定 session 的原始对话记录（OpenCode SQLite） |

---

## API

导出自 `index.ts`：

```typescript
import {
  // Backend 对象
  memsearchBackend,           // MemoryBackend 实现

  // 配置
  loadMemsearchConfig,        // (settings: { get(key): string }) => MemsearchConfig
  MemsearchConfig,            // 配置接口类型
  MemsearchScoping,           // scoping 枚举类型
  // CLI 客户端
  MemsearchClient,            // new MemsearchClient(config, collectionName, memoryPath)
  warmupMemsearch,            // () => void — fire-and-forget 预热 uvx + onnxruntime


  // Recall / Retain
  computeBankScope,           // (config, cwd) => BankScope
  autoRecall,                 // (state, recentTurns?) => Promise<SearchResult[]>
  autoRetain,                 // (state) => Promise<void>
  formatMemories,             // (results: SearchResult[]) => string
  composeRecallQuery,         // (recentTurns: string[]) => string

  // Session State
  MemsearchSessionState,      // 类
  getMemsearchSessionState,   // (session: any) => MemsearchSessionState | undefined
  setMemsearchSessionState,   // (session: any, state?) => previous

  // 内部类型
  BankScope,
  SearchResult,
  MemsearchSessionStateOptions,
} from "pi-memsearch";
```

---

## 约束
- 本项目**不修改** oh-my-pi 仓库文件 — 通过 ExtensionAPI 插件方式接入（无需修改类型联合或 Backend 路由）
- 不实现 diagnose() 方法
- memory_transcript 读取 OpenCode SQLite 数据库，不封装 `memsearch transcript` 命令
- 不封装 memsearch compact / watch 命令
- 不依赖 Docker / Redis / Zilliz Cloud

---

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 单元测试（无需 memsearch CLI）
npx vitest

# 集成测试（需 memsearch CLI）
RUN_MEMSEARCH_INTEGRATION=1 npx vitest run tests/integration.test.ts

# 完整验证
npm run build && npx vitest
```
