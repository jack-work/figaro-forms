import type { Dial } from "figaro-forms";

export interface ClientCredentialsOptions {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly secret: () => string;
  readonly audience?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly refreshAt?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
}

interface Held {
  readonly value: string;
  expiresAt: number;
}

const skewMs = 5_000;

export class ClientCredentials {
  private held: Held | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  private failures = 0;
  private minted = 0;
  private closed = false;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: ClientCredentialsOptions) {
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  async start(): Promise<void> {
    await this.mint();
  }

  async token(): Promise<string> {
    if (!this.held || this.now() >= this.held.expiresAt - skewMs) await this.mint();
    return (this.held as Held).value;
  }

  get generation(): number {
    return this.minted;
  }

  rejected(generation: number): void {
    if (this.held && this.minted === generation) this.held.expiresAt = 0;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private mint(): Promise<void> {
    this.inflight ??= this.request().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async request(): Promise<void> {
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.o.audience) form.set("audience", this.o.audience);
    let secret: string;
    try {
      secret = this.o.secret();
    } catch (e) {
      throw this.failed(`client secret unreadable: ${e instanceof Error ? e.message.replace(/'[^']*'/g, "'<path>'") : "error"}`);
    }
    const basic = Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(secret)}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchFn(this.o.tokenUrl, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form,
      });
    } catch (e) {
      throw this.failed(`token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw this.failed(`token endpoint answered ${res.status}`);
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw this.failed("token endpoint answered something that is not JSON");
    }
    const value = body.access_token;
    const lifetime = Number(body.expires_in);
    if (typeof value !== "string" || value === "" || !Number.isFinite(lifetime) || lifetime <= 0) throw this.failed("token endpoint answered without access_token and expires_in");
    this.held = { value, expiresAt: this.now() + lifetime * 1000 };
    this.minted++;
    this.failures = 0;
    this.schedule(lifetime * 1000 * (this.o.refreshAt ?? 0.8));
  }

  private failed(why: string): Error {
    this.log(`${why}${this.held && this.now() < this.held.expiresAt ? "; keeping the token it has until it expires" : ""}`);
    if (!this.closed && this.held) {
      const min = this.o.retryMinMs ?? 1_000;
      const max = this.o.retryMaxMs ?? 60_000;
      this.schedule(Math.min(min * 2 ** this.failures, max));
    }
    this.failures++;
    return new Error(why);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.mint().catch(() => {});
    }, ms);
    this.timer.unref?.();
  }
}

export function redialAfterRejection(dial: Dial, rejected: (generation: number) => void, generation: () => number): Dial {
  return async (events) => {
    const used = generation();
    try {
      return await dial(events);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      rejected(used);
      return dial(events);
    }
  };
}

export interface DoorTokenSource {
  flag?: string | undefined;
  credentialsDirectory?: string | undefined;
  tokenMode: boolean;
  exists: (path: string) => boolean;
}

export function doorTokenPath(s: DoorTokenSource): string | undefined {
  if (s.tokenMode) {
    if (s.flag) throw new Error("--token-url and --door-token-file are alternatives");
    return undefined;
  }
  if (s.flag) return s.flag;
  if (!s.credentialsDirectory) return undefined;
  const path = `${s.credentialsDirectory}/door`;
  return s.exists(path) ? path : undefined;
}
