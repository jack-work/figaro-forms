import { Connection, ConnectionLost, RpcError, type ConnectionState } from "./rpc.js";
import { Link, type LinkOptions } from "./link.js";
import { Registry } from "./registry.js";
import { Replica, type ReplicaOptions } from "./replica.js";
import type { Json } from "./json.js";
import type { Patch } from "./patch.js";
import {
  errFormUnavailable,
  method,
  type FormCreateResponse,
  type FormDelta,
  type FormResponse,
  type SetResponse,
} from "./wire.js";

export interface ClientOptions extends LinkOptions {
  readonly client?: string;
  readonly replica?: ReplicaOptions;
}

export interface FormRef {
  readonly id: string;
  readonly intrinsic?: string;
}

interface Entry {
  readonly ref: FormRef;
  readonly replica: Replica;
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

export class FormsClient extends Link {
  readonly client: string;
  private readonly forms: Registry<Entry>;
  private readonly followed = new Set<string>();
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    super(opts);
    this.opts = opts;
    this.client = opts.client ?? randomClient();
    this.forms = new Registry(
      (_, e) => {
        e.replica.close();
        this.unfollowIfUnused(e.ref.id);
      },
      opts.releaseGraceMs ?? 1000,
    );
    this.connection.on(method.formDelta, (p, generation) => this.delta(p as unknown as FormDelta, generation));
    this.connection.on(method.closed, (p) => this.closedForm(p));
  }

  peek(ref: string | FormRef): Replica {
    const r = parseRef(ref);
    return this.forms.peek(keyOf(r.id, r.intrinsic), () => this.entry(r)).replica;
  }

  retain(ref: string | FormRef): Replica {
    const r = parseRef(ref);
    return this.forms.retain(keyOf(r.id, r.intrinsic), () => this.entry(r)).replica;
  }

  release(ref: string | FormRef): void {
    const r = parseRef(ref);
    this.forms.release(keyOf(r.id, r.intrinsic));
  }

  get open(): number {
    return this.forms.size;
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
    for (const e of this.forms.values()) e.replica.close();
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

  protected override greeted(): void {
    this.followed.clear();
  }

  protected connected(generation: number): void {
    for (const e of this.forms.values()) void this.attach(e, generation);
  }

  protected disconnected(): void {
    for (const e of this.forms.values()) e.replica.stale();
  }

  private entry(ref: FormRef): Entry {
    const e = { ref, replica: this.replicaFor(ref) };
    if (this.connection.state === "open") void this.attach(e, this.connection.epoch);
    return e;
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
