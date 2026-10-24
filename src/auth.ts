import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Store } from "./store/index.js";

export const SESSION_COOKIE = "hs_session";
export const ADMIN_COOKIE = "hs_admin";
export const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

/** 合言葉の比較。長さの違いも時間差で漏らさない / Compare codes without leaking length or content through timing */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

// 合言葉を変えると、そのCookieだけ無効になる / Rotating a code invalidates exactly that cookie family
export function deriveSecrets(config: Pick<Config, "sessionSecret" | "accessCode" | "adminCode">): {
  participant: string;
  admin: string;
} {
  const derive = (scope: string, code: string) =>
    createHash("sha256").update(`${scope}|${config.sessionSecret}|${code}`).digest("hex");
  return {
    participant: derive("participant", config.accessCode),
    admin: derive("admin", config.adminCode),
  };
}

// 合言葉の総当たり対策。失敗だけを数える（教室の共有IPで正しい人が巻き込まれにくい）
// Brute-force guard that counts failures only, so a shared classroom IP is not locked out by successful logins
const WINDOW_SECONDS = 10 * 60;

export async function isLockedOut(store: Store, scope: string, ip: string, limit: number): Promise<boolean> {
  const failures = Number((await store.get(`rl:${scope}:${ip}`)) ?? 0);
  return failures >= limit;
}

export async function registerFailure(store: Store, scope: string, ip: string): Promise<void> {
  await store.incrBy(`rl:${scope}:${ip}`, 1, WINDOW_SECONDS);
}
