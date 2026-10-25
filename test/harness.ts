import { createApp, type Deps } from "../src/routes.js";
import type { Config } from "../src/config.js";
import { MemoryLogSink } from "../src/logs.js";
import { createMockProvider } from "../src/providers/mock.js";
import type { ChatProvider } from "../src/providers/index.js";
import { MemoryStore } from "../src/store/index.js";

export const ACCESS_CODE = "handson-code";
export const ADMIN_CODE = "admin-code-1234";

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function makeHarness(options: { provider?: ChatProvider; config?: Partial<Config>; now?: () => Date } = {}) {
  const config: Config = {
    provider: "mock",
    model: "mock",
    apiKey: undefined,
    accessCode: ACCESS_CODE,
    adminCode: ADMIN_CODE,
    sessionSecret: "",
    maxTurns: 3,
    dailyTokenLimit: 1_000_000,
    logDir: "./logs",
    dataTtlSeconds: 3600,
    timeZone: "Asia/Tokyo",
    fallbackEnabled: true,
    priceOverride: undefined,
    ...options.config,
  };
  const store = new MemoryStore();
  const logs = new MemoryLogSink();
  const provider = options.provider ?? createMockProvider(0);
  const deps: Deps = { config, store, provider, logs, now: options.now };
  const app = createApp(() => deps);

  const cookieFrom = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");

  async function login(name = "田中", code = ACCESS_CODE, cookie?: string): Promise<{ res: Response; cookie: string }> {
    const res = await app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ code, name }),
    });
    return { res, cookie: cookieFrom(res) };
  }

  async function adminLogin(code = ADMIN_CODE): Promise<{ res: Response; cookie: string }> {
    const res = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return { res, cookie: cookieFrom(res) };
  }

  const post = (path: string, cookie: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

  const get = (path: string, cookie: string) => app.request(path, { headers: { Cookie: cookie } });

  async function chat(cookie: string, personaId: string, message: string, extra: Record<string, unknown> = {}) {
    const res = await post(`/api/chat/${personaId}`, cookie, { message, ...extra });
    const isSse = res.headers.get("content-type")?.includes("text/event-stream") ?? false;
    const raw = await res.text();
    if (!isSse) return { res, raw, events: [] as SseEvent[], json: JSON.parse(raw) as Record<string, any> };
    return { res, raw, events: parseSse(raw), json: undefined };
  }

  return { app, config, store, logs, provider, login, adminLogin, post, get, chat };
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}
