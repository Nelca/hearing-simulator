import { Redis } from "@upstash/redis";
import type { Store } from "./types.js";

export class RedisStore implements Store {
  readonly kind = "redis" as const;
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    // 値はこちらでJSON文字列にして渡すので、SDKの自動変換は切る / We serialize values ourselves, so disable the SDK's auto-deserialization
    this.redis = new Redis({ url, token, automaticDeserialization: false });
  }

  async get(key: string): Promise<string | null> {
    return (await this.redis.get<string>(key)) ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) await this.redis.set(key, value);
    else await this.redis.set(key, value, { ex: ttlSeconds });
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const next = await this.redis.incrby(key, amount);
    if (ttlSeconds !== undefined) await this.redis.expire(key, ttlSeconds);
    return next;
  }

  async sadd(key: string, member: string, ttlSeconds?: number): Promise<void> {
    await this.redis.sadd(key, member);
    if (ttlSeconds !== undefined) await this.redis.expire(key, ttlSeconds);
  }

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  async rpush(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.redis.rpush(key, value);
    if (ttlSeconds !== undefined) await this.redis.expire(key, ttlSeconds);
  }

  async lrange(key: string): Promise<string[]> {
    return this.redis.lrange<string>(key, 0, -1);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, value, { nx: true, ex: ttlSeconds });
    return result === "OK";
  }
}
