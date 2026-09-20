// ============================================================
// DeepBook Trading Agent — Receipt Nonce Replay Store
// Port of cubiczan-chp-mcp `src/replay.ts` (via the
// cognitrader-bsc merged port, including its JSONL persistence): a
// receipt is single-use. Replaying the same nonce — even with a
// valid MAC and unexpired window — is a deny.
// ============================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

export const REPLAY_LOG_ENV = 'DEEPBOOK_CHP_REPLAY_LOG';

export interface ReplayRecord {
  nonce: string;
  consumedAt: string;
  argsHash: string;
  tool: string;
  resource: string;
}

export interface ReplayStore {
  seen(nonce: string): boolean;
  consume(record: ReplayRecord): void;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly used = new Map<string, ReplayRecord>();

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(record: ReplayRecord): void {
    this.used.set(record.nonce, record);
  }

  get(nonce: string): ReplayRecord | undefined {
    return this.used.get(nonce);
  }

  get size(): number {
    return this.used.size;
  }
}

/**
 * JSONL-backed replay store: consumed nonces survive a process restart, so
 * a receipt issued before a restart cannot be replayed within its TTL (the
 * in-memory store forgets them — the same review finding cognitrader-bsc
 * fixed). Append-only, one JSON record per line, stored under `state/`.
 * A missing or corrupt file starts empty (worst case: a stale nonce is
 * forgotten — never a false deny); entries past a receipt TTL are harmless
 * to keep.
 */
export class FileReplayStore implements ReplayStore {
  private readonly used = new Map<string, ReplayRecord>();

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    try {
      for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const record = JSON.parse(trimmed) as ReplayRecord;
          if (typeof record.nonce === 'string' && record.nonce.trim() !== '') {
            this.used.set(record.nonce, record);
          }
        } catch {
          console.warn(`[chp] replay log ${this.filePath}: skipping corrupt line`);
        }
      }
    } catch (error) {
      console.warn(
        `[chp] replay log ${this.filePath} unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(record: ReplayRecord): void {
    this.used.set(record.nonce, record);
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      // The in-memory set is already updated: this process will not replay.
      // Persistence failures surface loudly instead of being swallowed — a
      // silent gap in the replay log is a cross-restart replay risk.
      console.error(
        `[chp] replay log ${this.filePath} write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Default replay-log path, overridable via $DEEPBOOK_CHP_REPLAY_LOG. */
export function defaultReplayLogPath(): string {
  return process.env[REPLAY_LOG_ENV] ?? path.join('state', 'replay-nonces.jsonl');
}
