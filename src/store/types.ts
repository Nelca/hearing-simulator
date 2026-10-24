// 会話・上限・ログの置き場。Vercel はリクエストごとに別の環境で動くので、メモリでは共有できない
// Where conversations, counters and logs live. Vercel runs each request in a possibly different instance, so memory alone cannot be shared.
export interface Store {
  readonly kind: "memory" | "redis";
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number>;
  sadd(key: string, member: string, ttlSeconds?: number): Promise<void>;
  smembers(key: string): Promise<string[]>;
  rpush(key: string, value: string, ttlSeconds?: number): Promise<void>;
  lrange(key: string): Promise<string[]>;
  /** キーが無いときだけ書き込む。書き込めたら true / Writes only if the key is absent; returns true when written */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}
