import { isRecord } from "../json.js";
import type { HierarchyOrder, HierarchyReply } from "./project.js";

export type HierarchyStatus = "loading" | "resyncing" | "current" | "empty" | "denied" | "signedout" | "unavailable" | "closed";

export interface HierarchyState {
  readonly status: HierarchyStatus;
  readonly orders: readonly HierarchyOrder[];
  readonly observedAt?: number;
  readonly reason?: string;
}

type Fetch = (url: string, init: { headers: Record<string, string>; credentials: "same-origin"; cache: "no-store" }) => Promise<{
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface HierarchyFeedOptions {
  readonly url: string | URL;
  readonly headers?: () => Record<string, string> | Promise<Record<string, string>>;
  readonly fetch?: Fetch;
}

const none: readonly HierarchyOrder[] = Object.freeze([]);

export class HierarchyFeed {
  private current: HierarchyState = { status: "loading", orders: none };
  private generation = 0;
  private readonly listeners = new Set<(s: HierarchyState) => void>();

  constructor(private readonly o: HierarchyFeedOptions) {}

  get state(): HierarchyState {
    return this.current;
  }

  subscribe(fn: (s: HierarchyState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async refresh(): Promise<HierarchyState> {
    if (this.current.status === "closed") return this.current;
    const gen = ++this.generation;
    this.set({ status: this.current.status === "loading" ? "loading" : "resyncing", orders: none });
    let next: HierarchyState;
    try {
      const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
      const headers = { Accept: "application/json", ...((await this.o.headers?.()) ?? {}) };
      const res = await f(String(this.o.url), { headers, credentials: "same-origin", cache: "no-store" });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      next = stateOf(res.status, body);
    } catch (e) {
      next = { status: "unavailable", orders: none, reason: e instanceof Error ? e.message : String(e) };
    }
    if (gen === this.generation) this.set(next);
    return this.current;
  }

  withdraw(status: "signedout" | "denied" = "signedout"): void {
    if (this.current.status === "closed") return;
    this.generation++;
    this.set({ status, orders: none });
  }

  close(): void {
    this.generation++;
    this.set({ status: "closed", orders: none });
    this.listeners.clear();
  }

  private set(s: HierarchyState): void {
    this.current = s;
    for (const fn of [...this.listeners]) fn(s);
  }
}

export function stateOf(code: number, body: unknown): HierarchyState {
  const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
  const refused = (status: HierarchyStatus): HierarchyState => ({ status, orders: none, ...(reason !== undefined ? { reason } : {}) });
  if (code === 401) return refused("signedout");
  if (code === 403 || code === 404) return refused("denied");
  if (code !== 200 || !isRecord(body)) return refused("unavailable");
  const r = body as Partial<HierarchyReply> & Record<string, unknown>;
  if (r.status === "empty" && typeof r.observed_at === "number") return { status: "empty", orders: none, observedAt: r.observed_at };
  if (r.status === "current" && typeof r.observed_at === "number" && Array.isArray(r.orders) && r.orders.length > 0 && r.orders.every(wellFormed)) {
    return { status: "current", orders: r.orders as HierarchyOrder[], observedAt: r.observed_at };
  }
  return { status: "unavailable", orders: none, reason: "malformed hierarchy reply" };
}

function wellFormed(o: unknown): boolean {
  if (!isRecord(o) || typeof o.root !== "string" || !Array.isArray(o.forms) || !Array.isArray(o.arias) || !isRecord(o.topology)) return false;
  const ids = new Set<string>();
  for (const f of o.forms) {
    if (!isRecord(f) || typeof f.id !== "string" || !isRecord(f.state) || (f.parent !== null && typeof f.parent !== "string")) return false;
    ids.add(f.id);
  }
  if (!ids.has(o.root)) return false;
  for (const f of o.forms as Record<string, unknown>[]) if (f.parent !== null && !ids.has(f.parent as string)) return false;
  return o.arias.every((a) => isRecord(a) && typeof a.id === "string" && typeof a.state === "string");
}
