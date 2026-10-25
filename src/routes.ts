import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  ADMIN_COOKIE,
  COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  deriveSecrets,
  isLockedOut,
  registerFailure,
  safeEqual,
} from "./auth.js";
import { ConfigError, MAX_MESSAGE_CHARS, type Config } from "./config.js";
import { FileLogSink, StoreLogSink, type LogEntry, type LogSink } from "./logs.js";
import { findPersona, listPersonas, toPublicPersona } from "./personas.js";
import { estimateCostUsd } from "./pricing.js";
import { ProviderFailure, type ChatProvider } from "./providers/index.js";
import { SessionService, type Participant } from "./sessions.js";
import type { Store } from "./store/index.js";

export interface Deps {
  config: Config;
  store: Store;
  provider: ChatProvider;
  logs: LogSink;
  now?: () => Date;
}

/** 本番の組み立て: Redis があればログもRedis、無ければファイル / Production wiring: Redis logs when on Redis, files otherwise */
export function defaultLogSink(config: Config, store: Store): LogSink {
  return store.kind === "redis" ? new StoreLogSink(store, config.dataTtlSeconds) : new FileLogSink(config.logDir);
}

interface Runtime {
  deps: Deps;
  svc: SessionService;
  secrets: { participant: string; admin: string };
}

type AppEnv = { Variables: { rt: Runtime; participant: Participant } };

const MESSAGES = {
  badCode: "合言葉が違います",
  tooManyAttempts: "合言葉の入力に何度も失敗したため、しばらく使えません。少し待ってから試してください",
  nameRequired: "名前を入力してください（30文字まで）",
  needLogin: "最初に合言葉と名前を入力してください",
  stopped: "いま講師が送信を止めています。しばらくお待ちください",
  dailyLimit: "本日の利用上限に達しました。講師に知らせてください",
  busy: "混み合っています。少し待ってから送り直してください",
  unavailable: "ツールが使えません。講師に知らせてください",
  refused: "この質問には答えられませんでした。言い方を変えてください",
  failed: "エラーが発生しました。もう一度送ってください",
  empty: "返答が空でした。もう一度送ってください",
  inFlight: "前の返答がまだ続いています。終わってから送ってください",
  misconfigured: "サーバーの設定が足りません。講師に知らせてください",
} as const;

const codePoints = (text: string) => [...text].length;

function jsonError(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const asString = (value: unknown) => (typeof value === "string" ? value : "");

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function cookieOptions(c: Context) {
  const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  return { httpOnly: true, sameSite: "Lax" as const, secure, path: "/", maxAge: COOKIE_MAX_AGE_SECONDS };
}

function formatJa(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function createApp(resolveDeps: () => Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const runtimes = new WeakMap<Deps, Runtime>();

  const runtimeFor = (): Runtime => {
    const deps = resolveDeps();
    let rt = runtimes.get(deps);
    if (!rt) {
      rt = {
        deps,
        svc: new SessionService(deps.store, deps.config, deps.now),
        secrets: deriveSecrets(deps.config),
      };
      runtimes.set(deps, rt);
    }
    return rt;
  };

  // --- すべてのAPI共通 / Applies to every API route ---
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    try {
      c.set("rt", runtimeFor());
    } catch (error) {
      console.error("[config]", error instanceof Error ? error.message : error);
      if (error instanceof ConfigError) return jsonError(c, 500, "misconfigured", MESSAGES.misconfigured);
      throw error;
    }
    await next();
  });

  // --- 参加者の合言葉とCookie / Participant access code and cookie ---

  const currentParticipant = async (c: Context<AppEnv>): Promise<Participant | null> => {
    const { svc, secrets } = c.get("rt");
    const id = await getSignedCookie(c, secrets.participant, SESSION_COOKIE);
    if (!id) return null;
    return svc.getParticipant(id);
  };

  const requireParticipant = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const participant = await currentParticipant(c);
    if (!participant) return jsonError(c, 401, "unauthorized", MESSAGES.needLogin);
    c.set("participant", participant);
    await next();
  };

  app.post("/api/session", async (c) => {
    const { deps, svc, secrets } = c.get("rt");
    const ip = clientIp(c);
    if (await isLockedOut(deps.store, "participant", ip, 30)) {
      return jsonError(c, 429, "too_many_attempts", MESSAGES.tooManyAttempts);
    }

    const body = await readJson(c);
    if (!safeEqual(asString(body.code), deps.config.accessCode)) {
      await registerFailure(deps.store, "participant", ip);
      return jsonError(c, 401, "bad_code", MESSAGES.badCode);
    }

    const name = asString(body.name).trim();
    if (name === "" || codePoints(name) > 30) return jsonError(c, 400, "name_required", MESSAGES.nameRequired);

    // 同じブラウザで同じ名前なら、会話を引き継ぐ / Same browser and same name: keep the existing conversations
    const existing = await currentParticipant(c);
    const participant = existing?.name === name ? existing : await svc.createParticipant(name);
    await setSignedCookie(c, SESSION_COOKIE, participant.id, secrets.participant, cookieOptions(c));
    return c.json({ name: participant.name });
  });

  app.get("/api/session", async (c) => {
    const participant = await currentParticipant(c);
    if (!participant) return jsonError(c, 401, "unauthorized", MESSAGES.needLogin);
    return c.json({ name: participant.name });
  });

  app.get("/api/personas", requireParticipant, (c) => {
    const { deps } = c.get("rt");
    return c.json({
      personas: listPersonas().map(toPublicPersona),
      maxTurns: deps.config.maxTurns,
      maxMessageChars: MAX_MESSAGE_CHARS,
    });
  });

  // --- 会話 / Conversations ---

  const writeLog = async (rt: Runtime, participant: Participant, personaId: string, entry: Omit<LogEntry, "ts" | "participantId" | "name" | "personaId">) => {
    const now = (rt.deps.now ?? (() => new Date()))();
    try {
      await rt.deps.logs.append(rt.svc.dateKey(now), {
        ts: now.toISOString(),
        participantId: participant.id,
        name: participant.name,
        personaId,
        ...entry,
      });
    } catch (error) {
      // ログの失敗で会話を止めない / A logging failure must not break the conversation
      console.error("[log]", error);
    }
  };

  app.get("/api/chat/:personaId", requireParticipant, async (c) => {
    const { deps, svc } = c.get("rt");
    const participant = c.get("participant");
    const persona = findPersona(c.req.param("personaId") ?? "");
    if (!persona) return jsonError(c, 404, "persona_not_found", "相手が見つかりません");

    const conversation = await svc.getConversation(participant.id, persona.id);
    return c.json({
      messages: (conversation?.messages ?? []).map(({ role, text }) => ({ role, text })),
      turns: conversation?.turns ?? 0,
      remaining: Math.max(0, deps.config.maxTurns - (conversation?.turns ?? 0)),
    });
  });

  app.post("/api/chat/:personaId", requireParticipant, async (c) => {
    const rt = c.get("rt");
    const { deps, svc } = rt;
    const participant = c.get("participant");
    const persona = findPersona(c.req.param("personaId") ?? "");
    if (!persona) return jsonError(c, 404, "persona_not_found", "相手が見つかりません");

    // 1) 認証は済み。2) 停止・残り回数・1日の上限 / Auth is done; now stop flag, turn limit, daily token limit
    if (await svc.isStopped()) return jsonError(c, 403, "stopped", MESSAGES.stopped);
    if ((await svc.getUsage()).totalTokens >= deps.config.dailyTokenLimit) {
      return jsonError(c, 429, "daily_limit", MESSAGES.dailyLimit);
    }

    // 3) 発言の検証 / Validate the message
    const message = asString((await readJson(c)).message).trim();
    if (message === "") return jsonError(c, 400, "empty_message", "質問を入力してください");
    if (codePoints(message) > MAX_MESSAGE_CHARS) {
      return jsonError(c, 400, "message_too_long", `1回の質問は${MAX_MESSAGE_CHARS}文字までです`);
    }

    if (!(await svc.lockConversation(participant.id, persona.id))) {
      return jsonError(c, 409, "in_flight", MESSAGES.inFlight);
    }

    let streaming = false;
    try {
      const conversation = (await svc.getConversation(participant.id, persona.id)) ?? svc.newConversation(participant.id, persona.id);
      if (conversation.turns >= deps.config.maxTurns) {
        return jsonError(
          c,
          429,
          "turn_limit",
          `この相手とは上限の${deps.config.maxTurns}往復に達しました。「やり直す」で最初から始められます`,
        );
      }

      streaming = true;
      return streamSSE(c, async (stream) => {
        const send = async (event: string, data: unknown) => {
          try {
            await stream.writeSSE({ event, data: JSON.stringify(data) });
          } catch {
            // ブラウザが切断済み / The browser has already gone away
          }
        };

        const controller = new AbortController();
        stream.onAbort(() => controller.abort());

        try {
          // 4) 履歴に今回の発言を足して、人物設定と一緒に送る（保存は成功してから）
          // Append this message to the history and send it with the persona (persisted only after success)
          const history = [
            ...conversation.messages.map(({ role, text }) => ({ role, text })),
            { role: "user" as const, text: message },
          ];

          const result = await deps.provider.streamReply({
            systemPrompt: persona.systemPrompt,
            history,
            onText: (delta) => send("delta", { text: delta }),
            onReset: () => send("reset", {}),
            signal: controller.signal,
          });

          // 断られた場合も、使ったトークンは記録する / Tokens were spent even when the model refused
          await svc.recordUsage(result);

          if (result.refused) {
            await writeLog(rt, participant, persona.id, { type: "refused", role: "user", text: message });
            await send("error", { code: "refused", message: MESSAGES.refused });
            return;
          }
          if (result.text.trim() === "") {
            await writeLog(rt, participant, persona.id, { type: "error", detail: "empty reply" });
            await send("error", { code: "empty", message: MESSAGES.empty });
            return;
          }

          // 5) 返答を履歴に足して保存 / Persist the exchange
          const at = (deps.now ?? (() => new Date()))().toISOString();
          conversation.messages.push({ role: "user", text: message, at }, { role: "assistant", text: result.text, at });
          conversation.turns += 1;
          conversation.lastAt = at;
          await svc.saveConversation(conversation);
          await svc.clearProviderError();

          // 6) ログに発言と返答を1行ずつ追記 / Append the message and the reply as separate log lines
          await writeLog(rt, participant, persona.id, { type: "message", role: "user", text: message, turn: conversation.turns });
          await writeLog(rt, participant, persona.id, { type: "message", role: "assistant", text: result.text, turn: conversation.turns });

          await send("done", {
            text: result.text,
            turns: conversation.turns,
            remaining: Math.max(0, deps.config.maxTurns - conversation.turns),
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ProviderFailure && error.kind === "busy") {
            console.warn("[provider:busy]", error.message);
            await send("error", { code: "busy", message: MESSAGES.busy });
          } else if (error instanceof ProviderFailure && error.kind === "config") {
            console.error("[provider:config]", error.message);
            await svc.setProviderError(error.message);
            await send("error", { code: "unavailable", message: MESSAGES.unavailable });
          } else {
            console.error("[chat]", error);
            await writeLog(rt, participant, persona.id, {
              type: "error",
              detail: error instanceof Error ? error.message : String(error),
            });
            await send("error", { code: "failed", message: MESSAGES.failed });
          }
        } finally {
          await svc.unlockConversation(participant.id, persona.id);
        }
      });
    } finally {
      // ストリームを始められなかったときだけ、ここで鍵を戻す / Release here only if streaming never started
      if (!streaming) await svc.unlockConversation(participant.id, persona.id);
    }
  });

  app.post("/api/chat/:personaId/reset", requireParticipant, async (c) => {
    const rt = c.get("rt");
    const participant = c.get("participant");
    const persona = findPersona(c.req.param("personaId") ?? "");
    if (!persona) return jsonError(c, 404, "persona_not_found", "相手が見つかりません");

    if (!(await rt.svc.lockConversation(participant.id, persona.id))) {
      return jsonError(c, 409, "in_flight", MESSAGES.inFlight);
    }
    try {
      await rt.svc.deleteConversation(participant.id, persona.id);
      await writeLog(rt, participant, persona.id, { type: "reset" });
    } finally {
      await rt.svc.unlockConversation(participant.id, persona.id);
    }
    return c.json({ remaining: rt.deps.config.maxTurns });
  });

  app.get("/api/chat/:personaId/export", requireParticipant, async (c) => {
    const { deps, svc } = c.get("rt");
    const participant = c.get("participant");
    const persona = findPersona(c.req.param("personaId") ?? "");
    if (!persona) return jsonError(c, 404, "persona_not_found", "相手が見つかりません");

    const conversation = await svc.getConversation(participant.id, persona.id);
    const lines = [
      "模擬ヒアリング 会話の記録",
      `相手：${persona.name}`,
      `参加者：${participant.name}`,
      `保存日時：${formatJa((deps.now ?? (() => new Date()))().toISOString(), deps.config.timeZone)}`,
      "",
      ...(conversation?.messages ?? []).flatMap((message) => [
        `${message.role === "user" ? "あなた" : persona.name}：${message.text}`,
        "",
      ]),
    ];
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="hearing_${persona.id}_${svc.dateKey().replaceAll("-", "")}.txt"`);
    return c.body(lines.join("\n"));
  });

  // --- 講師用 / Instructor ---

  app.post("/api/admin/login", async (c) => {
    const { deps, secrets } = c.get("rt");
    const ip = clientIp(c);
    if (await isLockedOut(deps.store, "admin", ip, 10)) {
      return jsonError(c, 429, "too_many_attempts", MESSAGES.tooManyAttempts);
    }
    const body = await readJson(c);
    if (!safeEqual(asString(body.code), deps.config.adminCode)) {
      await registerFailure(deps.store, "admin", ip);
      return jsonError(c, 401, "bad_code", MESSAGES.badCode);
    }
    await setSignedCookie(c, ADMIN_COOKIE, "admin", secrets.admin, cookieOptions(c));
    return c.json({ ok: true });
  });

  app.use("/api/admin/*", async (c, next) => {
    if (c.req.path === "/api/admin/login") return next();
    const { secrets } = c.get("rt");
    const value = await getSignedCookie(c, secrets.admin, ADMIN_COOKIE);
    if (value !== "admin") return jsonError(c, 401, "unauthorized", "講師用の合言葉が必要です");
    await next();
  });

  app.post("/api/admin/logout", (c) => {
    deleteCookie(c, ADMIN_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/admin/status", async (c) => {
    const { deps, svc } = c.get("rt");
    const [usage, stopped, providerError] = await Promise.all([svc.getUsage(), svc.isStopped(), svc.getProviderError()]);
    return c.json({
      date: svc.dateKey(),
      stopped,
      providerError,
      provider: deps.config.provider,
      model: deps.config.model,
      storage: deps.store.kind,
      dailyTokenLimit: deps.config.dailyTokenLimit,
      limitReached: usage.totalTokens >= deps.config.dailyTokenLimit,
      maxTurns: deps.config.maxTurns,
      usage,
      estimatedCostUsd: estimateCostUsd(usage, deps.config),
    });
  });

  app.post("/api/admin/stop", async (c) => {
    const { svc } = c.get("rt");
    const body = await readJson(c);
    const stopped = body.stopped !== false;
    await svc.setStopped(stopped);
    return c.json({ stopped });
  });

  app.get("/api/admin/conversations", async (c) => {
    const { svc } = c.get("rt");
    const rows = await svc.listConversations();
    return c.json({
      conversations: rows.map(({ participant, conversation }) => ({
        participantId: participant.id,
        name: participant.name,
        personaId: conversation.personaId,
        personaName: findPersona(conversation.personaId)?.name ?? conversation.personaId,
        turns: conversation.turns,
        lastAt: conversation.lastAt,
      })),
    });
  });

  app.get("/api/admin/conversations/:participantId/:personaId", async (c) => {
    const { svc } = c.get("rt");
    const participantId = c.req.param("participantId");
    const persona = findPersona(c.req.param("personaId"));
    const [participant, conversation] = await Promise.all([
      svc.getParticipant(participantId),
      persona ? svc.getConversation(participantId, persona.id) : null,
    ]);
    if (!participant || !persona || !conversation) return jsonError(c, 404, "not_found", "会話が見つかりません");
    return c.json({
      name: participant.name,
      personaName: persona.name,
      turns: conversation.turns,
      messages: conversation.messages,
    });
  });

  app.get("/api/admin/logs", async (c) => {
    const { deps, svc } = c.get("rt");
    const date = c.req.query("date") ?? svc.dateKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError(c, 400, "bad_date", "日付は YYYY-MM-DD で指定してください");
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="hearing-logs-${date}.jsonl"`);
    return c.body(await deps.logs.readDay(date));
  });

  app.notFound((c) => (c.req.path.startsWith("/api/") ? jsonError(c, 404, "not_found", "見つかりません") : c.text("Not Found", 404)));
  app.onError((error, c) => {
    console.error("[unhandled]", error);
    return jsonError(c, 500, "internal", MESSAGES.failed);
  });

  return app;
}
