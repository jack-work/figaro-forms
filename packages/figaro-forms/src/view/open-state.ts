import type { Path } from "../path.js";

export interface OpenStateOptions {
  readonly channel?: string;
  readonly BroadcastChannel?: typeof BroadcastChannel;
}

type Message =
  | { readonly t: "set"; readonly k: string; readonly open: boolean | null }
  | { readonly t: "hello" }
  | { readonly t: "state"; readonly entries: readonly (readonly [string, boolean])[] };

export class OpenState {
  private readonly open = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();
  private readonly bc: BroadcastChannel | undefined;
  private rev = 0;

  constructor(o: OpenStateOptions = {}) {
    const BC = o.BroadcastChannel ?? (globalThis.BroadcastChannel as typeof BroadcastChannel | undefined);
    if (o.channel && BC) {
      this.bc = new BC(o.channel);
      this.bc.onmessage = (e: MessageEvent<Message>) => this.receive(e.data);
      this.bc.postMessage({ t: "hello" } satisfies Message);
    }
  }

  get version(): number {
    return this.rev;
  }

  get(path: Path): boolean | undefined {
    return this.open.get(JSON.stringify(path));
  }

  readonly isOpen = (path: Path): boolean | undefined => this.get(path);

  set(path: Path, open: boolean | null): void {
    const k = JSON.stringify(path);
    if (!this.apply(k, open)) return;
    this.bc?.postMessage({ t: "set", k, open } satisfies Message);
  }

  toggle(path: Path, current: boolean): void {
    this.set(path, !current);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  entries(): [Path, boolean][] {
    return [...this.open].map(([k, v]) => [JSON.parse(k) as Path, v]);
  }

  close(): void {
    this.bc?.close();
    this.listeners.clear();
  }

  private apply(k: string, open: boolean | null): boolean {
    const had = this.open.get(k);
    if (open === null) {
      if (had === undefined) return false;
      this.open.delete(k);
    } else {
      if (had === open) return false;
      this.open.set(k, open);
    }
    this.changed();
    return true;
  }

  private changed(): void {
    this.rev++;
    for (const fn of [...this.listeners]) fn();
  }

  private receive(m: Message): void {
    switch (m.t) {
      case "set":
        this.apply(m.k, m.open);
        return;
      case "hello":
        if (this.open.size > 0) this.bc?.postMessage({ t: "state", entries: [...this.open] } satisfies Message);
        return;
      case "state": {
        let changed = false;
        for (const [k, v] of m.entries) {
          if (!this.open.has(k)) {
            this.open.set(k, v);
            changed = true;
          }
        }
        if (changed) this.changed();
      }
    }
  }
}
