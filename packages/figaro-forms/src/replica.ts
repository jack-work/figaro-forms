import { type Json, type JsonObject } from "./json.js";
import { applyRoot, deleteAt, identity, isIdentity, setAt, touchedKeys, tryMerge, type Patch } from "./patch.js";
import { getAt, resolve, type Path, type PathLike } from "./path.js";
import { Tree, type Listener } from "./tree.js";
import { RpcError } from "./rpc.js";
import { refusalOf, type Refusal } from "./access.js";
import {
  errDenied,
  errFormUnavailable,
  formDeltaSchema,
  type FormAccess,
  type FormDelta,
  type FormResponse,
  type FormView,
  type SetRequest,
  type SetResponse,
} from "./wire.js";

export interface FormTransport {
  load(client: string): Promise<FormResponse>;
  set(req: Omit<SetRequest, "figaro_id">): Promise<SetResponse>;
}

export type Phase = "loading" | "ready" | "incompatible" | "gone" | "failed";

export interface FormStatus {
  readonly phase: Phase;
  readonly version: number;
  readonly incarnation: number;
  readonly pending: number;
  readonly access: FormAccess | undefined;
  readonly view: FormView | undefined;
  readonly refusal: Refusal | undefined;
  readonly error: string | undefined;
}

export type EditResult = { readonly ok: true; readonly version: number } | { readonly ok: false; readonly refusal: Refusal };

export interface ReplicaOptions {
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly confirmTimeoutMs?: number;
  readonly final?: (err: unknown) => boolean;
}

type Waiter = (r: EditResult) => void;

interface PendingEdit {
  readonly seq: number;
  readonly patch: Patch;
  readonly sent: boolean;
  readonly waiters: readonly Waiter[];
}

interface State {
  readonly loaded: boolean;
  readonly incompatible: boolean;
  readonly gone: boolean;
  readonly failed: string | undefined;
  readonly origin: string;
  readonly confirmed: JsonObject;
  readonly shown: JsonObject;
  readonly version: number;
  readonly incarnation: number;
  readonly pending: readonly PendingEdit[];
  readonly draft: Patch;
  readonly draftWaiters: readonly Waiter[];
  readonly nextSeq: number;
  readonly inFlight: boolean;
  readonly access: FormAccess | undefined;
  readonly view: FormView | undefined;
  readonly refusal: Refusal | undefined;
}

const initial: State = {
  loaded: false,
  incompatible: false,
  gone: false,
  failed: undefined,
  origin: "",
  confirmed: {},
  shown: {},
  version: 0,
  incarnation: 0,
  pending: [],
  draft: identity,
  draftWaiters: [],
  nextSeq: 1,
  inFlight: false,
  access: undefined,
  view: undefined,
  refusal: undefined,
};

export class Replica {
  readonly tree = new Tree();
  private s: State = initial;
  private statusValue: FormStatus;
  private readonly statusListeners = new Set<Listener>();
  private readonly readyWaiters: (() => void)[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private maxWait: ReturnType<typeof setTimeout> | undefined;
  private retry = 0;
  private reloading = false;
  private reloadAgain = false;
  private closed = false;

  constructor(
    private readonly client: string,
    private readonly t: FormTransport,
    private readonly o: ReplicaOptions = {},
  ) {
    this.statusValue = this.computeStatus(initial);
  }

  get status(): FormStatus {
    return this.statusValue;
  }

  get root(): JsonObject {
    return this.tree.root;
  }

  get confirmed(): JsonObject {
    return this.s.confirmed;
  }

  get(path: PathLike): Json | undefined {
    return getAt(this.tree.root, resolve(this.tree.root, path));
  }

  subscribe(path: PathLike, fn: Listener): () => void {
    return this.tree.subscribe(resolve(this.tree.root, path), fn);
  }

  onStatus(fn: Listener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  ready(): Promise<void> {
    if (this.s.loaded) return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  set(path: PathLike, value: Json): Promise<EditResult> {
    const segs = resolve(this.tree.root, path);
    let p: Patch;
    try {
      p = setAt(this.tree.root, segs, value);
    } catch (e) {
      return Promise.resolve(this.refuseLocally(segs, "invalid", e instanceof Error ? e.message : String(e)));
    }
    return this.edit(p);
  }

  unset(path: PathLike): Promise<EditResult> {
    return this.edit(deleteAt(this.tree.root, resolve(this.tree.root, path)));
  }

  edit(p: Patch): Promise<EditResult> {
    if (isIdentity(p)) return Promise.resolve({ ok: true, version: this.s.version });
    const refusal = this.localRefusal(p);
    if (refusal) {
      this.commit({ ...this.s, refusal });
      return Promise.resolve({ ok: false, refusal });
    }
    return new Promise((resolveEdit) => {
      let next: State = this.s;
      const merged = tryMerge(next.draft, p);
      if (merged) {
        next = { ...next, draft: merged, draftWaiters: [...next.draftWaiters, resolveEdit] };
      } else {
        next = this.flushDraft(next);
        next = { ...next, draft: p, draftWaiters: [resolveEdit] };
      }
      this.commit(recompute(next));
      this.arm();
    });
  }

  flush(): void {
    this.stopTimers();
    this.commit(this.flushDraft(this.s));
  }

  delta(d: FormDelta): void {
    const s = this.s;
    if (s.incompatible || this.closed) return;
    if (d.schema !== formDeltaSchema) {
      this.commit({ ...s, incompatible: true });
      return;
    }
    if (!s.loaded) return;
    const inc = d.incarnation ?? 0;
    if (inc !== s.incarnation) {
      if (inc > s.incarnation) this.reload();
      return;
    }
    if (d.version <= s.version) return;
    if (d.version !== s.version + 1) {
      this.reload();
      return;
    }
    let next: State = { ...s, confirmed: applyRoot(d.patch, s.confirmed), version: d.version };
    if (d.origin && d.origin === s.origin && (d.seq ?? 0) > 0) {
      next = { ...next, pending: settle(next.pending, d.seq ?? 0, d.version) };
    }
    this.commit(this.sendNext(recompute(next)));
  }

  gone(): void {
    this.commit({ ...this.s, gone: true });
  }

  reload(): void {
    if (this.closed) return;
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    this.t.load(this.client).then(
      (resp) => {
        this.reloading = false;
        this.retry = 0;
        this.loaded(resp);
        if (this.reloadAgain) {
          this.reloadAgain = false;
          this.reload();
        }
      },
      (err: unknown) => {
        this.reloading = false;
        this.reloadAgain = false;
        if (this.o.final?.(err)) {
          this.commit({ ...this.s, failed: err instanceof Error ? err.message : String(err) });
          return;
        }
        this.reloadLater();
      },
    );
  }

  close(): void {
    this.closed = true;
    this.stopTimers();
    const waiters = [...this.s.draftWaiters, ...this.s.pending.flatMap((p) => p.waiters)];
    const refusal: Refusal = { key: "", kind: "closed", reason: "the form was closed before the edit settled" };
    for (const w of waiters) w({ ok: false, refusal });
  }

  private loaded(resp: FormResponse): void {
    const s = this.s;
    const inc = resp.incarnation ?? 0;
    const version = resp.version ?? 0;
    if (s.loaded && (inc < s.incarnation || (inc === s.incarnation && version < s.version))) return;
    let confirmed = resp.snapshot ?? {};
    if (resp.delta) {
      confirmed = s.confirmed;
      for (const p of resp.patches ?? []) confirmed = applyRoot(p.patch, confirmed);
    }
    const lastSeq = resp.last_seq ?? 0;
    let pending = s.loaded ? settle(s.pending, lastSeq, version) : s.pending.map((p, i) => ({ ...p, seq: lastSeq + 1 + i }));
    const nextSeq = Math.max(s.nextSeq, lastSeq + 1 + (s.loaded ? 0 : s.pending.length));
    if (!s.inFlight) pending = pending.map((p) => ({ ...p, sent: false }));
    const next: State = {
      ...s,
      loaded: true,
      failed: undefined,
      confirmed,
      version,
      incarnation: inc,
      origin: resp.origin ?? "",
      pending,
      nextSeq,
      access: resp.access,
      view: resp.view,
    };
    this.commit(this.sendNext(recompute(next)));
    if (!s.loaded) for (const r of this.readyWaiters.splice(0)) r();
  }

  private flushDraft(s: State): State {
    if (isIdentity(s.draft)) return s;
    const edit: PendingEdit = { seq: s.nextSeq, patch: s.draft, sent: false, waiters: s.draftWaiters };
    return this.sendNext({ ...s, pending: [...s.pending, edit], nextSeq: s.nextSeq + 1, draft: identity, draftWaiters: [] });
  }

  private sendNext(s: State): State {
    if (s.inFlight || !s.loaded || s.incompatible || s.gone || this.closed) return s;
    const i = s.pending.findIndex((p) => !p.sent);
    if (i < 0) return s;
    const pe = s.pending[i] as PendingEdit;
    const pending = s.pending.map((p, j) => (j === i ? { ...p, sent: true } : p));
    const req = { patch: pe.patch, client: this.client, seq: pe.seq };
    this.t.set(req).then(
      (resp) => this.answer(pe.seq, resp, undefined),
      (err: unknown) => this.answer(pe.seq, undefined, err),
    );
    return { ...s, pending, inFlight: true };
  }

  private answer(seq: number, resp: SetResponse | undefined, err: unknown): void {
    if (this.closed) return;
    const s = this.s;
    let next: State = { ...s, inFlight: false };
    if (resp && resp.outcome === "applied" && (resp.version ?? 0) > s.version) {
      this.expect(resp.version ?? 0);
      this.commit(this.sendNext(next));
      return;
    }
    if (resp) {
      next = { ...next, pending: settleOne(s.pending, seq, { ok: true, version: resp.version ?? s.version }) };
    } else if (err instanceof RpcError && err.code !== errFormUnavailable) {
      const edit = s.pending.find((p) => p.seq === seq);
      const key = edit ? (touchedKeys(edit.patch)[0] ?? []).join(".") : "";
      const refusal: Refusal = { key, kind: err.code === errDenied ? "denied" : "refused", reason: err.message };
      next = { ...next, pending: settleOne(s.pending, seq, { ok: false, refusal }), refusal };
    } else {
      this.commit({ ...next, pending: s.pending.map((p) => ({ ...p, sent: false })) });
      this.reloadLater();
      return;
    }
    this.commit(this.sendNext(recompute(next)));
  }

  private expect(version: number): void {
    setTimeout(() => {
      if (!this.closed && this.s.version < version) this.reload();
    }, this.o.confirmTimeoutMs ?? 10_000);
  }

  private reloadLater(): void {
    this.retry = this.retry === 0 ? 50 : Math.min(this.retry * 2, 5_000);
    setTimeout(() => this.reload(), this.retry);
  }

  private arm(): void {
    const debounce = this.o.debounceMs ?? 0;
    if (debounce <= 0) {
      this.flush();
      return;
    }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), debounce);
    if (!this.maxWait && (this.o.maxWaitMs ?? 0) > 0) this.maxWait = setTimeout(() => this.flush(), this.o.maxWaitMs);
  }

  private stopTimers(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.debounce = this.maxWait = undefined;
  }

  private localRefusal(p: Patch): Refusal | undefined {
    for (const key of touchedKeys(p)) {
      const r = refusalOf(this.s.access, key);
      if (r) return r;
    }
    return undefined;
  }

  private refuseLocally(path: Path, kind: string, reason: string): EditResult {
    const refusal: Refusal = { key: path.join("."), kind, reason };
    this.commit({ ...this.s, refusal });
    return { ok: false, refusal };
  }

  private commit(next: State): void {
    const prev = this.s;
    this.s = next;
    if (next.shown !== prev.shown) this.tree.replace(next.shown);
    const status = this.computeStatus(next);
    if (!sameStatus(status, this.statusValue)) {
      this.statusValue = status;
      for (const fn of [...this.statusListeners]) fn();
    }
  }

  private computeStatus(s: State): FormStatus {
    let phase: Phase = s.loaded ? "ready" : "loading";
    if (s.failed) phase = "failed";
    if (s.gone) phase = "gone";
    if (s.incompatible) phase = "incompatible";
    return {
      phase,
      version: s.version,
      incarnation: s.incarnation,
      pending: s.pending.length + (isIdentity(s.draft) ? 0 : 1),
      access: s.access,
      view: s.view,
      refusal: s.refusal,
      error: s.failed,
    };
  }
}

function sameStatus(a: FormStatus, b: FormStatus): boolean {
  return (
    a.phase === b.phase &&
    a.version === b.version &&
    a.incarnation === b.incarnation &&
    a.pending === b.pending &&
    a.access === b.access &&
    a.view === b.view &&
    a.refusal === b.refusal &&
    a.error === b.error
  );
}

function recompute(s: State): State {
  let shown = s.confirmed;
  for (const p of s.pending) shown = applyRoot(p.patch, shown);
  shown = applyRoot(s.draft, shown);
  return { ...s, shown };
}

function settle(ps: readonly PendingEdit[], through: number, version: number): readonly PendingEdit[] {
  const out: PendingEdit[] = [];
  for (const p of ps) {
    if (p.seq > through) out.push(p);
    else for (const w of p.waiters) w({ ok: true, version });
  }
  return out.length === ps.length ? ps : out;
}

function settleOne(ps: readonly PendingEdit[], seq: number, r: EditResult): readonly PendingEdit[] {
  return ps.filter((p) => {
    if (p.seq !== seq) return true;
    for (const w of p.waiters) w(r);
    return false;
  });
}
