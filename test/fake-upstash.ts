import { vi } from "vitest";

// Upstash の REST API を最小限まねた偽サーバー。本番（Vercel）が使う経路を、実際の Redis 無しで確かめる
// A minimal fake of the Upstash REST API, to exercise the production (Vercel) path without a real Redis.
export function installFakeUpstash() {
  const data = new Map<string, string | Set<string> | string[]>();
  const ttls = new Map<string, number>();
  const commands: unknown[][] = [];

  const encode = (value: unknown): unknown => {
    if (typeof value === "string") return Buffer.from(value, "utf8").toString("base64");
    if (Array.isArray(value)) return value.map(encode);
    return value;
  };

  const run = (command: unknown[]): unknown => {
    const [name, key, ...args] = command as [string, string, ...(string | number)[]];
    switch (String(name).toUpperCase()) {
      case "GET": {
        const value = data.get(key);
        return typeof value === "string" ? value : null;
      }
      case "SET": {
        const [value, ...flags] = args;
        const upper = flags.map((flag) => String(flag).toUpperCase());
        if (upper.includes("NX") && data.has(key)) return null;
        data.set(key, String(value));
        const ex = upper.indexOf("EX");
        if (ex !== -1) ttls.set(key, Number(flags[ex + 1]));
        return "OK";
      }
      case "DEL":
        return data.delete(key) ? 1 : 0;
      case "INCRBY": {
        const next = Number(data.get(key) ?? 0) + Number(args[0]);
        data.set(key, String(next));
        return next;
      }
      case "EXPIRE":
        ttls.set(key, Number(args[0]));
        return 1;
      case "SADD": {
        const set = (data.get(key) as Set<string> | undefined) ?? new Set<string>();
        set.add(String(args[0]));
        data.set(key, set);
        return 1;
      }
      case "SMEMBERS":
        return [...((data.get(key) as Set<string> | undefined) ?? [])];
      case "RPUSH": {
        const list = (data.get(key) as string[] | undefined) ?? [];
        list.push(String(args[0]));
        data.set(key, list);
        return list.length;
      }
      case "LRANGE":
        return [...((data.get(key) as string[] | undefined) ?? [])];
      default:
        throw new Error(`unsupported command ${String(name)}`);
    }
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown[];
      const base64 = new Headers(init?.headers).get("upstash-encoding") === "base64";
      const respond = (command: unknown[]) => {
        commands.push(command);
        const result = run(command);
        return { result: base64 ? encode(result) : result };
      };
      // 自動パイプラインは /pipeline に配列でまとめて送る / the auto-pipeline posts an array of commands to /pipeline
      const payload = String(input).endsWith("/pipeline") ? (body as unknown[][]).map(respond) : respond(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return { data, ttls, commands };
}
