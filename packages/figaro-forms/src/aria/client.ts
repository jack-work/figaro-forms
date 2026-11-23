import type { ConnectionState } from "../rpc.js";
import { FormsClient } from "../client.js";
import { Link, type LinkOptions } from "../link.js";
import { Registry } from "../registry.js";
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

export interface AriaClientOptions extends LinkOptions {
  readonly pageBytes?: number;
}

export interface QuaOptions {
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

export interface ForkedAt {
  readonly fork: ForkResponse;
  readonly id: string;
  readonly qua?: QuaResponse;
}

export class ForkedButUnsent extends Error {
  readonly fork: ForkResponse;
  readonly id: string;

  constructor(fork: ForkResponse, cause: unknown) {
    super(`forked ${fork.alternative} but the text was not sent: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ForkedButUnsent";
    this.fork = fork;
    this.id = fork.alternative;
  }
}

export class AriaClient extends Link {
  private readonly streams = new Map<string, Set<AriaStream>>();
  private readonly shared: Registry<AriaStream>;
  private readonly opts: AriaClientOptions;
  private formsClient: FormsClient | undefined;

  constructor(opts: AriaClientOptions) {
    super(opts);
    this.opts = opts;
    this.shared = new Registry((_, stream) => stream.close(), opts.releaseGraceMs ?? 1000);
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
  }

  get forms(): FormsClient {
    this.formsClient ??= new FormsClient(this.opts);
    return this.formsClient;
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

  peek(aria: string): AriaStream {
    return this.shared.peek(aria, () => this.attach(aria));
  }

  retain(aria: string): AriaStream {
    return this.shared.retain(aria, () => this.attach(aria));
  }

  release(aria: string): void {
    this.shared.release(aria);
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
    this.shared.forget(stream.aria, stream);
    if (this.offers("unfollow") && this.connection.live) this.connection.send(ariaMethod.unfollow, { figaro_id: stream.aria }).catch(() => {});
  }

  read(aria: string, req: Omit<ReadRequest, "figaro_id"> = {}): Promise<Page> {
    return this.connection.call<Page>(ariaMethod.read, { figaro_id: aria, ...req });
  }

  qua(aria: string, text: string, o: QuaOptions = {}): Promise<QuaResponse> {
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

  tailFork(aria: string): Promise<ForkResponse> {
    return this.fork(aria);
  }

  async forkAt(aria: string, turn: number, text?: string): Promise<ForkedAt> {
    const fork = await this.fork(aria, { atTurn: turn });
    if (text === undefined || text === "") return { fork, id: fork.alternative };
    try {
      return { fork, id: fork.alternative, qua: await this.qua(fork.alternative, text) };
    } catch (cause) {
      throw new ForkedButUnsent(fork, cause);
    }
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
    this.formsClient?.close();
    this.formsClient = undefined;
    this.shared.clear();
    for (const set of [...this.streams.values()]) for (const s of [...set]) s.close();
    this.streams.clear();
    this.connection.close();
  }

  protected connected(generation: number): void {
    for (const set of this.streams.values()) for (const s of set) s.connected(generation);
  }

  protected disconnected(state: ConnectionState): void {
    for (const set of this.streams.values()) for (const s of set) s.disconnected(this.connection.error || state);
  }
}
