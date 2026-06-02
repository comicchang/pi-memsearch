// src/client.ts — memsearch CLI 封装
//
// 封装 memsearch CLI 进程调用，提供搜索/索引/统计/重置功能。
// CLI 未安装时优雅降级，不抛异常。

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemsearchConfig } from "./config";
import type { SearchResult } from "./types";

/** memsearch search 超时（毫秒） */
const SEARCH_TIMEOUT_MS = 30_000;
/** memsearch index 超时（毫秒） */
const INDEX_TIMEOUT_MS = 120_000;

/** 判断 Error.code 是否为 "ENOENT"（CLI 未安装） */
function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * promisified execFile，支持超时自动 kill。
 * 回调风格的 execFile 不阻塞事件循环。
 */
function execFileAsync(
  file: string,
  args: string[],
  options: { timeout: number; encoding: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as string);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`memsearch 命令超时 (${options.timeout}ms)`));
    }, options.timeout);
    child.on("exit", () => clearTimeout(timer));
  });
}

/**
 * memsearch CLI 客户端。
 * 所有方法异步，不阻塞事件循环。
 */
export class MemsearchClient {
  private config: MemsearchConfig;
  private collectionName: string;
  private memoryPath: string;

  constructor(
    config: MemsearchConfig,
    collectionName: string,
    memoryPath: string,
  ) {
    this.config = config;
    this.collectionName = collectionName;
    this.memoryPath = memoryPath;
    // 展开 ~ 路径（Node.js 不会自动展开，CLI 也不会）
    if (this.config.milvusUri.startsWith("~/")) {
      this.config.milvusUri = join(homedir(), this.config.milvusUri.slice(2));
    }
  }

  // ── 公开方法 ──

  /** 语义搜索，返回匹配结果列表 */
  async search(query: string, topK: number): Promise<SearchResult[]> {
    try {
      const stdout = await execFileAsync(
        "memsearch",
        [
          "search",
          query,
          "--top-k",
          String(topK),
          "--json-output",
          ...this.buildBaseArgs(true),
        ],
        { timeout: SEARCH_TIMEOUT_MS, encoding: "utf8" },
      );
      return JSON.parse(stdout.trim()) as SearchResult[];
    } catch (err) {
      if (isENOENT(err)) {
        console.warn(
          "memsearch CLI 未安装。运行 pip install memsearch[onnx]",
        );
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return [];
    }
  }

  /** 索引 memoryPath 目录下的 markdown 文件，返回索引 chunk 数 */
  async index(force?: boolean): Promise<number> {
    try {
      const args: string[] = ["index", this.memoryPath, ...this.buildBaseArgs(true)];
      if (force) args.push("--force");
      const stdout = await execFileAsync("memsearch", args, {
        timeout: INDEX_TIMEOUT_MS,
        encoding: "utf8",
      });
      const match = /Indexed (\d+) chunks?/.exec(stdout);
      return match ? Number(match[1]) : 0;
    } catch (err) {
      if (isENOENT(err)) {
        console.warn(
          "memsearch CLI 未安装。运行 pip install memsearch[onnx]",
        );
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return 0;
    }
  }

  /** 查询索引统计，返回已索引 chunk 总数 */
  async stats(): Promise<number> {
    try {
      const stdout = await execFileAsync(
        "memsearch",
        ["stats", ...this.buildBaseArgs()],
        { timeout: SEARCH_TIMEOUT_MS, encoding: "utf8" },
      );
      const match = /Total indexed chunks: (\d+)/.exec(stdout);
      return match ? Number(match[1]) : 0;
    } catch (err) {
      if (isENOENT(err)) {
        console.warn(
          "memsearch CLI 未安装。运行 pip install memsearch[onnx]",
        );
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return 0;
    }
  }

  /** 重置索引（清空所有数据） */
  async reset(): Promise<void> {
    try {
      await execFileAsync(
        "memsearch",
        ["reset", "--yes", ...this.buildBaseArgs()],
        { timeout: SEARCH_TIMEOUT_MS, encoding: "utf8" },
      );
    } catch (err) {
      if (isENOENT(err)) {
        console.warn(
          "memsearch CLI 未安装。运行 pip install memsearch[onnx]",
        );
      } else {
        console.error("memsearch CLI 错误:", err);
      }
    }
  }

  /** 展开指定 chunk 的完整原文 */
  async expand(chunkHash: string): Promise<string> {
    try {
      return (await execFileAsync(
        "memsearch",
        ["expand", chunkHash, ...this.buildBaseArgs(true)],
        { timeout: SEARCH_TIMEOUT_MS, encoding: "utf8" },
      )).trim();
    } catch (err) {
      if (isENOENT(err)) {
        console.warn(
          "memsearch CLI 未安装。运行 pip install memsearch[onnx]",
        );
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return "";
    }
  }

  /** 确保项目根存在 .memsearch.toml 配置文件 */
  ensureConfig(): void {
    const toml = [
      `collection = "${this.collectionName}"`,
      `milvus_uri = "${this.config.milvusUri}"`,
      `provider = "${this.config.embeddingProvider}"`,
      this.config.embeddingModel
        ? `model = "${this.config.embeddingModel}"`
        : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");

    writeFileSync(".memsearch.toml", toml, "utf8");
  }

  // ── 内部 ──

  /** 构建 memsearch CLI 公共参数 */
  private buildBaseArgs(withProvider = false): string[] {
    const args: string[] = [
      "--collection",
      this.collectionName,
      "--milvus-uri",
      this.config.milvusUri,
    ];
    if (withProvider) {
      args.push("--provider", this.config.embeddingProvider);
      if (this.config.embeddingModel) {
        args.push("--model", this.config.embeddingModel);
      }
    }
    return args;
  }
}
