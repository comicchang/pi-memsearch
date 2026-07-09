// src/client.ts — memsearch CLI 封装
//
// 封装 memsearch CLI 进程调用，提供搜索/索引/统计/重置功能。
// CLI 未安装时优雅降级，不抛异常。
//
// 并发安全策略（两层防御）：
// - P0 外部写锁：index/reset 获取 ~/.memsearch/.write.lock 排他锁，预防写-写冲突
// - P1 重试安全网：所有操作在 SQLite 锁错误时指数退避重试（读操作也会偶遇 SQLITE_BUSY

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { MemsearchConfig } from "./config";
import type { SearchResult } from "./types";

// ── 超时与重试参数 ──

const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 120_000;
const READ_MAX_RETRIES = 3;
const WRITE_MAX_RETRIES = 5;
const READ_RETRY_BASE_MS = 1_000;
const WRITE_RETRY_BASE_MS = 2_000;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_MAX_WAIT_MS = 30_000;

// ── 错误类型 ──

interface ErrorWithStderr extends Error {
  stderr?: string;
}

function isLockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stderr = (err as ErrorWithStderr).stderr ?? "";
  const msg = (err.message + " " + stderr).toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("sqlite_busy") ||
    msg.includes("database is busy") ||
    (msg.includes("lock") && msg.includes("milvus"))
  );
}

// ── 外部写锁（P0）──

function getWriteLockPath(milvusUri: string): string {
  return join(dirname(milvusUri), ".write.lock");
}

async function acquireWriteLock(lockPath: string): Promise<void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, LOCK_POLL_INTERVAL_MS);
        await promise;
        continue;
      }
      throw err;
    }
  }
  console.warn("memsearch 写锁等待超时，清理残留锁文件");
  try { unlinkSync(lockPath); } catch { /* ignore */ }
  closeSync(openSync(lockPath, "wx"));
}

function releaseWriteLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

// ── execFile 封装 ──

function execFileAsync(
  file: string,
  args: string[],
  options: { timeout: number; encoding: string },
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child: ChildProcess = execFile(file, args, options, (err, stdout, stderr) => {
    if (err) {
      const enriched: ErrorWithStderr = err;
      enriched.stderr = typeof stderr === "string" ? stderr : "";
      reject(enriched);
    } else {
      resolve(stdout as string);
    }
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`memsearch 命令超时 (${options.timeout}ms)`));
  }, options.timeout);
  child.on("exit", () => clearTimeout(timer));
  return promise;
}

async function execFileWithRetry(
  file: string,
  args: string[],
  options: { timeout: number; encoding: string },
  isWrite = false,
): Promise<string> {
  const maxRetries = isWrite ? WRITE_MAX_RETRIES : READ_MAX_RETRIES;
  const baseMs = isWrite ? WRITE_RETRY_BASE_MS : READ_RETRY_BASE_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await execFileAsync(file, args, options);
    } catch (err) {
      if (attempt < maxRetries && isLockError(err)) {
        const delay = baseMs * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(
          `memsearch 锁冲突，第 ${attempt + 1} 次重试（${Math.round(delay)}ms 后）`,
        );
        const { promise: waitDone, resolve: waitResolve } =
          Promise.withResolvers<void>();
        setTimeout(waitResolve, delay);
        await waitDone;
        continue;
      }
      throw err;
    }
  }
}

// ── 预热（P1）──

/** fire-and-forget 预热：触发 uvx 缓存填充 + Python + onnxruntime 加载 */
export function warmupMemsearch(): void {
  try {
    execFile("memsearch", ["--version"], { timeout: 30_000 }, () => { /* ignore */ });
  } catch { /* ENOENT = CLI 未安装 */ }
}

// ── 客户端 ──

export class MemsearchClient {
  private config: MemsearchConfig;
  private collectionName: string;
  private memoryPath: string;
  private writeLockPath: string;

  constructor(
    config: MemsearchConfig,
    collectionName: string,
    memoryPath: string,
  ) {
    this.config = config;
    this.collectionName = collectionName;
    this.memoryPath = memoryPath;
    if (this.config.milvusUri.startsWith("~/")) {
      this.config.milvusUri = join(homedir(), this.config.milvusUri.slice(2));
    }
    this.writeLockPath = getWriteLockPath(this.config.milvusUri);
  }

  // ── 读操作（不获取写锁，自由并发）──

  async search(query: string, topK: number): Promise<SearchResult[]> {
    try {
      const stdout = await execFileWithRetry(
        "memsearch",
        ["search", query, "--top-k", String(topK), "--json-output", ...this.buildBaseArgs(true)],
        { timeout: READ_TIMEOUT_MS, encoding: "utf8" },
      );
      return JSON.parse(stdout.trim()) as SearchResult[];
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("memsearch CLI 未安装。运行 pip install memsearch[onnx]");
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return [];
    }
  }

  async stats(): Promise<number> {
    try {
      const stdout = await execFileWithRetry(
        "memsearch", ["stats", ...this.buildBaseArgs()],
        { timeout: READ_TIMEOUT_MS, encoding: "utf8" },
      );
      const match = /Total indexed chunks: (\d+)/.exec(stdout);
      return match ? Number(match[1]) : 0;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("memsearch CLI 未安装。运行 pip install memsearch[onnx]");
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return 0;
    }
  }

  async expand(chunkHash: string): Promise<string> {
    try {
      return (
        await execFileWithRetry(
          "memsearch", ["expand", chunkHash, ...this.buildBaseArgs(true)],
          { timeout: READ_TIMEOUT_MS, encoding: "utf8" },
        )
      ).trim();
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("memsearch CLI 未安装。运行 pip install memsearch[onnx]");
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return "";
    }
  }

  // ── 写操作（获取外部写锁 + retry 安全网）──

  async index(force?: boolean): Promise<number> {
    await acquireWriteLock(this.writeLockPath);
    try {
      const args: string[] = ["index", this.memoryPath, ...this.buildBaseArgs(true)];
      if (force) args.push("--force");
      const stdout = await execFileWithRetry(
        "memsearch", args,
        { timeout: WRITE_TIMEOUT_MS, encoding: "utf8" },
        true,
      );
      const match = /Indexed (\d+) chunks?/.exec(stdout);
      return match ? Number(match[1]) : 0;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("memsearch CLI 未安装。运行 pip install memsearch[onnx]");
      } else {
        console.error("memsearch CLI 错误:", err);
      }
      return 0;
    } finally {
      releaseWriteLock(this.writeLockPath);
    }
  }

  async reset(): Promise<void> {
    await acquireWriteLock(this.writeLockPath);
    try {
      await execFileWithRetry(
        "memsearch", ["reset", "--yes", ...this.buildBaseArgs()],
        { timeout: WRITE_TIMEOUT_MS, encoding: "utf8" },
        true,
      );
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("memsearch CLI 未安装。运行 pip install memsearch[onnx]");
      } else {
        console.error("memsearch CLI 错误:", err);
      }
    } finally {
      releaseWriteLock(this.writeLockPath);
    }
  }

  // ── 配置 ──

  ensureConfig(): void {
    const toml = [
      `collection = "${this.collectionName}"`,
      `milvus_uri = "${this.config.milvusUri}"`,
      `provider = "${this.config.embeddingProvider}"`,
      this.config.embeddingModel ? `model = "${this.config.embeddingModel}"` : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");
    writeFileSync(".memsearch.toml", toml, "utf8");
  }

  private buildBaseArgs(withProvider = false): string[] {
    const args: string[] = [
      "--collection", this.collectionName,
      "--milvus-uri", this.config.milvusUri,
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
