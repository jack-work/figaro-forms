import type { FormsClient } from "../client.js";
import type { AriaClient } from "./client.js";
import { isObject, type Json, type JsonObject } from "../json.js";
import type { Freshness, Phase, Replica } from "../replica.js";
import type { Refusal } from "../access.js";
import type { EditResult } from "../replica.js";
import type { FormAccess } from "../wire.js";
import { ConnectionLost } from "../rpc.js";
import type { Page } from "./wire.js";

export const troupeFormID = "@troupe";
export const recentFormID = "@recent";

export type NodeStatus = "live" | "retired" | "reaped";

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly handle: string | undefined;
  readonly mantra: string | undefined;
  readonly parent: string | undefined;
  readonly children: readonly string[];
  readonly daemon: string;
  readonly state: string;
  readonly status: NodeStatus;
  readonly roles: readonly string[];
  readonly cwd: string | undefined;
  readonly activeAt: number | undefined;
  readonly ctx: number | undefined;
  readonly ctxLimit: number | undefined;
}

export interface TreeDaemon {
  readonly id: string;
  readonly self: boolean;
  readonly form: string;
  readonly phase: Phase;
  readonly error: string | undefined;
  readonly more: number;
}

export interface TreeState {
  readonly ready: boolean;
  readonly freshness: Freshness;
  readonly error: string | undefined;
  readonly daemons: readonly TreeDaemon[];
  readonly roots: readonly string[];
  readonly more: number;
  readonly nodes: ReadonlyMap<string, TreeNode>;
  readonly reaped: ReadonlyMap<string, TreeNode>;
}

export interface RecentRow {
  readonly name: string;
  readonly id: string;
  readonly handle: string | undefined;
  readonly title: string;
  readonly state: string;
  readonly cwd: string | undefined;
  readonly activeAt: number | undefined;
}

export interface RecentState {
  readonly ready: boolean;
  readonly freshness: Freshness;
  readonly error: string | undefined;
  readonly rows: readonly RecentRow[];
  readonly more: number;
}

export interface BoundFormState {
  readonly aria: string;
  readonly ready: boolean;
  readonly freshness: Freshness;
  readonly phase: Phase;
  readonly error: string | undefined;
  readonly refusal: Refusal | undefined;
  readonly access: FormAccess | undefined;
  readonly version: number;
  readonly root: JsonObject;
}

export interface AriaFacts {
  readonly aria: string;
  readonly ready: boolean;
  readonly mantra: string | undefined;
  readonly turns: number | undefined;
  readonly error: string | undefined;
}

const moreOf = (root: JsonObject): number => {
  const n = root.more;
  return typeof n === "number" && n > 0 ? n : 0;
};

const text = (v: Json | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: Json | undefined): number | undefined => (typeof v === "number" ? v : undefined);

export function parseRoleAddresses(s: string | undefined): string[] {
  const out: string[] = [];
  if (!s) return out;
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      try {
        out.push(JSON.parse(s.slice(i, j + 1)) as string);
      } catch {
        out.push(s.slice(i + 1, j));
      }
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== " ") j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

const byRecent = (a: { activeAt: number | undefined; sortKey: string }, b: { activeAt: number | undefined; sortKey: string }): number => {
  const d = (b.activeAt ?? 0) - (a.activeAt ?? 0);
  return d !== 0 ? d : a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
};

function rowsOf(level: Json | undefined): [string, JsonObject][] {
  if (!isObject(level)) return [];
  const out: [string, JsonObject][] = [];
  for (const k of Object.keys(level)) {
    const v = level[k];
    if (isObject(v)) out.push([k, v]);
  }
  return out;
}

export function foldAriasForm(daemon: string, root: JsonObject, into: Map<string, TreeNode>): string[] {
  const walk = (level: Json | undefined, parent: string | undefined): string[] => {
    const entries = rowsOf(level)
      .map(([label, row]) => ({ label, row, id: text(row.id), activeAt: num(row.active_at) }))
      .filter((e): e is typeof e & { id: string } => e.id !== undefined)
      .map((e) => ({ ...e, sortKey: e.label }))
      .sort(byRecent);
    const ids: string[] = [];
    for (const e of entries) {
      if (into.has(e.id)) continue;
      ids.push(e.id);
      const children = walk(e.row.forks, e.id);
      const state = text(e.row.state) ?? "";
      const retired = (num(e.row.retired_at) ?? 0) > 0 || state === "retired";
      into.set(e.id, {
        id: e.id,
        label: e.label,
        handle: e.label !== e.id ? e.label : undefined,
        mantra: text(e.row.mantra),
        parent: parent ?? text(e.row.parent),
        children,
        daemon,
        state,
        status: retired ? "retired" : "live",
        roles: parseRoleAddresses(text(e.row.role)),
        cwd: text(e.row.cwd),
        activeAt: e.activeAt,
        ctx: num(e.row.ctx),
        ctxLimit: num(e.row.ctx_limit),
      });
    }
    return ids;
  };
  return walk(root.arias, undefined);
}

export function foldTree(
  troupe: JsonObject,
  arias: ReadonlyMap<string, { readonly root: JsonObject; readonly phase: Phase; readonly error: string | undefined }>,
  prev?: Pick<TreeState, "nodes" | "reaped">,
): Pick<TreeState, "daemons" | "roots" | "more" | "nodes" | "reaped"> {
  const daemons: TreeDaemon[] = [];
  const nodes = new Map<string, TreeNode>();
  const roots: string[] = [];
  const windowed = new Set<string>();
  const isSelf = (id: string): boolean => {
    const row = troupe[id];
    return isObject(row) && row.self === true;
  };
  const ids = Object.keys(troupe)
    .filter((k) => isObject(troupe[k]))
    .sort((a, b) => Number(isSelf(b)) - Number(isSelf(a)) || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) {
    const row = troupe[id] as JsonObject;
    const form = text(row.form);
    if (!form) continue;
    const got = arias.get(id);
    const more = got ? moreOf(got.root) : 0;
    daemons.push({ id, self: row.self === true, form, phase: got?.phase ?? "loading", error: got?.error, more });
    if (more > 0) windowed.add(id);
    if (got) roots.push(...foldAriasForm(id, got.root, nodes));
  }
  const reaped = new Map<string, TreeNode>();
  if (prev) {
    const present = new Set(daemons.filter((d) => d.phase === "ready").map((d) => d.id));
    for (const [id, n] of [...prev.nodes, ...prev.reaped]) {
      if (nodes.has(id) || !present.has(n.daemon) || windowed.has(n.daemon)) continue;
      reaped.set(id, { ...n, children: [], status: "reaped" });
    }
  }
  return { daemons, roots, more: daemons.reduce((n, d) => n + d.more, 0), nodes, reaped };
}

export function foldRecent(root: JsonObject): RecentRow[] {
  const rows: (RecentRow & { sortKey: string })[] = [];
  for (const [name, row] of rowsOf(root)) {
    const id = text(row.id);
    if (!id) continue;
    rows.push({
      name,
      id,
      handle: text(row.handle),
      title: text(row.title) ?? text(row.handle) ?? id,
      state: text(row.state) ?? "",
      cwd: text(row.cwd),
      activeAt: num(row.active_at),
      sortKey: id,
    });
  }
  return rows.sort(byRecent).map(({ sortKey: _, ...r }) => r);
}

const worst = (a: Freshness, b: Freshness): Freshness => (a === "stale" || b === "stale" ? "stale" : a === "resyncing" || b === "resyncing" ? "resyncing" : "current");

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

class ReplicaFeed<T> extends Feed<T> {
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

const idle = { ready: false, freshness: "stale" as Freshness, error: undefined };

const errorOf = (r: Replica): string | undefined => r.status.error;
const readyOf = (r: Replica): boolean => r.status.phase === "ready" && r.status.freshness === "current";

export function recentFeed(forms: () => FormsClient): Feed<RecentState> {
  return new ReplicaFeed<RecentState>(
    forms,
    recentFormID,
    (r) => ({ ready: readyOf(r), freshness: r.status.freshness, error: errorOf(r), rows: foldRecent(r.root), more: moreOf(r.root) }),
    { ...idle, rows: [], more: 0 },
  );
}

export function boundFormFeed(forms: () => FormsClient, aria: string): Feed<BoundFormState> {
  return new ReplicaFeed<BoundFormState>(
    forms,
    aria,
    (r) => ({
      aria,
      ready: readyOf(r),
      freshness: r.status.freshness,
      phase: r.status.phase,
      error: errorOf(r),
      refusal: r.status.refusal,
      access: r.status.access,
      version: r.status.version,
      root: r.root,
    }),
    { aria, ...idle, phase: "loading", refusal: undefined, access: undefined, version: 0, root: {} },
  );
}

export interface BoundFormWriter {
  set(path: string, value: Json): Promise<EditResult>;
  unset(path: string): Promise<EditResult>;
}

export function boundFormWriter(forms: () => FormsClient, aria: string): BoundFormWriter {
  const through = async (edit: (r: Replica) => Promise<EditResult>): Promise<EditResult> => {
    const client = forms();
    const r = client.retain(aria);
    try {
      return await edit(r);
    } finally {
      client.release(aria);
    }
  };
  return {
    set: (path, value) => through((r) => r.set(path, value)),
    unset: (path) => through((r) => r.unset(path)),
  };
}

export const boundFormWriterOf = (client: AriaClient, aria: string): BoundFormWriter => boundFormWriter(() => client.forms, aria);

export class TreeFeed extends Feed<TreeState> {
  constructor(private readonly forms: () => FormsClient) {
    super({ ...idle, daemons: [], roots: [], more: 0, nodes: new Map(), reaped: new Map() });
  }

  protected open(): () => void {
    const forms = this.forms();
    const troupe = forms.retain(troupeFormID);
    const held = new Map<string, { replica: Replica; off: () => void }>();
    let prev: Pick<TreeState, "nodes" | "reaped"> | undefined;

    const recompute = (): void => {
      const wanted = new Map<string, string>();
      for (const id of Object.keys(troupe.root)) {
        const row = troupe.root[id];
        const form = isObject(row) ? text(row.form) : undefined;
        if (form) wanted.set(form, id);
      }
      for (const [form, h] of [...held]) {
        if (wanted.has(form)) continue;
        h.off();
        forms.release(form);
        held.delete(form);
      }
      for (const form of wanted.keys()) {
        if (held.has(form)) continue;
        const replica = forms.retain(form);
        const offTree = replica.subscribe([], recompute);
        const offStatus = replica.onStatus(recompute);
        held.set(form, {
          replica,
          off: () => {
            offTree();
            offStatus();
          },
        });
      }
      const arias = new Map<string, { root: JsonObject; phase: Phase; error: string | undefined }>();
      let freshness = troupe.status.freshness;
      let ready = readyOf(troupe);
      let error = errorOf(troupe);
      for (const [form, id] of wanted) {
        const r = (held.get(form) as { replica: Replica }).replica;
        arias.set(id, { root: r.root, phase: r.status.phase, error: errorOf(r) });
        freshness = worst(freshness, r.status.freshness);
        ready = ready && readyOf(r);
        error ??= errorOf(r);
      }
      const folded = foldTree(troupe.root, arias, prev);
      prev = folded;
      this.publish({ ready, freshness, error, ...folded });
    };

    const offTree = troupe.subscribe([], recompute);
    const offStatus = troupe.onStatus(recompute);
    recompute();
    return () => {
      offTree();
      offStatus();
      for (const [form, h] of held) {
        h.off();
        forms.release(form);
      }
      held.clear();
      forms.release(troupeFormID);
    };
  }
}

const lastTurn = (page: Page): number => page.parts.reduce((n, p) => Math.max(n, p.turn), 0);

const activityOf = (n: TreeNode | undefined): string => (n ? `${n.state}\0${n.activeAt ?? ""}\0${n.ctx ?? ""}` : "");

export class AriaFactsFeed extends Feed<AriaFacts> {
  constructor(
    private readonly client: AriaClient,
    private readonly aria: string,
  ) {
    super({ aria, ready: false, mantra: undefined, turns: undefined, error: undefined });
  }

  protected open(): () => void {
    const { client, aria } = this;
    const tree = treeFeedOf(client);
    let session = 0;
    let reading = false;
    let readAgain = false;
    let seen: string | undefined;
    let turns: number | undefined;
    let pageMantra: string | undefined;
    let error: string | undefined;

    const show = (): void => {
      const n = tree.get().nodes.get(aria);
      this.publish({ aria, ready: turns !== undefined, mantra: n ? n.mantra : pageMantra, turns, error });
    };

    const count = (): void => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      const mine = session;
      const settled = (): void => {
        reading = false;
        show();
        if (readAgain) {
          readAgain = false;
          count();
        }
      };
      client.read(aria, { backward: true, limit: 1 }).then(
        (page) => {
          if (mine !== session) return;
          turns = lastTurn(page);
          pageMantra = text(page.metrics?.mantra);
          error = undefined;
          settled();
        },
        (err: unknown) => {
          if (mine !== session) return;
          if (!(err instanceof ConnectionLost)) error = err instanceof Error ? err.message : String(err);
          settled();
        },
      );
    };

    const moved = (): void => {
      const now = activityOf(tree.get().nodes.get(aria));
      if (seen === undefined || (seen !== "" && now !== "" && now !== seen)) count();
      seen = now;
      show();
    };

    const offTree = tree.subscribe(moved);
    const offLink = client.connection.onState((state) => {
      if (state === "open" && !reading) count();
    });
    moved();
    return () => {
      session++;
      reading = false;
      readAgain = false;
      offTree();
      offLink();
    };
  }
}

const registries = new WeakMap<AriaClient, Map<string, Feed<never>>>();

function feedOf<T>(client: AriaClient, key: string, make: () => Feed<T>): Feed<T> {
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

export const treeFeedOf = (client: AriaClient): Feed<TreeState> => feedOf(client, "tree", () => new TreeFeed(() => client.forms));
export const recentFeedOf = (client: AriaClient): Feed<RecentState> => feedOf(client, "recent", () => recentFeed(() => client.forms));
export const ariaFactsFeedOf = (client: AriaClient, aria: string): Feed<AriaFacts> => feedOf(client, `facts\0${aria}`, () => new AriaFactsFeed(client, aria));
export const boundFormFeedOf = (client: AriaClient, aria: string): Feed<BoundFormState> =>
  feedOf(client, `bound\0${aria}`, () => boundFormFeed(() => client.forms, aria));
