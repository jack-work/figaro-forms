import type { FormsClient } from "../client.js";
import type { Freshness, Replica } from "../replica.js";
import type { AriaClient } from "./client.js";

export const worst = (a: Freshness, b: Freshness): Freshness => (a === "stale" || b === "stale" ? "stale" : a === "resyncing" || b === "resyncing" ? "resyncing" : "current");

export abstract class Feed<T> {
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | undefined;
  protected value: T;

  constructor(initial: T) {
    this.value = initial;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.stop = this.open();
    return () => {
      if (!this.listeners.delete(fn) || this.listeners.size > 0) return;
      this.stop?.();
      this.stop = undefined;
    };
  };

  readonly get = (): T => this.value;

  protected publish(next: T): void {
    this.value = next;
    for (const fn of [...this.listeners]) fn();
  }

  protected abstract open(): () => void;
}

export class ReplicaFeed<T> extends Feed<T> {
  constructor(
    private readonly forms: () => FormsClient,
    private readonly ref: string,
    private readonly derive: (r: Replica) => T,
    initial: T,
  ) {
    super(initial);
  }

  protected open(): () => void {
    const forms = this.forms();
    const r = forms.retain(this.ref);
    const update = (): void => this.publish(this.derive(r));
    const offTree = r.subscribe([], update);
    const offStatus = r.onStatus(update);
    update();
    return () => {
      offTree();
      offStatus();
      forms.release(this.ref);
    };
  }
}

export const idle = { ready: false, freshness: "stale" as Freshness, error: undefined };

export const errorOf = (r: Replica): string | undefined => r.status.error;
export const readyOf = (r: Replica): boolean => r.status.phase === "ready" && r.status.freshness === "current";

const registries = new WeakMap<AriaClient, Map<string, Feed<never>>>();

export function feedOf<T>(client: AriaClient, key: string, make: () => Feed<T>): Feed<T> {
  let m = registries.get(client);
  if (!m) {
    m = new Map();
    registries.set(client, m);
  }
  let f = m.get(key) as Feed<T> | undefined;
  if (!f) {
    f = make();
    m.set(key, f as Feed<never>);
  }
  return f;
}
