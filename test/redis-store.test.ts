import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.js";
import { StoreLogSink } from "../src/logs.js";
import { RedisStore } from "../src/store/redis.js";
import { installFakeUpstash } from "./fake-upstash.js";
import { createStore, MemoryStore } from "../src/store/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("RedisStore（Vercelで使う保存先）", () => {
  it("文字列・カウンタ・集合・リスト・排他の鍵が期待どおり動く / strings, counters, sets, lists and locks behave", async () => {
    const fake = installFakeUpstash();
    const store = new RedisStore("https://fake.upstash.io", "token");

    await store.set("k", JSON.stringify({ a: "日本語" }), 60);
    expect(await store.get("k")).toBe('{"a":"日本語"}');
    expect(fake.ttls.get("k")).toBe(60);
    expect(await store.get("missing")).toBeNull();

    expect(await store.incrBy("n", 5, 30)).toBe(5);
    expect(await store.incrBy("n", 2, 30)).toBe(7);

    await store.sadd("s", "a|b", 30);
    await store.sadd("s", "c|d", 30);
    expect((await store.smembers("s")).sort()).toEqual(["a|b", "c|d"]);

    await store.rpush("l", "1行目", 30);
    await store.rpush("l", "2行目", 30);
    expect(await store.lrange("l")).toEqual(["1行目", "2行目"]);

    expect(await store.setIfAbsent("lock", "1", 10)).toBe(true);
    expect(await store.setIfAbsent("lock", "1", 10)).toBe(false);
    await store.del("lock");
    expect(await store.setIfAbsent("lock", "1", 10)).toBe(true);
  });

  it("JSON文字列は自動変換されずそのまま往復する / JSON strings round-trip untouched (no auto-deserialization)", async () => {
    installFakeUpstash();
    const store = new RedisStore("https://fake.upstash.io", "token");
    const value = JSON.stringify([{ role: "user", text: "こんにちは" }]);
    await store.set("conv", value);
    expect(await store.get("conv")).toBe(value);
  });

  it("ログは Redis のリストに残り、時刻順に取り出せる / logs go to Redis lists and are read back in time order", async () => {
    installFakeUpstash();
    const logs = new StoreLogSink(new RedisStore("https://fake.upstash.io", "token"), 3600);
    const base = { participantId: "p1", name: "田中", personaId: "b-company", type: "message" as const };
    await logs.append("2026-10-24", { ...base, ts: "2026-10-24T01:00:02Z", role: "assistant", text: "返答" });
    await logs.append("2026-10-24", { ...base, ts: "2026-10-24T01:00:01Z", role: "user", text: "質問" });
    await logs.append("2026-10-24", { ...base, ts: "2026-10-24T01:00:03Z", name: "../etc/passwd", role: "user", text: "別の人" });

    const lines = (await logs.readDay("2026-10-24")).trim().split("\n").map((l) => JSON.parse(l) as { text: string });
    expect(lines.map((l) => l.text)).toEqual(["質問", "返答", "別の人"]);
    expect(await logs.readDay("2026-10-25")).toBe("");
  });
});

describe("createStore", () => {
  it("UPSTASH_* でも KV_* でも Redis を使う / uses Redis with either env var naming", () => {
    expect(createStore({ UPSTASH_REDIS_REST_URL: "https://fake.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("redis");
    expect(createStore({ KV_REST_API_URL: "https://fake.upstash.io", KV_REST_API_TOKEN: "t" }).kind).toBe("redis");
  });

  it("ローカルではメモリ、Vercelで Redis が無ければ起動を止める / memory locally; refuses to run on Vercel without Redis", () => {
    expect(createStore({}).kind).toBe("memory");
    expect(() => createStore({ VERCEL: "1" })).toThrow(ConfigError);
  });
});

describe("MemoryStore", () => {
  it("期限が来たら消える / expires entries", async () => {
    let now = 1_000;
    const store = new MemoryStore(() => now);
    await store.set("k", "v", 10);
    expect(await store.get("k")).toBe("v");
    now += 11_000;
    expect(await store.get("k")).toBeNull();
    expect(await store.setIfAbsent("k", "again", 10)).toBe(true);
  });
});
