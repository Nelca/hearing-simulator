import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store/index.js";

export interface LogEntry {
  ts: string;
  participantId: string;
  name: string;
  personaId: string;
  type: "message" | "reset" | "refused" | "error";
  role?: "user" | "assistant";
  text?: string;
  turn?: number;
  detail?: string;
}

// 講師が後で振り返るための追記専用の記録。「やり直す」で会話を消しても残る
// Append-only record for the instructor's review. It survives "reset" (which clears the live conversation).
export interface LogSink {
  append(date: string, entry: LogEntry): Promise<void>;
  /** その日のログ全体をJSONLで返す（時刻順）/ The whole day's log as JSONL, in time order */
  readDay(date: string): Promise<string>;
}

/** ファイル名に使える形にする。パスの区切りやドットは残さない / Make a name safe for file names: no separators or dots survive */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return cleaned || "anonymous";
}

function sortLines(lines: string[]): string {
  const keyed = lines.map((line) => {
    try {
      return { line, ts: String((JSON.parse(line) as { ts?: string }).ts ?? "") };
    } catch {
      return { line, ts: "" };
    }
  });
  keyed.sort((a, b) => a.ts.localeCompare(b.ts));
  return keyed.map((entry) => `${entry.line}\n`).join("");
}

// ローカル実行用: LOG_DIR/日付/参加者名_相手ID.jsonl / Local runs: LOG_DIR/date/name_personaId.jsonl
export class FileLogSink implements LogSink {
  constructor(private readonly logDir: string) {}

  async append(date: string, entry: LogEntry): Promise<void> {
    const dir = join(this.logDir, date);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${safeFileName(entry.name)}_${entry.personaId}.jsonl`), `${JSON.stringify(entry)}\n`);
  }

  async readDay(date: string): Promise<string> {
    const dir = join(this.logDir, date);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return "";
    }
    const lines: string[] = [];
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const content = await readFile(join(dir, file), "utf8");
      lines.push(...content.split("\n").filter(Boolean));
    }
    return sortLines(lines);
  }
}

// Vercel 用: 関数のファイルシステムは消えるので、Redis のリストに追記する
// Vercel: a function's filesystem is ephemeral, so append to Redis lists instead
export class StoreLogSink implements LogSink {
  constructor(
    private readonly store: Store,
    private readonly ttlSeconds: number,
  ) {}

  async append(date: string, entry: LogEntry): Promise<void> {
    const key = `log:${date}:${safeFileName(entry.name)}_${entry.personaId}`;
    await this.store.rpush(key, JSON.stringify(entry), this.ttlSeconds);
    await this.store.sadd(`logkeys:${date}`, key, this.ttlSeconds);
  }

  async readDay(date: string): Promise<string> {
    const keys = await this.store.smembers(`logkeys:${date}`);
    const lines = (await Promise.all(keys.map((key) => this.store.lrange(key)))).flat();
    return sortLines(lines);
  }
}

export class MemoryLogSink implements LogSink {
  readonly entries: { date: string; entry: LogEntry }[] = [];

  async append(date: string, entry: LogEntry): Promise<void> {
    this.entries.push({ date, entry });
  }

  async readDay(date: string): Promise<string> {
    return sortLines(this.entries.filter((row) => row.date === date).map((row) => JSON.stringify(row.entry)));
  }
}
