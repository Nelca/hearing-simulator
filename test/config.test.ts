import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { estimateCostUsd } from "../src/pricing.js";
import { listPersonas } from "../src/personas.js";
import { safeFileName } from "../src/logs.js";

const valid = { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-x", ACCESS_CODE: "handson", ADMIN_CODE: "admin-12345" };

const problemsOf = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    return error instanceof ConfigError ? error.problems : [String(error)];
  }
};

describe("環境変数 / configuration", () => {
  it("必須項目だけで動き、既定値が入る / works with required vars and applies defaults", () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      maxTurns: 40,
      dailyTokenLimit: 3_000_000,
      logDir: "./logs",
      timeZone: "Asia/Tokyo",
      fallbackEnabled: true,
    });
  });

  it("OpenAI では既定モデルと別のキーを使う / OpenAI uses its own key and default model", () => {
    const config = loadConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-x", ACCESS_CODE: "handson", ADMIN_CODE: "admin-12345", AI_MODEL: "gpt-6-luna" });
    expect(config).toMatchObject({ provider: "openai", model: "gpt-6-luna", apiKey: "sk-x" });
    expect(problemsOf({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-x", ACCESS_CODE: "handson", ADMIN_CODE: "admin-12345" })).toContain(
      "OPENAI_API_KEY is required when AI_PROVIDER=openai",
    );
  });

  it("足りない・不正な値を、すべてまとめて報告する / reports every problem at once", () => {
    expect(problemsOf({})).toEqual(
      expect.arrayContaining([
        "AI_PROVIDER must be 'anthropic' or 'openai'",
        "ACCESS_CODE is required (4+ characters)",
        "ADMIN_CODE is required (8+ characters)",
      ]),
    );
    expect(problemsOf({ ...valid, ADMIN_CODE: valid.ACCESS_CODE.padEnd(8, "x"), ACCESS_CODE: valid.ACCESS_CODE.padEnd(8, "x") })).toContain(
      "ADMIN_CODE must differ from ACCESS_CODE",
    );
    expect(problemsOf({ ...valid, MAX_TURNS_PER_PERSONA: "0" })).toContain("MAX_TURNS_PER_PERSONA must be a positive integer");
    expect(problemsOf({ ...valid, DAILY_TOKEN_LIMIT: "abc" })).toContain("DAILY_TOKEN_LIMIT must be a positive integer");
    expect(problemsOf({ ...valid, APP_TIMEZONE: "Mars/Olympus" })).toContain("APP_TIMEZONE is not a valid IANA time zone");
  });

  it("エラー文に秘密の値を含めない / error messages never contain secret values", () => {
    const text = problemsOf({ ...valid, ANTHROPIC_API_KEY: "", ADMIN_CODE: "short" }).join(" ");
    expect(text).not.toContain("short");
  });

  it("mock は本番（NODE_ENV=production）では使えない / mock is refused in production", () => {
    expect(problemsOf({ ...valid, AI_PROVIDER: "mock", NODE_ENV: "production" })).toContain("AI_PROVIDER=mock is not allowed when NODE_ENV=production");
    expect(loadConfig({ ...valid, AI_PROVIDER: "mock" }).provider).toBe("mock");
  });

  it("AI_FALLBACK=off でフォールバックを切れる / AI_FALLBACK=off disables fallbacks", () => {
    expect(loadConfig({ ...valid, AI_FALLBACK: "off" }).fallbackEnabled).toBe(false);
  });
});

describe("概算金額 / cost estimate", () => {
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };

  it("Opus 5.5 の単価（入力$4・出力$20・キャッシュ読み$0.2）/ Opus 5.5 list prices", () => {
    expect(estimateCostUsd(usage, { provider: "anthropic", model: "claude-opus-5-5", priceOverride: undefined })).toBeCloseTo(4 + 0.2 + 20);
  });

  it("未知のモデルは null、上書きがあればそれを使う / unknown model is null; an override wins", () => {
    expect(estimateCostUsd(usage, { provider: "openai", model: "future-model", priceOverride: undefined })).toBeNull();
    expect(
      estimateCostUsd(usage, { provider: "openai", model: "future-model", priceOverride: { inputPerMTok: 1, outputPerMTok: 2 } }),
    ).toBeCloseTo(1 + 1 + 2);
  });
});

describe("人物設定 / personas", () => {
  it("生成物が personas/*.md と一致している（直したら `pnpm personas`）/ generated file matches the markdown sources", () => {
    expect(() => execFileSync("node", ["scripts/build-personas.mjs", "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("「---」より下だけがシステムプロンプトになる / only the part below the --- line is the system prompt", () => {
    const [yamada, sato] = listPersonas();
    expect(yamada?.systemPrompt.startsWith("あなたは、架空の製造業「B社」")).toBe(true);
    expect(sato?.systemPrompt.startsWith("あなたは、アスエネ")).toBe(true);
    for (const persona of listPersonas()) {
      expect(persona.systemPrompt).not.toContain("このファイルの");
      expect(persona.systemPrompt).not.toMatch(/^---$/m);
    }
  });
});

describe("ログのファイル名 / log file names", () => {
  it("パスの区切りやドットを残さない / strips separators and dots", () => {
    expect(safeFileName("田中")).toBe("田中");
    expect(safeFileName("../../etc/passwd")).toBe("etc_passwd");
    expect(safeFileName("a/b\\c:d")).toBe("a_b_c_d");
    expect(safeFileName("..")).toBe("anonymous");
    expect(safeFileName("あ".repeat(50))).toHaveLength(30);
  });
});
