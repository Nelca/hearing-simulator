import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { UsageTotals } from "./pricing.js";
import type { Store } from "./store/index.js";

export interface Participant {
  id: string;
  name: string;
  createdAt: string;
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

// 会話の履歴はサーバーだけが持つ。ブラウザは今回の発言しか送れない
// Only the server holds history; the browser can send nothing but the current message
export interface Conversation {
  participantId: string;
  personaId: string;
  messages: StoredMessage[];
  turns: number;
  createdAt: string;
  lastAt: string;
}

export interface UsageSnapshot extends UsageTotals {
  requests: number;
  /** 入力（キャッシュ分を含む）＋出力。1日の上限の判定に使う / Input (incl. cached) + output; used for the daily limit */
  totalTokens: number;
}

export interface ProviderErrorRecord {
  message: string;
  at: string;
}

const LOCK_SECONDS = 180;
const FLAG_SECONDS = 7 * 24 * 60 * 60;

export class SessionService {
  constructor(
    private readonly store: Store,
    private readonly config: Pick<Config, "dataTtlSeconds" | "timeZone">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 「その日」の区切り（設定のタイムゾーン）/ Calendar day in the configured time zone */
  dateKey(at: Date = this.now()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.config.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private setJson(key: string, value: unknown, ttlSeconds: number = this.config.dataTtlSeconds): Promise<void> {
    return this.store.set(key, JSON.stringify(value), ttlSeconds);
  }

  // --- 参加者 / Participants ---

  async createParticipant(name: string): Promise<Participant> {
    const participant: Participant = { id: randomUUID(), name, createdAt: this.now().toISOString() };
    await this.setJson(`participant:${participant.id}`, participant);
    return participant;
  }

  getParticipant(id: string): Promise<Participant | null> {
    return this.getJson<Participant>(`participant:${id}`);
  }

  // --- 会話 / Conversations ---

  private conversationKey(participantId: string, personaId: string): string {
    return `conv:${participantId}:${personaId}`;
  }

  getConversation(participantId: string, personaId: string): Promise<Conversation | null> {
    return this.getJson<Conversation>(this.conversationKey(participantId, personaId));
  }

  newConversation(participantId: string, personaId: string): Conversation {
    const at = this.now().toISOString();
    return { participantId, personaId, messages: [], turns: 0, createdAt: at, lastAt: at };
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.setJson(this.conversationKey(conversation.participantId, conversation.personaId), conversation);
    await this.store.sadd("convs", `${conversation.participantId}|${conversation.personaId}`, this.config.dataTtlSeconds);
  }

  deleteConversation(participantId: string, personaId: string): Promise<void> {
    return this.store.del(this.conversationKey(participantId, personaId));
  }

  /** 同じ会話に同時に発言させない（複数タブ・二重送信の対策）/ Serialise turns per conversation (multiple tabs, double submits) */
  lockConversation(participantId: string, personaId: string): Promise<boolean> {
    return this.store.setIfAbsent(`lock:${participantId}:${personaId}`, "1", LOCK_SECONDS);
  }

  unlockConversation(participantId: string, personaId: string): Promise<void> {
    return this.store.del(`lock:${participantId}:${personaId}`);
  }

  async listConversations(): Promise<{ participant: Participant; conversation: Conversation }[]> {
    const members = await this.store.smembers("convs");
    const rows = await Promise.all(
      members.map(async (member) => {
        const [participantId, personaId] = member.split("|");
        if (!participantId || !personaId) return null;
        const [participant, conversation] = await Promise.all([
          this.getParticipant(participantId),
          this.getConversation(participantId, personaId),
        ]);
        return participant && conversation ? { participant, conversation } : null;
      }),
    );
    return rows
      .filter((row): row is { participant: Participant; conversation: Conversation } => row !== null)
      .sort((a, b) => b.conversation.lastAt.localeCompare(a.conversation.lastAt));
  }

  // --- 使用量 / Usage ---

  async recordUsage(usage: UsageTotals): Promise<void> {
    const day = this.dateKey();
    const ttl = this.config.dataTtlSeconds;
    await Promise.all([
      this.store.incrBy(`usage:${day}:input`, usage.inputTokens, ttl),
      this.store.incrBy(`usage:${day}:cacheRead`, usage.cacheReadTokens, ttl),
      this.store.incrBy(`usage:${day}:cacheWrite`, usage.cacheWriteTokens, ttl),
      this.store.incrBy(`usage:${day}:output`, usage.outputTokens, ttl),
      this.store.incrBy(`usage:${day}:requests`, 1, ttl),
    ]);
  }

  async getUsage(day: string = this.dateKey()): Promise<UsageSnapshot> {
    const read = async (field: string) => Number((await this.store.get(`usage:${day}:${field}`)) ?? 0);
    const [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, requests] = await Promise.all([
      read("input"),
      read("cacheRead"),
      read("cacheWrite"),
      read("output"),
      read("requests"),
    ]);
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      requests,
      totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    };
  }

  // --- 停止・エラーの旗 / Flags ---

  async isStopped(): Promise<boolean> {
    return (await this.store.get("flag:stopped")) === "1";
  }

  async setStopped(stopped: boolean): Promise<void> {
    if (stopped) await this.store.set("flag:stopped", "1", FLAG_SECONDS);
    else await this.store.del("flag:stopped");
  }

  setProviderError(message: string): Promise<void> {
    const record: ProviderErrorRecord = { message, at: this.now().toISOString() };
    return this.setJson("flag:providerError", record, 60 * 60);
  }

  clearProviderError(): Promise<void> {
    return this.store.del("flag:providerError");
  }

  getProviderError(): Promise<ProviderErrorRecord | null> {
    return this.getJson<ProviderErrorRecord>("flag:providerError");
  }
}
