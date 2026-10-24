import { ConfigError } from "../config.js";
import { MemoryStore } from "./memory.js";
import { RedisStore } from "./redis.js";
import type { Store } from "./types.js";

export type { Store } from "./types.js";
export { MemoryStore } from "./memory.js";

type Env = Record<string, string | undefined>;

export function createStore(env: Env = process.env): Store {
  // Vercel Marketplace の Upstash は KV_REST_API_* という名前でも環境変数を入れる
  // The Upstash integration on Vercel Marketplace may inject KV_REST_API_* instead of UPSTASH_REDIS_REST_*
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();

  if (url && token) return new RedisStore(url, token);

  // Vercel ではメモリが共有されず会話が途切れるので、Redis が無いまま動かさない
  // On Vercel memory is not shared between invocations, so refuse to run without Redis
  if (env.VERCEL) {
    throw new ConfigError([
      "Redis is required on Vercel: connect Upstash Redis (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)",
    ]);
  }
  return new MemoryStore();
}
