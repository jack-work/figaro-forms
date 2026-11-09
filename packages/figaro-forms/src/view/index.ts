import { isObject, member, type Json, type JsonObject } from "../json.js";
import type { Path } from "../path.js";
import type { FormView, ViewAction } from "../wire.js";

export { OpenState, type OpenStateOptions } from "./open-state.js";

export function matchPath(patterns: readonly string[] | null | undefined, segs: Path): { group: string } | undefined {
  for (const p of patterns ?? []) {
    const pat = p.split(".");
    const g = matchSegs(pat, segs, "");
    if (g !== undefined) {
      const stars = p.split("*").length - 1;
      const keepGroup = !(stars < 2 || pat[pat.length - 1] !== "*" || p.includes("**"));
      return { group: keepGroup ? g : "" };
    }
  }
  return undefined;
}

function matchSegs(pat: readonly string[], segs: Path, group: string): string | undefined {
  if (pat.length === 0) return segs.length === 0 ? group : undefined;
  const [head, ...rest] = pat;
  if (head === "**") {
    for (let n = 1; n <= segs.length; n++) {
      const g = matchSegs(rest, segs.slice(n), group);
      if (g !== undefined) return g;
    }
    return undefined;
  }
  if (head === "*") {
    if (segs.length === 0) return undefined;
    return matchSegs(rest, segs.slice(1), group === "" ? (segs[0] as string) : group);
  }
  if (segs.length === 0 || segs[0] !== head) return undefined;
  return matchSegs(rest, segs.slice(1), group);
}

export function pathKey(path: Path): string {
  return JSON.stringify(path);
}

export function leafText(v: Json | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (isObject(v)) return "";
  return JSON.stringify(v);
}

function childText(n: Json | undefined, dotted: string): string {
  let cur = n;
  for (const seg of dotted.split(".")) {
    if (!isObject(cur)) return "";
    cur = member(cur, seg);
  }
  return isObject(cur) ? "" : leafText(cur);
}

function childValue(n: Json | undefined, dotted: string): Json | undefined {
  let cur = n;
  for (const seg of dotted.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = member(cur, seg);
  }
  return cur;
}

function shapeLess(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface RowInfo {
  readonly group: string;
  readonly name: string;
  readonly aria: string | undefined;
  readonly label: string | undefined;
  readonly aside: Json | undefined;
  readonly mount: string | undefined;
  readonly marked: boolean;
}

export interface ViewNode {
  readonly id: string;
  readonly path: Path;
  readonly key: string;
  readonly depth: number;
  readonly branch: boolean;
  readonly value: Json;
  readonly open: boolean;
  readonly size: number;
  readonly row: RowInfo | undefined;
}

export interface ViewOptions {
  readonly view?: FormView | undefined;
  readonly isOpen?: ((path: Path) => boolean | undefined) | undefined;
  readonly subject?: JsonObject | undefined;
  readonly overlay?: JsonObject | undefined;
}

export function subjectText(subject: JsonObject | undefined, dotted: string): string {
  return childText(subject, dotted);
}

function marked(view: FormView, n: Json, group: string, name: string, subject: JsonObject | undefined): boolean {
  const m = view.mark;
  if (!m) return false;
  const want = (k: string): string => subjectText(subject, k);
  if (m.key_subject) {
    const got = childText(n, m.key ?? "");
    return got !== "" && got === want(m.key_subject);
  }
  if (!m.row_subject) return !!m.key && childText(n, m.key) === (m.equals ?? "");
  if (name !== want(m.row_subject)) return false;
  return !m.group_subject || group === want(m.group_subject);
}

function rowInfo(view: FormView, segs: Path, n: Json, group: string, o: ViewOptions): RowInfo {
  const name = segs[segs.length - 1] as string;
  const aria = view.row_aria ? childText(n, view.row_aria) || undefined : undefined;
  let label = view.label ? childText(n, view.label) || undefined : undefined;
  let aside = view.aside ? childValue(n, view.aside) : undefined;
  if (view.overlay && o.overlay && aria && Object.hasOwn(o.overlay, aria)) {
    const over = member(o.overlay, aria);
    if (view.overlay.key === view.label) label = leafText(over);
    if (view.overlay.key === view.aside) aside = over;
  }
  return {
    group,
    name,
    aria,
    label,
    aside,
    mount: view.mount ? childText(n, view.mount) || undefined : undefined,
    marked: marked(view, n, group, name, o.subject),
  };
}

export function overlaid(root: JsonObject, view: FormView | undefined, overlay: JsonObject | undefined): JsonObject {
  if (!view?.overlay || !overlay || !view.row_aria) return root;
  const key = view.overlay.key;
  const walk = (n: Json, segs: string[]): Json => {
    if (!isObject(n)) return n;
    let out: Record<string, Json> | undefined;
    for (const k of Object.keys(n)) {
      const kid = n[k] as Json;
      segs.push(k);
      let next = walk(kid, segs);
      if (isObject(next) && matchPath(view.rows, segs)) {
        const id = childText(next, view.row_aria as string);
        if (id && Object.hasOwn(overlay, id)) {
          const v = member(overlay, id) as Json;
          next = { ...next, [key]: v };
        }
      }
      segs.pop();
      if (next !== kid) {
        out ??= { ...n };
        Object.defineProperty(out, k, { value: next, enumerable: true, writable: true, configurable: true });
      }
    }
    return out ?? n;
  };
  return walk(root, []) as JsonObject;
}

export function flatten(root: JsonObject, o: ViewOptions = {}): ViewNode[] {
  const view = o.view;
  const out: ViewNode[] = [];
  const isOpen = (segs: Path, isRow: boolean): boolean => {
    const ui = o.isOpen?.(segs);
    if (ui !== undefined) return ui;
    if (view && matchPath(view.open, segs)) return true;
    return !view && !isRow && segs.length === 0;
  };
  const visit = (n: JsonObject, segs: string[], depth: number): void => {
    const kids = Object.keys(n).sort();
    const rest: string[] = [];
    const rows: { k: string; group: string }[] = [];
    for (const k of kids) {
      const kid = n[k] as Json;
      segs.push(k);
      const m = view ? matchPath(view.rows, segs) : undefined;
      segs.pop();
      if (!m || !isObject(kid)) {
        rest.push(k);
        continue;
      }
      if (view?.skip && childText(kid, view.skip) === "true") continue;
      rows.push({ k, group: m.group });
    }
    if (view?.sort && rows.length > 1) {
      const desc = view.sort.startsWith("-");
      const by = desc ? view.sort.slice(1) : view.sort;
      rows.sort((a, b) => {
        const c = shapeLess(childText(n[a.k], by), childText(n[b.k], by));
        return desc ? -c : c;
      });
    }
    const emit = (k: string, group: string | undefined): void => {
      const kid = n[k] as Json;
      segs.push(k);
      const path = [...segs];
      const branch = isObject(kid);
      const row = view && group !== undefined ? rowInfo(view, path, kid, group, o) : undefined;
      const through = branch && view?.through && row && isObject(member(kid, view.through));
      const open = branch && isOpen(path, row !== undefined);
      out.push({ id: pathKey(path), path, key: k, depth, branch, value: kid, open, size: branch ? Object.keys(kid).length : 0, row });
      if (open && branch) {
        if (through) {
          const { [view.through as string]: inner, ...own } = kid as Record<string, Json>;
          visit(own, segs, depth + 1);
          segs.push(view.through as string);
          visit(inner as JsonObject, segs, depth + 1);
          segs.pop();
        } else {
          visit(kid, segs, depth + 1);
        }
      }
      segs.pop();
    };
    for (const k of rest) emit(k, undefined);
    for (const r of rows) emit(r.k, r.group);
  };
  visit(root, [], 0);
  return out;
}

export interface ActionCall {
  readonly kind: "call";
  readonly method: string;
  readonly params: JsonObject;
  readonly confirm: boolean;
  readonly label: string;
}

export interface ActionLocal {
  readonly kind: "local";
  readonly local: string;
  readonly aria: string | undefined;
  readonly label: string;
}

export function resolveAction(action: ViewAction, row: RowInfo, subjectId?: string): ActionCall | ActionLocal | undefined {
  if (action.local) return { kind: "local", local: action.local, aria: row.aria, label: action.label };
  if (!action.method) return undefined;
  const target = action.target === "subject" ? subjectId : row.aria;
  if (!target) return undefined;
  const params: Record<string, Json> = isObject(action.params ?? null) ? { ...(action.params as JsonObject) } : {};
  for (const [name, from] of Object.entries(action.args ?? {})) {
    params[name] = from === "group" ? row.group : row.name;
  }
  return { kind: "call", method: action.method, params: { figaro_id: target, ...params }, confirm: !!action.confirm, label: action.label };
}
