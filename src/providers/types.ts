export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface StreamReplyInput {
  systemPrompt: string;
  history: ChatTurn[];
  /** 返答の断片が届くたびに呼ぶ / Called for every chunk of the reply */
  onText: (delta: string) => void | Promise<void>;
  /** 別モデルへのやり直しで、ここまでの断片を捨てるときに呼ぶ / Called when partial text must be discarded (e.g. fallback retry) */
  onReset?: () => void | Promise<void>;
  /** ブラウザが切断されたら生成を止める / Abort generation when the browser disconnects */
  signal?: AbortSignal;
}

export interface StreamReplyResult {
  text: string;
  /** キャッシュに触れなかった入力トークン / Input tokens that did not touch the cache */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  refused: boolean;
}

// 提供元ごとの差を吸収する / Hide provider differences behind one function
export interface ChatProvider {
  streamReply(input: StreamReplyInput): Promise<StreamReplyResult>;
}

export type ProviderFailureKind =
  /** 混雑・一時的な失敗。少し待てば直る / Overload or transient failure */
  | "busy"
  /** APIキーの誤り・残高不足など、講師の対応が要るもの / Bad key, no credit, wrong model: the instructor must act */
  | "config"
  | "unknown";

export class ProviderFailure extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderFailure";
  }
}
