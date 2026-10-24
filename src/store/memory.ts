import type { Store } from "./types.js";

interface Entry {
  value: string | Set<string> | string[];
  expiresAt: number | undefined;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  private read(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private expiry(ttlSeconds: number | undefined): number | undefined {
    return ttlSeconds === undefined ? undefined : this.now() + ttlSeconds * 1000;
  }

  async get(key: string): Promise<string | null> {
    const value = this.read(key)?.value;
    return typeof value === "string" ? value : null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.expiry(ttlSeconds) });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const current = this.read(key);
    const next = (current && typeof current.value === "string" ? Number(current.value) : 0) + amount;
    this.entries.set(key, {
      value: String(next),
      expiresAt: ttlSeconds === undefined ? current?.expiresAt : this.expiry(ttlSeconds),
    });
    return next;
  }

  async sadd(key: string, member: string, ttlSeconds?: number): Promise<void> {
    const current = this.read(key);
    const set = current?.value instanceof Set ? current.value : new Set<string>();
    set.add(member);
    this.entries.set(key, { value: set, expiresAt: this.expiry(ttlSeconds) ?? current?.expiresAt });
  }

  async smembers(key: string): Promise<string[]> {
    const value = this.read(key)?.value;
    return value instanceof Set ? [...value] : [];
  }

  async rpush(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const current = this.read(key);
    const list = Array.isArray(current?.value) ? current.value : [];
    list.push(value);
    this.entries.set(key, { value: list, expiresAt: this.expiry(ttlSeconds) ?? current?.expiresAt });
  }

  async lrange(key: string): Promise<string[]> {
    const value = this.read(key)?.value;
    return Array.isArray(value) ? [...value] : [];
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.read(key)) return false;
    this.entries.set(key, { value, expiresAt: this.expiry(ttlSeconds) });
    return true;
  }
}
