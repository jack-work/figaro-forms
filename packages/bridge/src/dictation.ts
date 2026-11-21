import { request } from "node:http";

export interface DictationOptions {
  readonly socket: string;
  readonly store: string;
  readonly log?: (line: string) => void;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const audioIdPattern = /^[0-9]{6}-[0-9a-f]{16}$/;
const aria = /^[0-9a-f]{32}$/;

export class Dictations {
  private readonly heard = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: DictationOptions) {
    this.now = o.now ?? Date.now;
  }

  private sweep(): void {
    const cut = this.now() - (this.o.ttlMs ?? 10 * 60_000);
    for (const [k, at] of this.heard) if (at < cut) this.heard.delete(k);
  }

  done(session: string, forAria: string, id: string): void {
    if (session === "-" || !aria.test(forAria) || !audioIdPattern.test(id)) return;
    this.sweep();
    this.heard.set(`${session}\u0000${forAria}\u0000${id}`, this.now());
  }

  holds(session: string, forAria: string, id: string): boolean {
    this.sweep();
    return this.heard.has(`${session}\u0000${forAria}\u0000${id}`);
  }

  async turnOpened(session: string, forAria: string, turn: number, id: string): Promise<boolean> {
    const k = `${session}\u0000${forAria}\u0000${id}`;
    if (!this.heard.has(k) || !Number.isSafeInteger(turn) || turn < 1) return false;
    this.heard.delete(k);
    const key = `${this.o.store}/${forAria}:${turn}/in`;
    const status = await new Promise<number>((ok) => {
      const req = request({ socketPath: this.o.socket, method: "POST", path: `/audio/${encodeURIComponent(id)}/key?key=${encodeURIComponent(key)}`, headers: { "Content-Length": 0 }, timeout: 10_000 }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.once("timeout", () => req.destroy(new Error("timed out")));
      req.once("error", () => ok(0));
      req.end();
    });
    this.o.log?.(`dictation ${status === 200 ? "keyed" : `not keyed (${status || "unreachable"})`} audio_id=${id} key=${key} session=${session}`);
    return status === 200;
  }
}
