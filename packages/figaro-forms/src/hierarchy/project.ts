import type { Json, JsonObject } from "../json.js";
import { isObject } from "../json.js";
import { RpcError } from "../rpc.js";
import type { AriaRow, ListResponse } from "../aria/wire.js";
import { errDenied, method, type FormResponse } from "../wire.js";

export interface HierarchyForm {
  readonly id: string;
  readonly handle?: string;
  readonly parent: string | null;
  readonly target_aria?: string;
  readonly state: JsonObject;
}

export interface HierarchyAria {
  readonly id: string;
  readonly handle?: string;
  readonly state: string;
  readonly mantra?: string;
  readonly parent?: string;
}

export interface HierarchyOrder {
  readonly root: string;
  readonly forms: readonly HierarchyForm[];
  readonly topology: { readonly [aria: string]: string };
  readonly arias: readonly HierarchyAria[];
}

export type HierarchyReply =
  | { readonly status: "current"; readonly observed_at: number; readonly orders: readonly HierarchyOrder[] }
  | { readonly status: "empty"; readonly observed_at: number }
  | { readonly status: "denied" | "signedout" | "unavailable"; readonly reason: string };

export type CallerCall = (method: string, params: unknown) => Promise<unknown>;

export interface ReadHierarchyOptions {
  readonly root?: string;
  readonly now?: () => number;
}

export const publicStateKeys = ["role-name", "name", "title", "charter", "summary", "owns", "boundary", "kind", "lifecycle", "reports-to", "lanes"] as const;

export async function readHierarchy(call: CallerCall, o: ReadHierarchyOptions = {}): Promise<HierarchyReply> {
  try {
    return await project(call, o);
  } catch (e) {
    if (e instanceof RpcError && e.code === errDenied) return { status: "denied", reason: e.message };
    return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  }
}

export function hierarchyHttp(reply: HierarchyReply): { readonly code: number; readonly body: HierarchyReply } {
  switch (reply.status) {
    case "current":
    case "empty":
      return { code: 200, body: reply };
    case "signedout":
      return { code: 401, body: { status: "signedout", reason: reply.reason } };
    case "denied":
      return { code: 403, body: { status: "denied", reason: reply.reason } };
    case "unavailable":
      return { code: 503, body: { status: "unavailable", reason: reply.reason } };
  }
}

const live = (r: AriaRow): boolean => !r.reaped_at && !r.retired_at;
const isFormRow = (r: AriaRow): boolean => r.kind === "form" || (r.kind === undefined && r.state === "form");
const isAriaRow = (r: AriaRow): boolean => r.kind === "conversation" || (r.kind === undefined && r.state !== "form" && r.state !== "anchor");

async function project(call: CallerCall, o: ReadHierarchyOptions): Promise<HierarchyReply> {
  const now = o.now ?? Date.now;
  const listed = (await call(method.list, { global: true })) as ListResponse | null;
  if (!listed || !Array.isArray(listed.figaros)) throw new Error(`${method.list}: no rows in the reply`);
  const rows = listed.figaros.filter(live);
  const forms = new Map(rows.filter(isFormRow).map((r) => [r.id, r]));
  const arias = new Map(rows.filter(isAriaRow).map((r) => [r.id, r]));

  const children = new Map<string, string[]>();
  for (const f of forms.values()) {
    const p = placedUnder(f, forms);
    if (p) (children.get(p) ?? children.set(p, []).get(p)!).push(f.id);
  }

  let roots: string[];
  if (o.root !== undefined) {
    if (!forms.has(o.root)) return { status: "denied", reason: `${o.root} is not visible to this caller` };
    roots = [o.root];
  } else {
    roots = [...forms.values()].filter((f) => !placedUnder(f, forms) && f.target_aria).map((f) => f.id);
  }
  roots.sort();

  const wanted = new Set<string>();
  for (const r of roots) for (const id of subtree(r, children)) wanted.add(id);

  const states = new Map<string, JsonObject>();
  await Promise.all(
    [...wanted].map(async (id) => {
      try {
        const res = (await call(method.form, { figaro_id: id })) as FormResponse | null;
        states.set(id, res?.snapshot ?? {});
      } catch (e) {
        if (!(e instanceof RpcError && e.code === errDenied)) throw e;
      }
    }),
  );

  const orders: HierarchyOrder[] = [];
  for (const root of roots) {
    if (!states.has(root)) continue;
    orders.push(order(root, children, forms, arias, states));
  }
  if (o.root !== undefined && orders.length === 0) return { status: "denied", reason: `${o.root} is not readable by this caller` };
  if (orders.length === 0) return { status: "empty", observed_at: now() };
  return { status: "current", observed_at: now(), orders };
}

function subtree(root: string, children: ReadonlyMap<string, readonly string[]>, keep?: (id: string) => boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || (keep && !keep(id))) continue;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

function placedUnder(f: AriaRow, forms: ReadonlyMap<string, AriaRow>): string {
  return [f.present, f.parent].find((p) => p && forms.has(p)) ?? "";
}

function order(
  root: string,
  children: ReadonlyMap<string, readonly string[]>,
  forms: ReadonlyMap<string, AriaRow>,
  arias: ReadonlyMap<string, AriaRow>,
  states: ReadonlyMap<string, JsonObject>,
): HierarchyOrder {
  const ids = subtree(root, children, (id) => states.has(id)).sort();
  const inOrder = new Set(ids);
  const handles = new Set(ids.map((id) => forms.get(id)?.handle).filter((h): h is string => !!h));

  const seats = new Set<string>();
  const out: HierarchyForm[] = [];
  for (const id of ids) {
    const row = forms.get(id)!;
    const target = row.target_aria && arias.has(row.target_aria) ? row.target_aria : undefined;
    if (target) seats.add(target);
    const state = publicState(states.get(id)!, (ref) => inOrder.has(ref) || handles.has(ref));
    out.push({
      id,
      ...(row.handle ? { handle: row.handle } : {}),
      parent: id !== root && inOrder.has(placedUnder(row, forms)) ? placedUnder(row, forms) : null,
      ...(target ? { target_aria: target } : {}),
      state,
    });
  }

  const drawn = (a: AriaRow): string => a.present || a.parent || "";
  const shown = new Set<string>(seats);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of arias.values()) {
      if (shown.has(a.id)) continue;
      const up = drawn(a);
      if (up && shown.has(up)) {
        shown.add(a.id);
        grew = true;
      }
    }
  }

  const topology: Record<string, string> = {};
  const outArias: HierarchyAria[] = [];
  for (const id of [...shown].sort()) {
    const a = arias.get(id)!;
    if (!seats.has(id)) topology[id] = drawn(a);
    outArias.push({
      id,
      ...(a.handle ? { handle: a.handle } : {}),
      state: a.state,
      ...(a.mantra ? { mantra: a.mantra } : {}),
      ...(a.parent && shown.has(a.parent) ? { parent: a.parent } : {}),
    });
  }
  return { root, forms: out, topology, arias: outArias };
}

function publicState(snap: JsonObject, visible: (ref: string) => boolean): JsonObject {
  const out: Record<string, Json> = {};
  for (const k of publicStateKeys) {
    const v = snap[k];
    if (v === undefined) continue;
    if (k === "reports-to") {
      if (typeof v === "string" && visible(v)) out[k] = v;
      continue;
    }
    if (k === "lifecycle") {
      if (typeof v === "string") out[k] = v;
      else if (isObject(v) && typeof v.status === "string") out[k] = { status: v.status };
      continue;
    }
    if (k === "lanes") {
      if (isObject(v)) {
        const lanes = Object.fromEntries(Object.entries(v).filter(([, h]) => typeof h === "string"));
        if (Object.keys(lanes).length > 0) out[k] = lanes;
      }
      continue;
    }
    if (k === "owns") {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
      continue;
    }
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
