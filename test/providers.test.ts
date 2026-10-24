import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { ProviderFailure } from "../src/providers/types.js";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

const sse = (events: [string, object][]) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

function stubFetch(respond: (call: Captured, index: number) => Response) {
  const calls: Captured[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Captured = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetchStub };
}

const streamResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const jsonResponse = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function anthropicEvents(options: {
  chunks: string[];
  stopReason?: string;
  usage?: Record<string, number>;
  beforeText?: [string, object][];
}): string {
  const usage = { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, ...options.usage };
  return sse([
    [
      "message_start",
      {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage },
      },
    ],
    ...(options.beforeText ?? []),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...options.chunks.map((text): [string, object] => [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: options.stopReason ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: options.usage?.output_tokens ?? 12 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

const history = [
  { role: "user" as const, text: "ご要望を教えてください" },
  { role: "assistant" as const, text: "Scope3のその他に入れたいです。" },
  { role: "user" as const, text: "なぜですか？" },
];

describe("Claude（Anthropic）", () => {
  it("設計どおりのリクエストを組み立てて、逐次表示とトークン数を取り出す / builds the specified request and extracts stream + usage", async () => {
    const { calls, fetchStub } = stubFetch(() => streamResponse(anthropicEvents({ chunks: ["合計が", "出るので。"] })));
    const provider = createAnthropicProvider({ apiKey: "sk-test", model: "claude-opus-5-5", fallbackEnabled: true, fetch: fetchStub, maxRetries: 0 });

    const deltas: string[] = [];
    const result = await provider.streamReply({ systemPrompt: "あなたは山田です。", history, onText: (d) => void deltas.push(d) });

    expect(deltas).toEqual(["合計が", "出るので。"]);
    expect(result).toEqual({
      text: "合計が出るので。",
      inputTokens: 40,
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      outputTokens: 12,
      refused: false,
    });

    const [call] = calls;
    expect(call?.url).toContain("/v1/messages");
    expect(call?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(call?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call?.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      stream: true,
      output_config: { effort: "low" },
      fallbacks: "default",
      system: [{ type: "text", text: "あなたは山田です。", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "ご要望を教えてください" },
        { role: "assistant", content: "Scope3のその他に入れたいです。" },
        { role: "user", content: "なぜですか？" },
      ],
    });
    // 送ると400になるもの / things that would be a 400 on this model
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking"]) expect(call?.body).not.toHaveProperty(forbidden);
  });

  it("AI_FALLBACK=off や、対応しないモデルではフォールバックを付けない / no fallback when disabled or unsupported", async () => {
    for (const options of [
      { model: "claude-opus-5-5", fallbackEnabled: false },
      { model: "claude-haiku-5-5", fallbackEnabled: true },
    ]) {
      const { calls, fetchStub } = stubFetch(() => streamResponse(anthropicEvents({ chunks: ["はい"] })));
      const provider = createAnthropicProvider({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0, ...options });
      await provider.streamReply({ systemPrompt: "x", history, onText: () => {} });
      expect(calls[0]?.body, options.model).not.toHaveProperty("fallbacks");
      expect(calls[0]?.headers.get("anthropic-beta") ?? "", options.model).not.toContain("server-side-fallback");
    }
  });

  it("stop_reason が refusal なら断られた扱い / stop_reason refusal is reported as refused", async () => {
    const { fetchStub } = stubFetch(() => streamResponse(anthropicEvents({ chunks: [], stopReason: "refusal" })));
    const provider = createAnthropicProvider({ apiKey: "sk-test", model: "claude-opus-5-5", fallbackEnabled: true, fetch: fetchStub, maxRetries: 0 });
    const result = await provider.streamReply({ systemPrompt: "x", history, onText: () => {} });
    expect(result.refused).toBe(true);
    expect(result.text).toBe("");
  });

  it("別モデルへのやり直しが起きたら、途中までの本文を捨てて最後の返答だけを採る / a fallback hop discards the partial text", async () => {
    const fallbackBlock: [string, object][] = [
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ];
    // 本文ブロックのindexを1にずらす / shift the text block to index 1 after the fallback block
    const body = anthropicEvents({ chunks: ["やり直し後の返答"], beforeText: fallbackBlock })
      .replaceAll('"index":0,"content_block":{"type":"text"', '"index":1,"content_block":{"type":"text"')
      .replaceAll('"index":0,"delta"', '"index":1,"delta"')
      .replace('{"type":"content_block_stop","index":0}\n\nevent: message_delta', '{"type":"content_block_stop","index":1}\n\nevent: message_delta');
    const { fetchStub } = stubFetch(() => streamResponse(body));
    const provider = createAnthropicProvider({ apiKey: "sk-test", model: "claude-opus-5-5", fallbackEnabled: true, fetch: fetchStub, maxRetries: 0 });

    let resets = 0;
    const result = await provider.streamReply({ systemPrompt: "x", history, onText: () => {}, onReset: () => void resets++ });
    expect(resets).toBe(1);
    expect(result.text).toBe("やり直し後の返答");
  });

  it("エラーを混雑・設定の誤り・想定外に分ける / classifies errors", async () => {
    const run = async (status: number, body: object = { type: "error", error: { type: "x", message: "m" } }) => {
      const { fetchStub } = stubFetch(() => jsonResponse(status, body));
      const provider = createAnthropicProvider({ apiKey: "sk-test", model: "claude-opus-5-5", fallbackEnabled: true, fetch: fetchStub, maxRetries: 0 });
      return provider.streamReply({ systemPrompt: "x", history, onText: () => {} }).catch((error: unknown) => error);
    };

    expect(await run(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })).toMatchObject({ kind: "config" });
    expect(await run(403)).toMatchObject({ kind: "config" });
    expect(await run(404)).toMatchObject({ kind: "config" });
    expect(
      await run(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }),
    ).toMatchObject({ kind: "config" });
    expect(await run(429)).toMatchObject({ kind: "busy" });
    expect(await run(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toMatchObject({ kind: "busy" });
    expect(await run(500)).toMatchObject({ kind: "busy" });
    expect(await run(400)).toBeInstanceOf(ProviderFailure);
    expect(await run(400)).toMatchObject({ kind: "unknown" });
  });
});

describe("OpenAI", () => {
  const completed = (usage: object) => ({
    type: "response.completed",
    sequence_number: 9,
    response: { id: "resp_1", object: "response", status: "completed", usage },
  });

  it("Responses APIで会話を送り、逐次表示とトークン数（キャッシュ分を除く）を取り出す / streams via the Responses API and normalises usage", async () => {
    const body = sse([
      ["response.output_text.delta", { type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: "合計が", sequence_number: 1 }],
      ["response.output_text.delta", { type: "response.output_text.delta", item_id: "i", output_index: 0, content_index: 0, delta: "出るので。", sequence_number: 2 }],
      [
        "response.completed",
        completed({ input_tokens: 1000, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 }, output_tokens: 15, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1015 }),
      ],
    ]);
    const { calls, fetchStub } = stubFetch(() => streamResponse(body));
    const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-6.1-sol", fetch: fetchStub, maxRetries: 0 });

    const deltas: string[] = [];
    const result = await provider.streamReply({ systemPrompt: "あなたは山田です。", history, onText: (d) => void deltas.push(d) });

    expect(deltas).toEqual(["合計が", "出るので。"]);
    expect(result).toEqual({ text: "合計が出るので。", inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 15, refused: false });

    const [call] = calls;
    expect(call?.url).toContain("/responses");
    expect(call?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(call?.body).toMatchObject({
      model: "gpt-6.1-sol",
      instructions: "あなたは山田です。",
      stream: true,
      store: false,
      max_output_tokens: 16000,
      reasoning: { effort: "low" },
      input: [
        { role: "user", content: "ご要望を教えてください" },
        { role: "assistant", content: "Scope3のその他に入れたいです。" },
        { role: "user", content: "なぜですか？" },
      ],
    });
  });

  it("GPT-6系以外には reasoning を送らない / no reasoning parameter for non-GPT-6 models", async () => {
    const { calls, fetchStub } = stubFetch(() =>
      streamResponse(sse([["response.completed", completed({ input_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 })]])),
    );
    const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-4.1", fetch: fetchStub, maxRetries: 0 });
    await provider.streamReply({ systemPrompt: "x", history, onText: () => {} });
    expect(calls[0]?.body).not.toHaveProperty("reasoning");
  });

  it("断られた場合を検出する / detects refusals", async () => {
    const refusal = sse([
      ["response.refusal.delta", { type: "response.refusal.delta", item_id: "i", output_index: 0, content_index: 0, delta: "お答えできません", sequence_number: 1 }],
      ["response.completed", completed({ input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 })],
    ]);
    const filtered = sse([
      ["response.incomplete", { type: "response.incomplete", sequence_number: 1, response: { id: "r", object: "response", status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 10 } } }],
    ]);
    for (const body of [refusal, filtered]) {
      const { fetchStub } = stubFetch(() => streamResponse(body));
      const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-6.1-sol", fetch: fetchStub, maxRetries: 0 });
      expect((await provider.streamReply({ systemPrompt: "x", history, onText: () => {} })).refused).toBe(true);
    }
  });

  it("エラーを混雑・設定の誤り・想定外に分ける / classifies errors", async () => {
    const run = async (status: number, error: object = { message: "m", type: "x", code: null }) => {
      const { fetchStub } = stubFetch(() => jsonResponse(status, { error }));
      const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-6.1-sol", fetch: fetchStub, maxRetries: 0 });
      return provider.streamReply({ systemPrompt: "x", history, onText: () => {} }).catch((e: unknown) => e);
    };
    expect(await run(401)).toMatchObject({ kind: "config" });
    expect(await run(404)).toMatchObject({ kind: "config" });
    expect(await run(429, { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" })).toMatchObject({ kind: "config" });
    expect(await run(429)).toMatchObject({ kind: "busy" });
    expect(await run(503)).toMatchObject({ kind: "busy" });
    expect(await run(400)).toMatchObject({ kind: "unknown" });
  });
});
