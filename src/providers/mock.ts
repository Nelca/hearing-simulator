import { ProviderFailure, type ChatProvider } from "./types.js";

// APIキー無しで画面と上限・エラーの動きを確かめるための偽のAI。AI_PROVIDER=mock のときだけ使われる
// A fake AI for checking the UI, limits and error paths without an API key. Used only with AI_PROVIDER=mock.
//
// 発言に次の合図を入れると、対応するエラーを起こす / Put a marker in a message to trigger the matching path:
//   [[busy]] 混雑 / [[config]] 設定エラー / [[refuse]] 断られた / [[slow]] ゆっくり返す
export function createMockProvider(delayMs = 15): ChatProvider {
  return {
    async streamReply({ systemPrompt, history, onText, signal }) {
      const last = history.at(-1)?.text ?? "";
      if (last.includes("[[busy]]")) throw new ProviderFailure("busy", "mock: busy");
      if (last.includes("[[config]]")) throw new ProviderFailure("config", "mock: invalid api key");

      const inputTokens = Math.ceil((systemPrompt.length + history.reduce((sum, turn) => sum + turn.text.length, 0)) / 2);

      if (last.includes("[[refuse]]")) {
        return { text: "", inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, refused: true };
      }

      const persona = systemPrompt.includes("課長、山田です") ? "山田" : "佐藤";
      const reply = `（モック）${persona}です。「${last.slice(0, 40)}」についてですね。これは動作確認用の返答です。`;
      const pause = last.includes("[[slow]]") ? delayMs * 40 : delayMs;

      let text = "";
      for (const chunk of reply.match(/.{1,6}/gu) ?? []) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        text += chunk;
        await onText(chunk);
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
      return { text, inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: Math.ceil(text.length / 2), refused: false };
    },
  };
}
