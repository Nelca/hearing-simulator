import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeUpstash } from "./fake-upstash.js";
import { parseSse } from "./harness.js";

// Vercel では、リクエストごとに別のインスタンス（別のモジュール状態）で動くことがある。
// 会話や上限がメモリではなく Redis にあることを、モジュールを読み直しながら確かめる。
// On Vercel each request may land on a fresh instance. Reload the module between requests to prove state lives in Redis, not memory.
const ENV = {
  AI_PROVIDER: "mock",
  ACCESS_CODE: "handson-code",
  ADMIN_CODE: "admin-code-1234",
  UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
  VERCEL: "1",
  MAX_TURNS_PER_PERSONA: "2",
};

async function freshInstance() {
  vi.resetModules();
  const module = await import("../src/index.js");
  return module.default;
}

describe("Vercel の入口（src/index.ts）", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("インスタンスが変わっても、会話・残り回数・停止の状態が引き継がれる / state survives instance changes", async () => {
    const fake = installFakeUpstash();
    const cookieOf = (res: Response) => res.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    const json = { "Content-Type": "application/json" };

    // インスタンスA: ログインして1往復 / instance A: log in and chat once
    const a = await freshInstance();
    const login = await a.request("/api/session", { method: "POST", headers: json, body: JSON.stringify({ code: ENV.ACCESS_CODE, name: "田中" }) });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    const first = await a.request("/api/chat/b-company", { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ message: "1つ目" }) });
    expect(parseSse(await first.text()).at(-1)?.event).toBe("done");

    // インスタンスB: 履歴が見え、もう1往復でき、上限が数えられている / instance B sees the history and the counter
    const b = await freshInstance();
    const history = (await (await b.request("/api/chat/b-company", { headers: { Cookie: cookie } })).json()) as { messages: unknown[]; remaining: number };
    expect(history.messages).toHaveLength(2);
    expect(history.remaining).toBe(1);
    const second = await b.request("/api/chat/b-company", { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ message: "2つ目" }) });
    expect(parseSse(await second.text()).at(-1)?.data.remaining).toBe(0);

    // インスタンスC: 上限は効き、講師の停止も共有され、ログは Redis にある / instance C enforces the limit; admin stop and logs are shared
    const c = await freshInstance();
    const blocked = await c.request("/api/chat/b-company", { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ message: "3つ目" }) });
    expect(blocked.status).toBe(429);

    const adminLogin = await c.request("/api/admin/login", { method: "POST", headers: json, body: JSON.stringify({ code: ENV.ADMIN_CODE }) });
    const adminCookie = cookieOf(adminLogin);
    await c.request("/api/admin/stop", { method: "POST", headers: { ...json, Cookie: adminCookie }, body: JSON.stringify({ stopped: true }) });

    const d = await freshInstance();
    const stopped = await d.request("/api/chat/cs", { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ message: "別の相手" }) });
    expect(stopped.status).toBe(403);

    const logs = await (await d.request("/api/admin/logs", { headers: { Cookie: adminCookie } })).text();
    expect(logs.trim().split("\n")).toHaveLength(4);
    expect([...fake.data.keys()].some((key) => key.startsWith("log:"))).toBe(true);
  });

  it("Redis が無いと、起動させずに設定エラーを返す / without Redis on Vercel it answers a config error instead of silently using memory", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const app = await freshInstance();
    const res = await app.request("/api/session");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("misconfigured");
  });
});

// Vercel は、次の名前のファイルのうち「hono を import している最初の1つ」を入口にする（@vercel/backends の規則）。
// 他のファイルが先に当たると、default export が無くて起動に失敗する（"The default export must be a function or server"）。
// Vercel picks the first file among these names that imports hono. If another file matches first, the function fails to start.
describe("Vercel の入口の検出 / entrypoint detection", () => {
  it("hono を import する入口の候補は src/index.ts だけ / only src/index.ts is a Hono entrypoint candidate", () => {
    const names = ["app", "index", "server", "src/app", "src/index", "src/server", "main", "src/main"];
    const extensions = ["js", "cjs", "mjs", "ts", "cts", "mts"];
    const importsHono = /(?:from|require|import)\s*(?:\(\s*)?["']hono["']\s*(?:\))?/;

    const matches = names
      .flatMap((name) => extensions.map((extension) => `${name}.${extension}`))
      .filter((file) => existsSync(file) && importsHono.test(readFileSync(file, "utf8")));

    expect(matches).toEqual(["src/index.ts"]);
  });

  it("入口は default export で fetch を持つ Hono アプリ / the entrypoint default-exports a Hono app with fetch", async () => {
    const module = await import("../src/index.js");
    expect(typeof module.default.fetch).toBe("function");
  });
});
