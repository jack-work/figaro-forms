import { Connection, type ConnectionState, type Dial } from "../rpc.js";
import { method, protocolVersion, type Capability, type HelloResponse } from "../wire.js";
import type { Json } from "../json.js";
import { AriaStream, type AttachOptions } from "./stream.js";
import {
  ariaMethod,
  type AriaFrame,
  type ForkRequest,
  type ForkResponse,
  type InterruptResponse,
  type ListRequest,
  type ListResponse,
  type AriaRow,
  type Page,
  type QuaImage,
  type QuaResponse,
  type QueueDisposition,
  type ReadRequest,
  type TurnDone,
} from "./wire.js";

export interface AriaClientOptions {
  readonly dial: Dial;
  readonly callTimeoutMs?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  readonly releaseGraceMs?: number;
  readonly pageBytes?: number;
}

export interface PromptOptions {
  readonly images?: readonly QuaImage[];
}

export interface InterruptOptions {
  readonly queue?: QueueDisposition;
}

export interface ForkOptions {
  readonly atTurn?: number;
  readonly atLT?: number;
  readonly outfits?: readonly string[];
}

export interface ListOptions {
  readonly global?: boolean;
  readonly limit?: number;
  readonly before?: string;
}

export interface AriaList {
  readonly rows: readonly AriaRow[];
  readonly nextBefore?: string;
  readonly refused: number;
  readonly refusedWhy?: string;
}

interface Shared {
  readonly stream: AriaStream;
  refs: number;
  reap: ReturnType<typeof setTimeout> | undefined;
}

export class AriaClient {
  readonly connection: Connection;
  private helloValue: HelloResponse | undefined;
  private readonly streams = new Map<string, Set<AriaStream>>();
  private readonly shared = new Map<string, Shared>();
  private readonly opts: AriaClientOptions;

  constructor(opts: AriaClientOptions) {
    this.opts = opts;
    this.connection = new Connection({
      dial: opts.dial,
      ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
      ...(opts.retryMinMs !== undefined ? { retryMinMs: opts.retryMinMs } : {}),
      ...(opts.retryMaxMs !== undefined ? { retryMaxMs: opts.retryMaxMs } : {}),
      onOpen: (conn) => this.opened(conn),
    });
    this.connection.on(ariaMethod.frame, (p, generation) => {
      const frame = p as unknown as AriaFrame;
      for (const s of this.streams.get(frame.figaro_id) ?? []) s.push(frame, generation);
    });
    this.connection.on(ariaMethod.turnDone, (p, generation) => {
      const done = p as unknown as TurnDone;
      for (const s of this.streams.get(done.figaro_id) ?? []) s.turnDone(done, generation);
    });
    this.connection.on(ariaMethod.closed, (p) => {
      const id = (p as { figaro_id?: string } | null)?.figaro_id;
      if (id) for (const s of this.streams.get(id) ?? []) s.ariaClosed();
    });
    this.connection.on(method.doorLapsed, () => this.connection.reconnectNow());
    this.connection.onState((state) => this.moved(state));
  }

  get hello(): HelloResponse | undefined {
    return this.helloValue;
  }

  get state(): ConnectionState {
    return this.connection.state;
  }

  attach(aria: string, o: AttachOptions = {}): AriaStream {
    const stream = new AriaStream(this, aria, { ...(this.opts.pageBytes !== undefined ? { pageBytes: this.opts.pageBytes } : {}), ...o });
    let set = this.streams.get(aria);
    if (!set) {
      set = new Set();
      this.streams.set(aria, set);
    }
    set.add(stream);
    if (this.connection.state === "open") stream.connected(this.connection.epoch);
    return stream;
  }

  stream(aria: string): AriaStream {
    let e = this.shared.get(aria);
    if (!e) {
      e = { stream: this.attach(aria), refs: 0, reap: undefined };
      this.shared.set(aria, e);
    }
    return e.stream;
  }

  retain(aria: string): AriaStream {
    const stream = this.stream(aria);
    const e = this.shared.get(aria) as Shared;
    e.refs++;
    if (e.reap) clearTimeout(e.reap);
    e.reap = undefined;
    return stream;
  }

  release(aria: string): void {
    const e = this.shared.get(aria);
    if (!e || e.refs === 0) return;
    if (--e.refs > 0) return;
    e.reap = setTimeout(() => {
      e.reap = undefined;
      if (e.refs > 0 || this.shared.get(aria) !== e) return;
      this.shared.delete(aria);
      e.stream.close();
    }, this.opts.releaseGraceMs ?? 1000);
  }

  async follow(aria: string): Promise<void> {
    const channels = this.offers("follow.channels") ? { channels: ["transcript"] } : {};
    await this.connection.send(ariaMethod.follow, { figaro_id: aria, ...channels });
  }

  detach(stream: AriaStream): void {
    const set = this.streams.get(stream.aria);
    if (!set) return;
    set.delete(stream);
    if (set.size > 0) return;
    this.streams.delete(stream.aria);
    if (this.shared.get(stream.aria)?.stream === stream) this.shared.delete(stream.aria);
    if (this.offers("unfollow") && this.connection.live) this.connection.send(ariaMethod.unfollow, { figaro_id: stream.aria }).catch(() => {});
  }

  read(aria: string, req: Omit<ReadRequest, "figaro_id"> = {}): Promise<Page> {
    return this.connection.call<Page>(ariaMethod.read, { figaro_id: aria, ...req });
  }

  prompt(aria: string, text: string, o: PromptOptions = {}): Promise<QuaResponse> {
    return this.connection.call<QuaResponse>(ariaMethod.qua, {
      figaro_id: aria,
      text,
      ...(o.images && o.images.length > 0 ? { images: o.images } : {}),
    });
  }

  interrupt(aria: string, o: InterruptOptions = {}): Promise<InterruptResponse> {
    return this.connection.call<InterruptResponse>(ariaMethod.interrupt, { figaro_id: aria, queue: o.queue ?? "keep" });
  }

  fork(aria: string, o: ForkOptions = {}): Promise<ForkResponse> {
    const req: ForkRequest = {
      figaro_id: aria,
      ...(o.atTurn !== undefined ? { at_turn: o.atTurn } : {}),
      ...(o.atLT !== undefined ? { at_lt: o.atLT } : {}),
      ...(o.outfits ? { outfits: o.outfits } : {}),
    };
    return this.connection.call<ForkResponse>(ariaMethod.fork, req as unknown as Json);
  }

  async list(o: ListOptions = {}): Promise<AriaList> {
    const req: ListRequest = {
      ...(o.global ? { global: true } : {}),
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
      ...(o.before !== undefined ? { before: o.before } : {}),
    };
    const r = await this.connection.call<ListResponse>(ariaMethod.list, req);
    return {
      rows: r.figaros ?? [],
      refused: r.refused ?? 0,
      ...(r.next_before ? { nextBefore: r.next_before } : {}),
      ...(r.refused_why ? { refusedWhy: r.refused_why } : {}),
    };
  }

  close(): void {
    for (const e of this.shared.values()) if (e.reap) clearTimeout(e.reap);
    this.shared.clear();
    for (const set of [...this.streams.values()]) for (const s of [...set]) s.close();
    this.streams.clear();
    this.connection.close();
  }

  private offers(cap: Capability): boolean {
    return this.helloValue?.capabilities?.includes(cap) ?? false;
  }

  private async opened(conn: Connection): Promise<void> {
    const generation = conn.epoch;
    const hello = await conn.send<HelloResponse>(method.hello, { version: protocolVersion });
    if (generation !== conn.epoch) return;
    this.helloValue = hello;
  }

  private moved(state: ConnectionState): void {
    if (state === "open") {
      const generation = this.connection.epoch;
      for (const set of this.streams.values()) for (const s of set) s.connected(generation);
      return;
    }
    this.helloValue = undefined;
    for (const set of this.streams.values()) for (const s of set) s.disconnected(this.connection.error || state);
  }
}
