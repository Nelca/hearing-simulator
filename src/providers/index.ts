import type { Config } from "../config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createMockProvider } from "./mock.js";
import { createOpenAIProvider } from "./openai.js";
import type { ChatProvider } from "./types.js";

export type { ChatProvider, ChatTurn, StreamReplyInput, StreamReplyResult } from "./types.js";
export { ProviderFailure } from "./types.js";

export function createProvider(config: Config): ChatProvider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider({
        apiKey: config.apiKey ?? "",
        model: config.model,
        fallbackEnabled: config.fallbackEnabled,
      });
    case "openai":
      return createOpenAIProvider({ apiKey: config.apiKey ?? "", model: config.model });
    case "mock":
      return createMockProvider();
  }
}
