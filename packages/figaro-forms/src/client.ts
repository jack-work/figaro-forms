import { Connection, ConnectionLost, RpcError, type ConnectionState, type Dial } from "./rpc.js";
import { Replica, type ReplicaOptions } from "./replica.js";
import type { Json } from "./json.js";
import type { Patch } from "./patch.js";
import {
  errFormUnavailable,
  method,
  protocolVersion,
  type FormCreateResponse,
  type FormDelta,
  type Capability,
  type FormResponse,
  type HelloResponse,
  type SetResponse,
} from "./wire.js";

export interface ClientOptions {
  readonly dial: Dial;
  readonly client?: string;
  readonly replica?: ReplicaOptions;
  readonly callTimeoutMs?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  readonly releaseGraceMs?: number;
}

export interface FormRef {
  readonly id: string;
  readonly intrinsic?: string;
}

interface Entry {
  readonly ref: FormRef;
  readonly replica: Replica;
  refs: number;
  reap: ReturnType<typeof setTimeout> | undefined;
}

const keyOf = (id: string, intrinsic: string | undefined): string =>
  intrinsic && intrinsic !== "state" ? `${id}/${intrinsic}` : id;

export function parseRef(ref: string | FormRef): FormRef {
  if (typeof ref !== "string") return ref;
  const slash = ref.lastIndexOf("/");
  const tail = slash < 0 ? "" : ref.slice(slash + 1);
  if (tail === "queue" || tail === "runtime" || tail === "state") return { id: ref.slice(0, slash), intrinsic: tail };
  return { id: ref };
}

export function isFinal(err: unknown): boolean {
  return err instanceof RpcError && err.code !== errFormUnavailable;
}

export class FormsClient {
  readonly connection: Connection;
  readonly client: string;
  private helloValue: HelloResponse | undefined;
  private readonly forms = new Map<string, Entry>();
  private readonly followed = new Set<string>();
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.client = opts.client ?? randomClient();
    this.connection = new Connection({
      dial: opts.dial,
      ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
      ...(opts.retryMinMs !== undefined ? { retryMinMs: opts.retryMinMs } : {}),
      ...(opts.retryMaxMs !== undefined ? { retryMaxMs: opts.retryMaxMs } : {}),
      onOpen: (conn) => this.opened(conn),
    });
    this.connection.on(method.formDelta, (p, generation) => this.delta(p as unknown as FormDelta, generation));
    this.connection.on(method.closed, (p) => this.closedForm(p));
    this.connection.on(method.doorLapsed, () => this.connection.reconnectNow());
    this.connection.onState((state) => {
      if (state === "open") {
        const generation = this.connection.epoch;
        for (const e of this.forms.values()) void this.attach(e, generation);
      } else {
        this.helloValue = undefined;
        for (const e of this.forms.values()) e.replica.stale();
      }
    });
  }

  get hello(): HelloResponse | undefined {
    return this.helloValue;
  }

  get state(): ConnectionState {
    return this.connection.state;
  }

  form(ref: string | FormRef): Replica {
    const e = this.entry(ref);
    this.retainEntry(e);
    return e.replica;
  }

  peek(ref: string | FormRef): Replica {
    const e = this.entry(ref);
    if (e.refs === 0) this.scheduleReap(e);
    return e.replica;
  }

  retain(ref: string | FormRef): Replica {
    return this.form(ref);
  }

  release(ref: string | FormRef): void {
    const r = parseRef(ref);
    const e = this.forms.get(keyOf(r.id, r.intrinsic));
    if (!e || e.refs === 0) return;
    if (--e.refs === 0) this.scheduleReap(e);
  }

  get open(): number {
    return this.forms.size;
  }

  private entry(ref: string | FormRef): Entry {
    const r = parseRef(ref);
    const key = keyOf(r.id, r.intrinsic);
    let e = this.forms.get(key);
    if (!e) {
      e = { ref: r, replica: this.replicaFor(r), refs: 0, reap: undefined };
      this.forms.set(key, e);
      if (this.connection.state === "open") void this.attach(e, this.connection.epoch);
    }
    return e;
  }

  private retainEntry(e: Entry): void {
    e.refs++;
    if (e.reap) clearTimeout(e.reap);
    e.reap = undefined;
  }

  private scheduleReap(e: Entry): void {
    if (e.reap) clearTimeout(e.reap);
    e.reap = setTimeout(() => {
      e.reap = undefined;
      if (e.refs > 0) return;
      const key = keyOf(e.ref.id, e.ref.intrinsic);
      if (this.forms.get(key) !== e) return;
      this.forms.delete(key);
      e.replica.close();
      this.unfollowIfUnused(e.ref.id);
    }, this.opts.releaseGraceMs ?? 1000);
  }

  async create(patch?: Patch, outfits?: readonly string[]): Promise<string> {
    const resp = await this.connection.call<FormCreateResponse>(method.formCreate, {
      patch: patch ?? { object: {} },
      ...(outfits ? { outfits } : {}),
    });
    return resp.form_id;
  }

  call<T>(name: string, params: Json): Promise<T> {
    return this.connection.call<T>(name, params);
  }

  close(): void {
    for (const e of this.forms.values()) {
      if (e.reap) clearTimeout(e.reap);
      e.replica.close();
    }
    this.forms.clear();
    this.connection.close();
  }

  private replicaFor(r: FormRef): Replica {
    const conn = this.connection;
    const params = (extra: object): object => ({
      figaro_id: r.id,
      ...(r.intrinsic ? { intrinsic: r.intrinsic } : {}),
      ...extra,
    });
    return new Replica(
      this.client,
      {
        load: (client) => conn.call<FormResponse>(method.form, params({ client })),
        set: (req) =>
          r.intrinsic && r.intrinsic !== "state"
            ? Promise.reject(new RpcError(-32601, `${r.intrinsic} is an intrinsic form and cannot be set`))
            : conn.call<SetResponse>(method.set, { figaro_id: r.id, ...req }),
      },
      { final: isFinal, ...this.opts.replica },
    );
  }

  private async opened(conn: Connection): Promise<void> {
    const generation = conn.epoch;
    const hello = await conn.send<HelloResponse>(method.hello, { version: protocolVersion });
    if (generation !== conn.epoch) return;
    this.followed.clear();
    this.helloValue = hello;
  }

  private async attach(e: Entry, generation: number): Promise<void> {
    e.replica.beginGeneration(generation);
    try {
      await this.follow(this.connection, e, generation);
    } catch (err) {
      if (!(err instanceof ConnectionLost)) e.replica.failed(err, generation);
      return;
    }
    if (generation !== this.connection.epoch || this.connection.state !== "open") return;
    const key = keyOf(e.ref.id, e.ref.intrinsic);
    if (this.forms.get(key) === e) e.replica.reload();
  }

  private offers(cap: Capability): boolean {
    return this.helloValue?.capabilities?.includes(cap) ?? false;
  }

  private unfollowIfUnused(id: string): void {
    if ([...this.forms.values()].some((x) => x.ref.id === id)) return;
    if (!this.followed.delete(id) || !this.offers("unfollow") || !this.connection.live) return;
    this.connection.send(method.unfollow, { figaro_id: id }).catch(() => {});
  }

  private async follow(conn: Connection, e: Entry, generation: number): Promise<void> {
    if (this.followed.has(e.ref.id)) return;
    const channels = this.offers("follow.channels") ? { channels: ["forms"] } : {};
    await conn.send(method.follow, { figaro_id: e.ref.id, ...channels });
    if (generation === conn.epoch) this.followed.add(e.ref.id);
  }

  private delta(d: FormDelta, generation: number): void {
    const id = d.aria_id ?? d.figaro_id;
    if (!id) return;
    this.forms.get(keyOf(id, d.intrinsic))?.replica.delta(d, generation);
  }

  private closedForm(p: Json): void {
    const id = typeof p === "object" && p !== null && !Array.isArray(p) ? (p as { figaro_id?: string }).figaro_id : undefined;
    if (!id) return;
    for (const e of this.forms.values()) if (e.ref.id === id) e.replica.gone();
  }
}

function randomClient(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
