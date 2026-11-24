import { compareStrings, isObject, type Json, type JsonObject } from "../json.js";
import type { Freshness, Phase, Replica } from "../replica.js";
import type { AriaClient } from "./client.js";
import { errorOf, Feed, feedOf, idle, readyOf, worst } from "./feeds.js";
import type { FormsClient } from "../client.js";
import { byRecent, moreOf, num, rowsOf, text } from "./rows.js";

export const troupeFormID = "@troupe";

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

function foldAriasForm(daemon: string, root: JsonObject, into: Map<string, TreeNode>): string[] {
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
    .sort((a, b) => Number(isSelf(b)) - Number(isSelf(a)) || compareStrings(a, b));
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

export const treeFeedOf = (client: AriaClient): Feed<TreeState> => feedOf(client, "tree", () => new TreeFeed(() => client.forms));
