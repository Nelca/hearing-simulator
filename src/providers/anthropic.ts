import Anthropic from "@anthropic-ai/sdk";
import { ProviderFailure, type ChatProvider, type StreamReplyResult } from "./types.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** サーバー側フォールバック（ベータ）を使うか / Whether to opt in to server-side fallbacks (beta) */
  fallbackEnabled: boolean;
  /** テスト用の差し替え口 / Test seams: swap the HTTP layer and disable retries */
  fetch?: typeof fetch;
  maxRetries?: number;
}

// サーバー側フォールバックはこの系統のモデルだけが受け付ける。Haiku などに付けると効かないか400になる
// Only these model families accept server-side fallbacks; Haiku and others would ignore or reject them
const FALLBACK_CAPABLE = [/^claude-opus-5/, /^claude-sonnet-5-5/, /^claude-fable-5/];

export function createAnthropicProvider(options: AnthropicProviderOptions): ChatProvider {
  const client = new Anthropic({ apiKey: options.apiKey, fetch: options.fetch, maxRetries: options.maxRetries });
  const useFallback = options.fallbackEnabled && FALLBACK_CAPABLE.some((pattern) => pattern.test(options.model));

  return {
    async streamReply({ systemPrompt, history, onText, onReset, signal }) {
      try {
        const stream = client.beta.messages.stream(
          {
            model: options.model,
            max_tokens: 16000,
            // 受け答えなので深く考えさせない。速さと料金を優先する / Conversational replies: favour speed and cost over depth
            output_config: { effort: "low" },
            ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
            // 同じ人物設定を毎回送るのでキャッシュする。日時などを混ぜるとキャッシュが効かなくなる
            // The same persona is sent every turn, so cache it. Embedding timestamps would defeat the cache.
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
            messages: history.map((turn) => ({ role: turn.role, content: turn.text })),
          },
          { signal },
        );

        for await (const event of stream) {
          if (event.type === "content_block_start" && event.content_block.type === "fallback") {
            await onReset?.();
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            await onText(event.delta.text);
          }
        }

        const message = await stream.finalMessage();

        // フォールバックが起きたら、最後の切り替え以降の本文だけが正しい返答
        // After a fallback switch, only the text following the last switch is the real reply
        let text = "";
        for (const block of message.content) {
          if (block.type === "fallback") text = "";
          else if (block.type === "text") text += block.text;
        }

        return {
          text,
          inputTokens: message.usage.input_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          refused: message.stop_reason === "refusal",
        } satisfies StreamReplyResult;
      } catch (error) {
        throw classifyAnthropicError(error);
      }
    },
  };
}

export function classifyAnthropicError(error: unknown): unknown {
  // ブラウザの切断による中断はそのまま上へ渡す / Pass client-abort through untouched
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof ProviderFailure) return error;

  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError
  ) {
    return new ProviderFailure("config", `Anthropic rejected the request (${error.status}): ${error.message}`, { cause: error });
  }
  // 残高不足は400で返ってくる / A low credit balance comes back as a 400
  if (error instanceof Anthropic.BadRequestError && /credit balance|billing|plans? & billing/i.test(error.message)) {
    return new ProviderFailure("config", `Anthropic credit problem: ${error.message}`, { cause: error });
  }
  if (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return new ProviderFailure("busy", `Anthropic is busy or unreachable: ${error.message}`, { cause: error });
  }
  return new ProviderFailure("unknown", error instanceof Error ? error.message : String(error), { cause: error });
}
