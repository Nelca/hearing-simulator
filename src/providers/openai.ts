import OpenAI from "openai";
import { ProviderFailure, type ChatProvider } from "./types.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  /** テスト用の差し替え口 / Test seams: swap the HTTP layer and disable retries */
  fetch?: typeof fetch;
  maxRetries?: number;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ChatProvider {
  const client = new OpenAI({ apiKey: options.apiKey, fetch: options.fetch, maxRetries: options.maxRetries });
  // 推論の深さを指定できるのはGPT-6系。他のモデルに送ると400になるので付けない
  // Only the GPT-6 family takes a reasoning effort here; other models would reject it
  const reasoning = options.model.startsWith("gpt-6") ? ({ effort: "low" } as const) : undefined;

  return {
    async streamReply({ systemPrompt, history, onText, signal }) {
      try {
        const stream = await client.responses.create(
          {
            model: options.model,
            instructions: systemPrompt,
            input: history.map((turn) => ({ role: turn.role, content: turn.text })),
            max_output_tokens: 16000,
            ...(reasoning ? { reasoning } : {}),
            // 会話をOpenAI側に保存しない / Do not store the conversation on OpenAI's side
            store: false,
            stream: true,
          },
          { signal },
        );

        let text = "";
        let refused = false;
        let inputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let outputTokens = 0;

        const addUsage = (usage: OpenAI.Responses.ResponseUsage | undefined) => {
          if (!usage) return;
          cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
          cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
          // OpenAIの input_tokens はキャッシュ分を含むので、Claudeと同じ「キャッシュに触れなかった入力」に揃える
          // OpenAI's input_tokens includes cached tokens; normalise to "uncached input" like the Claude provider
          inputTokens = Math.max(0, usage.input_tokens - cacheReadTokens - cacheWriteTokens);
          outputTokens = usage.output_tokens;
        };

        for await (const event of stream) {
          switch (event.type) {
            case "response.output_text.delta":
              text += event.delta;
              await onText(event.delta);
              break;
            case "response.refusal.delta":
              refused = true;
              break;
            case "response.completed":
              addUsage(event.response.usage);
              break;
            case "response.incomplete":
              addUsage(event.response.usage);
              if (event.response.incomplete_details?.reason === "content_filter") refused = true;
              break;
            case "response.failed":
              throw new ProviderFailure("unknown", event.response.error?.message ?? "OpenAI response failed");
            default:
              break;
          }
        }

        return { text, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, refused };
      } catch (error) {
        throw classifyOpenAIError(error);
      }
    },
  };
}

export function classifyOpenAIError(error: unknown): unknown {
  if (error instanceof OpenAI.APIUserAbortError) return error;
  if (error instanceof ProviderFailure) return error;

  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof OpenAI.NotFoundError
  ) {
    return new ProviderFailure("config", `OpenAI rejected the request (${error.status}): ${error.message}`, { cause: error });
  }
  // 残高・クォータ不足は429で返ってくるが、待っても直らない / Exhausted quota arrives as 429 but waiting will not fix it
  if (error instanceof OpenAI.RateLimitError && error.code === "insufficient_quota") {
    return new ProviderFailure("config", `OpenAI quota problem: ${error.message}`, { cause: error });
  }
  if (
    error instanceof OpenAI.RateLimitError ||
    error instanceof OpenAI.InternalServerError ||
    error instanceof OpenAI.APIConnectionError
  ) {
    return new ProviderFailure("busy", `OpenAI is busy or unreachable: ${error.message}`, { cause: error });
  }
  return new ProviderFailure("unknown", error instanceof Error ? error.message : String(error), { cause: error });
}
