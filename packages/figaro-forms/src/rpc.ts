import type { Json } from "./json.js";

export interface Socket {
  send(frame: string): void;
  close(): void;
}

export interface SocketEvents {
  message(frame: string): void;
  closed(reason: string): void;
}

export type Dial = (events: SocketEvents) => Promise<Socket>;

export class RpcError extends Error {
  readonly code: number;
  readonly data: Json | undefined;

  constructor(code: number, message: string, data?: Json) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class ConnectionLost extends Error {
  constructor(reason: string) {
    super(`connection lost: ${reason}`);
    this.name = "ConnectionLost";
  }
}

export class CallTimeout extends Error {
  constructor(method: string, ms: number) {
    super(`${method}: no answer in ${ms} ms`);
    this.name = "CallTimeout";
  }
}

export type ConnectionState = "connecting" | "open" | "waiting" | "closed";

export interface ConnectionOptions {
  readonly dial: Dial;
  readonly callTimeoutMs?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  readonly onOpen?: (conn: Connection) => Promise<void> | void;
}

type Notify = (params: Json) => void;

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Frame {
  id?: number | string | null;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
}

export class Connection {
  private readonly opts: Required<Omit<ConnectionOptions, "onOpen">> & Pick<ConnectionOptions, "onOpen">;
  private socket: Socket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<Notify>>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private waiters: { resolve(): void; reject(e: unknown): void }[] = [];
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private current: ConnectionState = "connecting";
  private lastError = "";
  private generation = 0;

  constructor(opts: ConnectionOptions) {
    this.opts = {
      callTimeoutMs: 10_000,
      retryMinMs: 250,
      retryMaxMs: 10_000,
      ...opts,
    };
    void this.connect();
  }

  get state(): ConnectionState {
    return this.current;
  }

  get live(): boolean {
    return this.socket !== undefined;
  }

  get error(): string {
    return this.lastError;
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  on(method: string, fn: Notify): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    if (this.current !== "open") await this.opened();
    return this.send<T>(method, params);
  }

  send<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new ConnectionLost(this.lastError || "not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CallTimeout(method, this.opts.callTimeoutMs));
      }, this.opts.callTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ConnectionLost(String(e)));
      }
    });
  }

  close(): void {
    this.generation++;
    this.setState("closed");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const s = this.socket;
    this.socket = undefined;
    this.fail("closed by the client");
    for (const w of this.waiters) w.reject(new ConnectionLost("closed by the client"));
    this.waiters = [];
    s?.close();
  }

  private opened(): Promise<void> {
    if (this.current === "closed") return Promise.reject(new ConnectionLost("closed by the client"));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private setState(s: ConnectionState): void {
    if (this.current === s || this.current === "closed") return;
    this.current = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private async connect(): Promise<void> {
    if (this.current === "closed") return;
    const gen = ++this.generation;
    this.setState("connecting");
    let socket: Socket;
    try {
      socket = await this.opts.dial({
        message: (frame) => {
          if (gen === this.generation) this.receive(frame);
        },
        closed: (reason) => {
          if (gen === this.generation) this.lost(reason);
        },
      });
    } catch (e) {
      if (gen === this.generation) this.lost(e instanceof Error ? e.message : String(e));
      return;
    }
    if (gen !== this.generation) {
      socket.close();
      return;
    }
    this.socket = socket;
    try {
      await this.opts.onOpen?.(this);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      socket.close();
      this.lost(this.lastError);
      return;
    }
    if (gen !== this.generation) return;
    this.retry = 0;
    this.lastError = "";
    this.setState("open");
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve();
  }

  private lost(reason: string): void {
    this.generation++;
    this.socket = undefined;
    this.lastError = reason;
    this.fail(reason);
    if (this.current === "closed") return;
    this.setState("waiting");
    const delay = Math.min(this.opts.retryMaxMs, this.opts.retryMinMs * 2 ** this.retry);
    this.retry++;
    this.retryTimer = setTimeout(() => void this.connect(), delay * (0.75 + Math.random() / 2));
  }

  reconnectNow(): void {
    if (this.current === "closed") return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const s = this.socket;
    this.retry = 0;
    this.lost("reconnecting");
    s?.close();
  }

  private fail(reason: string): void {
    const err = new ConnectionLost(reason);
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private receive(raw: string): void {
    let f: Frame;
    try {
      f = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (f.method !== undefined && (f.id === undefined || f.id === null)) {
      const set = this.handlers.get(f.method);
      if (set) for (const fn of [...set]) fn(f.params ?? null);
      return;
    }
    if (typeof f.id !== "number") return;
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    if (p.timer) clearTimeout(p.timer);
    if (f.error) p.reject(new RpcError(f.error.code, f.error.message, f.error.data));
    else p.resolve(f.result ?? null);
  }
}
