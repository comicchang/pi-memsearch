// tests/config.test.ts — MemsearchConfig TDD 测试套件

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, loadMemsearchConfig } from "../src/config";
import { MemsearchClient } from "../src/client";
import type { MemsearchConfig } from "../src/config";

/**
 * 模拟 oh-my-pi Settings 对象。
 * 只暴露 get(key: string) => string | undefined，不依赖 @oh-my-pi 包。
 */
function makeSettings(
  overrides: Record<string, string> = {},
): { get(key: string): string | undefined } {
  return { get: (key: string) => overrides[key] };
}

describe("loadMemsearchConfig", () => {
  // ── 场景1: 默认值 ──
  it("应该返回所有默认值（空 Settings）", () => {
    const config = loadMemsearchConfig(makeSettings());

    expect(config.embeddingProvider).toBe("onnx");
    expect(config.milvusUri).toBe("~/.memsearch/milvus.db");
    expect(config.collection).toBe("memsearch_chunks");
    expect(config.retainEveryNTurns).toBe(4);
    expect(config.recallLimit).toBe(8);
    expect(config.memoryDir).toBe(".memsearch/memory");
    expect(config.autoRecall).toBe(true);
    expect(config.autoRetain).toBe(true);
    expect(config.debug).toBe(false);
  });

  // ── 场景2: Settings 覆盖 ──
  it("应该用 Settings 值覆盖默认值", () => {
    const config = loadMemsearchConfig(
      makeSettings({
        "memsearch.retainEveryNTurns": "10",
        "memsearch.recallLimit": "20",
        "memsearch.recallContextTurns": "3",
      }),
    );

    expect(config.retainEveryNTurns).toBe(10);
    expect(config.recallLimit).toBe(20);
    expect(config.recallContextTurns).toBe(3);
  });

  // ── 场景3: 类型转换 string → number ──
  it("应该将数字字段从 string 转换为 number", () => {
    const config = loadMemsearchConfig(
      makeSettings({
        "memsearch.maxChunkSize": "2000",
        "memsearch.overlapLines": "5",
        "memsearch.retainEveryNTurns": "3",
        "memsearch.recallLimit": "15",
        "memsearch.recallContextTurns": "7",
      }),
    );

    expect(config.maxChunkSize).toBe(2000);
    expect(config.overlapLines).toBe(5);
    expect(config.retainEveryNTurns).toBe(3);
    expect(config.recallLimit).toBe(15);
    expect(config.recallContextTurns).toBe(7);

    // 确保真是 number 类型
    expect(typeof config.maxChunkSize).toBe("number");
    expect(typeof config.overlapLines).toBe("number");
    expect(typeof config.retainEveryNTurns).toBe("number");
    expect(typeof config.recallLimit).toBe("number");
    expect(typeof config.recallContextTurns).toBe("number");
  });

  // ── 场景4: 边界校验 ──
  it("retainEveryNTurns 和 recallLimit 最小值应为 1", () => {
    const config = loadMemsearchConfig(
      makeSettings({
        "memsearch.retainEveryNTurns": "0",
        "memsearch.recallLimit": "-5",
      }),
    );

    expect(config.retainEveryNTurns).toBe(1);
    expect(config.recallLimit).toBe(1);
  });

  // ── 场景5: scoping 枚举校验 ──
  it("scoping 枚举值有效时通过，无效时 fallback 到 per-project-tagged", () => {
    const global_ = loadMemsearchConfig(
      makeSettings({ "memsearch.scoping": "global" }),
    );
    expect(global_.scoping).toBe("global");

    const perProject = loadMemsearchConfig(
      makeSettings({ "memsearch.scoping": "per-project" }),
    );
    expect(perProject.scoping).toBe("per-project");

    const perProjectTagged = loadMemsearchConfig(
      makeSettings({ "memsearch.scoping": "per-project-tagged" }),
    );
    expect(perProjectTagged.scoping).toBe("per-project-tagged");

    // 无效值 → fallback
    const invalid = loadMemsearchConfig(
      makeSettings({ "memsearch.scoping": "invalid-value" }),
    );
    expect(invalid.scoping).toBe("per-project-tagged");

    // 空字符串 → fallback
    const empty = loadMemsearchConfig(
      makeSettings({ "memsearch.scoping": "" }),
    );
    expect(empty.scoping).toBe("per-project-tagged");
  });
});

describe("~/ 路径展开", () => {
  it("memoryDir 配置 ~/ 路径载入后归一为 home 绝对路径", () => {
    const config = loadMemsearchConfig(
      makeSettings({ "memsearch.memoryDir": "~/.memsearch/memory" }),
    );
    expect(config.memoryDir).toBe(join(homedir(), ".memsearch/memory"));
  });

  it("相对路径与绝对路径 memoryDir 保持原样（默认 per-project 语义不变）", () => {
    const relative = loadMemsearchConfig(
      makeSettings({ "memsearch.memoryDir": "custom/memories" }),
    );
    expect(relative.memoryDir).toBe("custom/memories");

    const absolute = loadMemsearchConfig(
      makeSettings({ "memsearch.memoryDir": "/var/memsearch/memory" }),
    );
    expect(absolute.memoryDir).toBe("/var/memsearch/memory");
  });

  it("expandHome 与 milvusUri 既有展开语义一致", () => {
    expect(expandHome("~/.memsearch/milvus.db")).toBe(
      join(homedir(), ".memsearch/milvus.db"),
    );
    expect(expandHome(".memsearch/memory")).toBe(".memsearch/memory");
    expect(expandHome("/abs/path")).toBe("/abs/path");
    // 仅 "~/" 前缀触发展开；"~user/..." 与 "$HOME" 不展开
    expect(expandHome("~other/x")).toBe("~other/x");
    expect(expandHome("$HOME/x")).toBe("$HOME/x");
  });

  it("MemsearchClient 构造器归一 memoryPath 与 milvusUri", () => {
    // 构造器不调用 execFile，静态导入安全；private 字段经结构化断言读取
    const client = new MemsearchClient(
      loadMemsearchConfig(
        makeSettings({
          "memsearch.milvusUri": "~/.memsearch/milvus.db",
          "memsearch.memoryDir": "~/.memsearch/memory",
        }),
      ),
      "memsearch_chunks",
      "~/.memsearch/memory",
    );
    const internals = client as unknown as {
      memoryPath: string;
      config: MemsearchConfig;
    };
    expect(internals.memoryPath).toBe(join(homedir(), ".memsearch/memory"));
    expect(internals.config.milvusUri).toBe(
      join(homedir(), ".memsearch/milvus.db"),
    );
  });
});
