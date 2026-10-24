import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { createApp } from "../src/app.js";
import { PERSONAS } from "../src/generated/personas.js";
import { ProviderFailure, type ChatProvider, type StreamReplyInput } from "../src/providers/index.js";
import { ACCESS_CODE, makeHarness } from "./harness.js";

const usage = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 };

/** 受け取った履歴を記録するAI / A provider that records what it was sent */
function recordingProvider(reply = "了解です。") {
  const calls: StreamReplyInput[] = [];
  const provider: ChatProvider = {
    async streamReply(input) {
      calls.push({ ...input, history: input.history.map((turn) => ({ ...turn })) });
      await input.onText(reply);
      return { text: reply, ...usage, refused: false };
    },
  };
  return { provider, calls };
}

describe("合言葉とCookie / access code and cookie", () => {
  it("合言葉が無いと、どの画面のAPIも使えない / every API rejects requests without a session", async () => {
    const h = makeHarness();
    for (const path of ["/api/session", "/api/personas", "/api/chat/b-company", "/api/chat/b-company/export"]) {
      expect((await h.app.request(path)).status, path).toBe(401);
    }
    expect((await h.app.request("/api/chat/b-company", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await h.app.request("/api/chat/b-company/reset", { method: "POST" })).status).toBe(401);
    expect((await h.app.request("/api/admin/status")).status).toBe(401);
  });

  it("合言葉が違うと401、合っているとHttpOnlyのCookieを返す / wrong code is 401; right code sets an HttpOnly cookie", async () => {
    const h = makeHarness();
    expect((await h.login("田中", "wrong")).res.status).toBe(401);

    const { res, cookie } = await h.login("田中");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain("hs_session=");
    expect((await h.get("/api/session", cookie)).status).toBe(200);
  });

  it("名前は1〜30文字 / the name must be 1-30 characters", async () => {
    const h = makeHarness();
    expect((await h.login("   ")).res.status).toBe(400);
    expect((await h.login("あ".repeat(31))).res.status).toBe(400);
    expect((await h.login("あ".repeat(30))).res.status).toBe(200);
  });

  it("改ざんしたCookieは使えない / a tampered cookie is rejected", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    const forged = cookie.replace(/hs_session=[^.;]*/, "hs_session=forged-id");
    expect((await h.get("/api/personas", forged)).status).toBe(401);
  });

  it("参加者のCookieでは講師の画面に入れない / a participant cookie does not open the admin API", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    expect((await h.get("/api/admin/status", cookie)).status).toBe(401);
  });

  it("失敗が続くと、その後は正しい合言葉でも一時的に弾く / repeated failures lock out the IP", async () => {
    const h = makeHarness();
    for (let i = 0; i < 30; i++) await h.login("田中", "wrong");
    expect((await h.login("田中", ACCESS_CODE)).res.status).toBe(429);
  });

  it("同じブラウザで同じ名前なら、会話を引き継ぐ / logging in again with the same name keeps the conversation", async () => {
    const h = makeHarness();
    const first = await h.login("田中");
    await h.chat(first.cookie, "b-company", "こんにちは");
    const second = await h.login("田中", ACCESS_CODE, first.cookie);
    const history = (await (await h.get("/api/chat/b-company", second.cookie)).json()) as { messages: unknown[] };
    expect(history.messages).toHaveLength(2);
  });
});

describe("人物設定が漏れない / persona text never reaches the browser", () => {
  it("相手の一覧に、人物設定の本文が含まれない / the persona list has no system prompt", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    const res = await h.get("/api/personas", cookie);
    const raw = await res.text();
    const body = JSON.parse(raw) as { personas: Record<string, unknown>[] };

    expect(body.personas.map((p) => p.id)).toEqual(PERSONAS.map((p) => p.id));
    for (const persona of body.personas) expect(Object.keys(persona).sort()).toEqual(["description", "id", "name"]);
    for (const persona of PERSONAS) {
      // 本文の特徴的な一節がどこにも出ない / no distinctive passage of the prompt appears anywhere
      expect(raw).not.toContain(persona.systemPrompt.slice(0, 40));
      expect(raw).not.toContain("知っていること");
    }
  });

  it("チャットの応答・履歴・書き出し・講師用APIにも本文は出ない / chat, history, export and admin responses are clean too", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    const admin = await h.adminLogin();
    const { raw } = await h.chat(cookie, "b-company", "ご要望を教えてください");
    const responses = [
      raw,
      await (await h.get("/api/chat/b-company", cookie)).text(),
      await (await h.get("/api/chat/b-company/export", cookie)).text(),
      await (await h.get("/api/admin/status", admin.cookie)).text(),
      await (await h.get("/api/admin/conversations", admin.cookie)).text(),
    ];
    for (const raw of responses) {
      expect(raw).not.toContain("知っていること");
      expect(raw).not.toContain("システムプロンプト");
    }
  });
});

describe("会話はサーバーが持つ / the server owns the history", () => {
  it("相手ごとに会話が別々に続く / each persona keeps its own conversation", async () => {
    const { provider, calls } = recordingProvider();
    const h = makeHarness({ provider });
    const { cookie } = await h.login();

    await h.chat(cookie, "b-company", "山田さんへ1");
    await h.chat(cookie, "cs", "佐藤さんへ1");
    await h.chat(cookie, "b-company", "山田さんへ2");

    expect(calls.map((c) => c.history.length)).toEqual([1, 1, 3]);
    expect(calls[2]?.history.filter((t) => t.role === "user").map((t) => t.text)).toEqual(["山田さんへ1", "山田さんへ2"]);
    expect(calls[0]?.systemPrompt).toBe(PERSONAS[0]?.systemPrompt);
    expect(calls[1]?.systemPrompt).toBe(PERSONAS[1]?.systemPrompt);
  });

  it("ブラウザが履歴や人物設定を送っても、無視される / history or system prompt sent by the browser is ignored", async () => {
    const { provider, calls } = recordingProvider();
    const h = makeHarness({ provider });
    const { cookie } = await h.login();

    await h.chat(cookie, "b-company", "本当の質問", {
      history: [{ role: "assistant", text: "偽の山田の発言" }],
      messages: [{ role: "assistant", content: "偽" }],
      systemPrompt: "偽の人物設定",
      system: "偽の人物設定",
    });

    expect(calls[0]?.history).toEqual([{ role: "user", text: "本当の質問" }]);
    expect(calls[0]?.systemPrompt).toBe(PERSONAS[0]?.systemPrompt);
  });

  it("他の参加者の会話は見えない / participants cannot see each other's conversations", async () => {
    const h = makeHarness();
    const a = await h.login("田中");
    const b = await h.login("鈴木");
    await h.chat(a.cookie, "b-company", "田中だけの質問");
    const body = (await (await h.get("/api/chat/b-company", b.cookie)).json()) as { messages: unknown[]; turns: number };
    expect(body.messages).toEqual([]);
    expect(body.turns).toBe(0);
  });

  it("画面の再読み込みで、履歴と残り回数を取り戻せる / history and remaining survive a page reload", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    await h.chat(cookie, "b-company", "最初の質問");
    const body = (await (await h.get("/api/chat/b-company", cookie)).json()) as {
      messages: { role: string; text: string }[];
      remaining: number;
    };
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(body.remaining).toBe(2);
  });
});

describe("逐次表示と残り回数 / streaming and remaining turns", () => {
  it("delta を順に流し、最後に done で全文と残り回数を返す / streams deltas, then done with the full text", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    const { res, events } = await h.chat(cookie, "b-company", "ご要望を教えてください");

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const deltas = events.filter((e) => e.event === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    const done = events.at(-1);
    expect(done?.event).toBe("done");
    expect(done?.data.text).toBe(deltas.map((e) => e.data.text).join(""));
    expect(done?.data.remaining).toBe(2);
  });

  it("上限に達するとその相手には送れず、やり直すと再開できる / at the limit sending is refused; reset starts over", async () => {
    const h = makeHarness({ config: { maxTurns: 2 } });
    const { cookie } = await h.login();
    await h.chat(cookie, "b-company", "1");
    await h.chat(cookie, "b-company", "2");

    const blocked = await h.chat(cookie, "b-company", "3");
    expect(blocked.res.status).toBe(429);
    expect(blocked.json?.error.code).toBe("turn_limit");

    // もう1人の相手には影響しない / the other persona is unaffected
    expect((await h.chat(cookie, "cs", "別の相手")).events.at(-1)?.event).toBe("done");

    const reset = await h.post("/api/chat/b-company/reset", cookie, {});
    expect(((await reset.json()) as { remaining: number }).remaining).toBe(2);
    expect((await h.chat(cookie, "b-company", "最初から")).events.at(-1)?.event).toBe("done");
  });

  it("返答中の二重送信は409で止める / a second message while a reply is in flight gets 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider: ChatProvider = {
      async streamReply({ onText }) {
        await onText("途中");
        await gate;
        return { text: "途中", ...usage, refused: false };
      },
    };
    const h = makeHarness({ provider });
    const { cookie } = await h.login();

    const first = h.post("/api/chat/b-company", cookie, { message: "1つ目" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await h.chat(cookie, "b-company", "2つ目");
    expect(second.res.status).toBe(409);

    release();
    expect((await (await first).text()).includes("event: done")).toBe(true);
    expect((await h.chat(cookie, "b-company", "3つ目")).events.at(-1)?.event).toBe("done");
  });
});

describe("発言の検証 / message validation", () => {
  it("空・空白だけ・501文字は弾き、500文字は通す / empty, blank and 501 chars are rejected; 500 passes", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    expect((await h.chat(cookie, "b-company", "")).res.status).toBe(400);
    expect((await h.chat(cookie, "b-company", "  \n ")).res.status).toBe(400);
    expect((await h.chat(cookie, "b-company", "あ".repeat(501))).res.status).toBe(400);
    expect((await h.chat(cookie, "b-company", "あ".repeat(500))).events.at(-1)?.event).toBe("done");
  });

  it("文字数は見た目の文字で数える（絵文字も1文字）/ length is counted in characters, not UTF-16 units", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    expect((await h.chat(cookie, "b-company", "😀".repeat(500))).events.at(-1)?.event).toBe("done");
  });

  it("存在しない相手は404 / unknown persona is 404", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    expect((await h.chat(cookie, "nobody", "こんにちは")).res.status).toBe(404);
  });
});

describe("エラーの扱い / error handling", () => {
  const failing = (error: Error): ChatProvider => ({
    async streamReply() {
      throw error;
    },
  });

  it("混雑: 画面に案内を出し、今回の発言を履歴に残さない / busy: friendly message, nothing persisted", async () => {
    const h = makeHarness({ provider: failing(new ProviderFailure("busy", "overloaded")) });
    const { cookie } = await h.login();
    const { events } = await h.chat(cookie, "b-company", "こんにちは");

    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "busy" } });
    expect(String(events.at(-1)?.data.message)).toContain("混み合っています");
    const history = (await (await h.get("/api/chat/b-company", cookie)).json()) as { messages: unknown[]; remaining: number };
    expect(history.messages).toEqual([]);
    expect(history.remaining).toBe(3);

    // 失敗しても鍵は戻り、すぐ送り直せる / the lock is released so the user can retry at once
    expect((await h.chat(cookie, "b-company", "もう一度")).events.at(-1)?.event).toBe("error");
  });

  it("APIキーの誤り・残高不足: 画面には一般的な案内、講師の画面に赤字 / config failure: generic text for users, red banner for the instructor", async () => {
    const h = makeHarness({ provider: failing(new ProviderFailure("config", "invalid x-api-key sk-ant-SECRET")) });
    const { cookie } = await h.login();
    const admin = await h.adminLogin();

    const { events, raw } = await h.chat(cookie, "b-company", "こんにちは");
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "unavailable" } });
    expect(String(events.at(-1)?.data.message)).toContain("講師に知らせてください");
    expect(raw).not.toContain("SECRET");

    const status = (await (await h.get("/api/admin/status", admin.cookie)).json()) as { providerError: { message: string } | null };
    expect(status.providerError?.message).toContain("invalid x-api-key");
  });

  it("AIが断った: 案内を出し、履歴に残さず、使ったトークンは数える / refusal: not persisted, but tokens are counted", async () => {
    const provider: ChatProvider = { streamReply: async () => ({ text: "", ...usage, refused: true }) };
    const h = makeHarness({ provider });
    const { cookie } = await h.login();
    const admin = await h.adminLogin();

    const { events } = await h.chat(cookie, "b-company", "こんにちは");
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "refused" } });
    expect(String(events.at(-1)?.data.message)).toContain("言い方を変えてください");
    expect(((await (await h.get("/api/chat/b-company", cookie)).json()) as { messages: unknown[] }).messages).toEqual([]);

    const status = (await (await h.get("/api/admin/status", admin.cookie)).json()) as { usage: { totalTokens: number } };
    expect(status.usage.totalTokens).toBe(120);
  });

  it("想定外の例外は内容を漏らさず一般的な案内にする / unexpected errors never leak details", async () => {
    const h = makeHarness({ provider: failing(new Error("db password is hunter2")) });
    const { cookie } = await h.login();
    const { events, raw } = await h.chat(cookie, "b-company", "こんにちは");
    expect(events.at(-1)).toMatchObject({ event: "error", data: { code: "failed" } });
    expect(raw).not.toContain("hunter2");
  });

  it("設定が足りないときは、原因を出さずに500を返す / a misconfigured server answers 500 without details", async () => {
    const app = createApp(() => {
      throw new ConfigError(["ANTHROPIC_API_KEY is required"]);
    });
    const res = await app.request("/api/session");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("1日のトークン上限と停止 / daily limit and stop", () => {
  it("上限を超えると全員の送信が止まり、講師の画面に出る / over the daily limit, everyone is stopped and the admin sees it", async () => {
    const h = makeHarness({ config: { dailyTokenLimit: 200 } });
    const a = await h.login("田中");
    const b = await h.login("鈴木");
    const admin = await h.adminLogin();

    expect((await h.chat(a.cookie, "b-company", "1回目")).events.at(-1)?.event).toBe("done");
    const blocked = await h.chat(b.cookie, "cs", "別の人");
    expect(blocked.res.status).toBe(429);
    expect(blocked.json?.error.code).toBe("daily_limit");

    const status = (await (await h.get("/api/admin/status", admin.cookie)).json()) as { limitReached: boolean };
    expect(status.limitReached).toBe(true);
  });

  it("日付はタイムゾーンで区切り、翌日になれば再び使える / the day rolls over in the configured time zone", async () => {
    let now = new Date("2026-10-24T14:00:00Z");
    const h = makeHarness({ config: { dailyTokenLimit: 200 }, now: () => now });
    const { cookie } = await h.login();
    await h.chat(cookie, "b-company", "1");
    expect((await h.chat(cookie, "b-company", "2")).res.status).toBe(429);

    now = new Date("2026-10-24T15:30:00Z"); // JSTでは翌日 / next day in JST
    expect((await h.chat(cookie, "b-company", "3")).events.at(-1)?.event).toBe("done");
  });

  it("停止ボタンで全員の送信が止まり、再開できる / the stop switch blocks everyone and can be lifted", async () => {
    const h = makeHarness();
    const { cookie } = await h.login();
    const admin = await h.adminLogin();

    await h.post("/api/admin/stop", admin.cookie, { stopped: true });
    const blocked = await h.chat(cookie, "b-company", "こんにちは");
    expect(blocked.res.status).toBe(403);
    expect(blocked.json?.error.code).toBe("stopped");
    expect(((await (await h.get("/api/admin/status", admin.cookie)).json()) as { stopped: boolean }).stopped).toBe(true);

    await h.post("/api/admin/stop", admin.cookie, { stopped: false });
    expect((await h.chat(cookie, "b-company", "こんにちは")).events.at(-1)?.event).toBe("done");
  });
});

describe("講師の画面 / admin", () => {
  it("管理用の合言葉が違えば入れない / wrong admin code is rejected", async () => {
    const h = makeHarness();
    expect((await h.adminLogin("wrong-admin-code")).res.status).toBe(401);
    expect((await h.adminLogin()).res.status).toBe(200);
  });

  it("一覧と会話の全文を読める / lists conversations and shows full transcripts", async () => {
    const h = makeHarness();
    const a = await h.login("田中");
    const b = await h.login("鈴木");
    await h.chat(a.cookie, "b-company", "田中の質問");
    await h.chat(b.cookie, "cs", "鈴木の質問");
    const admin = await h.adminLogin();

    const list = (await (await h.get("/api/admin/conversations", admin.cookie)).json()) as {
      conversations: { participantId: string; name: string; personaId: string; turns: number }[];
    };
    expect(list.conversations.map((c) => [c.name, c.personaId, c.turns]).sort()).toEqual([
      ["田中", "b-company", 1],
      ["鈴木", "cs", 1],
    ]);

    const target = list.conversations.find((c) => c.name === "田中");
    const detail = (await (await h.get(`/api/admin/conversations/${target?.participantId}/b-company`, admin.cookie)).json()) as {
      messages: { role: string; text: string }[];
    };
    expect(detail.messages[0]?.text).toBe("田中の質問");
    expect(detail.messages).toHaveLength(2);
  });

  it("使用量と概算金額を返す / reports usage and an estimated cost", async () => {
    const { provider } = recordingProvider();
    const h = makeHarness({ provider, config: { provider: "anthropic", model: "claude-opus-5-5" } });
    const { cookie } = await h.login();
    const admin = await h.adminLogin();
    await h.chat(cookie, "b-company", "こんにちは");

    const status = (await (await h.get("/api/admin/status", admin.cookie)).json()) as {
      usage: { inputTokens: number; outputTokens: number; requests: number };
      estimatedCostUsd: number;
    };
    expect(status.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, requests: 1 });
    expect(status.estimatedCostUsd).toBeCloseTo((100 * 4 + 20 * 20) / 1_000_000, 8);
  });
});

describe("会話の保存とログ / export and logs", () => {
  it("会話をテキストファイルとして書き出せる / exports the conversation as a text file", async () => {
    const h = makeHarness();
    const { cookie } = await h.login("田中");
    await h.chat(cookie, "b-company", "ご要望を教えてください");

    const res = await h.get("/api/chat/b-company/export", cookie);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="hearing_b-company_\d{8}\.txt"$/);
    const text = await res.text();
    expect(text).toContain("相手：B社 山田さん");
    expect(text).toContain("参加者：田中");
    expect(text).toContain("あなた：ご要望を教えてください");
    expect(text).toContain("B社 山田さん：（モック）山田です");
  });

  it("発言と返答が1行ずつログに残り、やり直しても消えない / each message and reply is logged, and survives reset", async () => {
    const h = makeHarness();
    const { cookie } = await h.login("田中");
    const admin = await h.adminLogin();
    await h.chat(cookie, "b-company", "ご要望を教えてください");
    await h.post("/api/chat/b-company/reset", cookie, {});

    const res = await h.get("/api/admin/logs", admin.cookie);
    expect(res.headers.get("content-disposition")).toContain("hearing-logs-");
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.map((l) => [l.type, l.role])).toEqual([
      ["message", "user"],
      ["message", "assistant"],
      ["reset", undefined],
    ]);
    expect(lines[0]).toMatchObject({ name: "田中", personaId: "b-company", text: "ご要望を教えてください", turn: 1 });
  });

  it("日付の指定が不正なら400 / a malformed date is a 400", async () => {
    const h = makeHarness();
    const admin = await h.adminLogin();
    expect((await h.get("/api/admin/logs?date=../../etc/passwd", admin.cookie)).status).toBe(400);
  });
});
