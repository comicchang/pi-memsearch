// pi-memsearch internal types

/**
 * 作用域定义：指定记忆在哪个 collection 中，以及可选的过滤标签。
 */
export interface BankScope {
    collectionName: string;
    tags?: string[];
}

/**
 * memsearch CLI 返回的搜索结果条目。
 */
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

// --- 以下类型使用 any 占位，待对应文件实现后自然连接 ---

// 来自 src/config.ts
export interface MemsearchConfig {
    // TODO: 待 config.ts 实现后填充
    [key: string]: any;
}

// 来自 src/client.ts
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MemsearchClient {
    // TODO: 待 client.ts 实现后填充
}

/**
 * MemsearchSessionState 构造选项。
 * session 字段为 oh-my-pi AgentSession 占位，pi-memsearch 无法直接导入该类型。
 */
export interface MemsearchSessionStateOptions {
    sessionId: string;
    config: MemsearchConfig;
    client: MemsearchClient;
    bankScope: BankScope;
    session: any;
    taskDepth: number;
}
