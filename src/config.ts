export const MAX_MESSAGE_CHARS = 500;

export type ProviderName = "anthropic" | "openai" | "mock";

export interface Config {
  provider: ProviderName;
  model: string;
  apiKey: string | undefined;
  accessCode: string;
  adminCode: string;
  sessionSecret: string;
  maxTurns: number;
  dailyTokenLimit: number;
  logDir: string;
  dataTtlSeconds: number;
  timeZone: string;
  fallbackEnabled: boolean;
  priceOverride: { inputPerMTok: number; outputPerMTok: number } | undefined;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.1-sol",
  mock: "mock",
};

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  return value;
}

function positiveNumber(env: Env, name: string, problems: string[]): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    problems.push(`${name} must be a non-negative number`);
    return undefined;
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const providerRaw = env.AI_PROVIDER?.trim();
  let provider: ProviderName = "anthropic";
  if (providerRaw === "anthropic" || providerRaw === "openai" || providerRaw === "mock") {
    provider = providerRaw;
  } else {
    problems.push("AI_PROVIDER must be 'anthropic' or 'openai'");
  }
  // mock は動作確認用。本番で誤って使われないようにする / mock is for local checks only; never allow it in production
  if (provider === "mock" && env.NODE_ENV === "production") {
    problems.push("AI_PROVIDER=mock is not allowed when NODE_ENV=production");
  }

  let apiKey: string | undefined;
  if (provider === "anthropic") {
    apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) problems.push("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
  } else if (provider === "openai") {
    apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) problems.push("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }

  const accessCode = env.ACCESS_CODE?.trim() ?? "";
  const adminCode = env.ADMIN_CODE?.trim() ?? "";
  if (accessCode.length < 4) problems.push("ACCESS_CODE is required (4+ characters)");
  if (adminCode.length < 8) problems.push("ADMIN_CODE is required (8+ characters)");
  if (accessCode && accessCode === adminCode) {
    problems.push("ADMIN_CODE must differ from ACCESS_CODE");
  }

  const maxTurns = positiveInt(env, "MAX_TURNS_PER_PERSONA", 40, problems);
  const dailyTokenLimit = positiveInt(env, "DAILY_TOKEN_LIMIT", 3_000_000, problems);
  const ttlDays = positiveInt(env, "DATA_TTL_DAYS", 14, problems);

  const inputPrice = positiveNumber(env, "PRICE_INPUT_PER_MTOK", problems);
  const outputPrice = positiveNumber(env, "PRICE_OUTPUT_PER_MTOK", problems);

  const timeZone = env.APP_TIMEZONE?.trim() || "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    problems.push("APP_TIMEZONE is not a valid IANA time zone");
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    provider,
    model: env.AI_MODEL?.trim() || DEFAULT_MODELS[provider],
    apiKey,
    accessCode,
    adminCode,
    sessionSecret: env.SESSION_SECRET?.trim() ?? "",
    maxTurns,
    dailyTokenLimit,
    logDir: env.LOG_DIR?.trim() || "./logs",
    dataTtlSeconds: ttlDays * 24 * 60 * 60,
    timeZone,
    fallbackEnabled: env.AI_FALLBACK?.trim().toLowerCase() !== "off",
    priceOverride:
      inputPrice !== undefined && outputPrice !== undefined
        ? { inputPerMTok: inputPrice, outputPerMTok: outputPrice }
        : undefined,
  };
}
