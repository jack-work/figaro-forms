import { copyObject, equal, has, isObject, member, nullish, put, type Json, type JsonObject } from "./json.js";

export interface ScalarPatch {
  readonly Before: Json;
  readonly After: Json;
}

export interface ObjectPatch {
  readonly Set?: { readonly [key: string]: Json };
  readonly Delete?: { readonly [key: string]: Json };
  readonly Update?: { readonly [key: string]: Patch };
  readonly New?: { readonly [key: string]: boolean };
}

export interface KeyedValue {
  readonly Key: string;
  readonly Value: Json;
}

export interface Order {
  readonly Declared: readonly string[] | null;
  readonly Moved: readonly number[] | null;
  readonly Prior?: readonly string[] | null;
  readonly PriorMoved?: readonly number[] | null;
}

export interface ListPatch {
  readonly Create?: readonly KeyedValue[];
  readonly Delete?: readonly KeyedValue[];
  readonly Update?: { readonly [key: string]: Patch };
  readonly Order?: Order | null;
}

export interface Patch {
  readonly scalar?: ScalarPatch;
  readonly object?: ObjectPatch;
  readonly list?: ListPatch;
}

export const identity: Patch = Object.freeze({});

const unchanged = Symbol("unchanged");
type Outcome = Json | typeof unchanged;

function entries<T>(m: { readonly [key: string]: T } | undefined): [string, T][] {
  return m ? Object.entries(m) : [];
}

function own<T>(m: { readonly [key: string]: T } | undefined, k: string): T | undefined {
  return m && Object.hasOwn(m, k) ? m[k] : undefined;
}

function define<T>(m: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(m, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function size(m: object | undefined): number {
  return m ? Object.keys(m).length : 0;
}

export function isIdentity(p: Patch): boolean {
  if (p.scalar) return equal(p.scalar.Before, p.scalar.After);
  if (p.object) {
    const o = p.object;
    if (size(o.Set) > 0 || size(o.Delete) > 0) return false;
    return entries(o.Update).every(([, c]) => isIdentity(c));
  }
  if (p.list) {
    const l = p.list;
    if ((l.Create?.length ?? 0) > 0 || (l.Delete?.length ?? 0) > 0 || l.Order) return false;
    return entries(l.Update).every(([, c]) => isIdentity(c));
  }
  return true;
}

export function apply(p: Patch, v: Json | undefined): Json {
  if (p.scalar) return p.scalar.After;
  if (p.object) return applyObjectValue(p, p.object, v);
  if (p.list) return applyList(p.list, v);
  return v ?? null;
}

function applyObjectValue(p: Patch, o: ObjectPatch, v: Json | undefined): Json {
  let base: JsonObject;
  if (isObject(v)) base = v;
  else if (!nullish(v) || isIdentity(p)) return v ?? null;
  else base = {};
  const next = applyObject(base, o);
  return isObject(v) && next === base ? v : next;
}

export function applyObject(t: JsonObject, o: ObjectPatch): JsonObject {
  let out: Record<string, Json> | undefined;
  const cur = (): JsonObject => out ?? t;
  const write = (): Record<string, Json> => (out ??= copyObject(t));
  for (const [k] of entries(o.Delete)) {
    if (has(cur(), k)) delete write()[k];
  }
  for (const [k, v] of entries(o.Set)) {
    const c = cur();
    if (has(c, k) && equal(c[k], v)) continue;
    put(write(), k, v);
  }
  for (const [k, child] of entries(o.Update)) {
    const c = cur();
    const next = applyAt(has(c, k), member(c, k), child);
    if (next !== unchanged) put(write(), k, next);
  }
  return out ?? t;
}

function applyAt(exists: boolean, cur: Json | undefined, p: Patch): Outcome {
  if (isIdentity(p)) return unchanged;
  if (p.scalar) {
    if (exists && !isObject(cur) && equal(cur, p.scalar.After)) return unchanged;
    return p.scalar.After;
  }
  if (p.object) {
    let kids: JsonObject;
    if (!exists) kids = {};
    else if (isObject(cur)) kids = cur;
    else if (!nullish(cur)) return unchanged;
    else kids = {};
    const sub = applyObject(kids, p.object);
    if (exists && isObject(cur) && sub === kids) return unchanged;
    return sub;
  }
  if (p.list) {
    if (!exists || isObject(cur)) return unchanged;
    const next = applyList(p.list, cur);
    return equal(next, cur) ? unchanged : next;
  }
  return unchanged;
}

function decodeList(v: Json | undefined): KeyedValue[] | undefined {
  if (nullish(v)) return [];
  if (!Array.isArray(v)) return undefined;
  const out: KeyedValue[] = [];
  for (const it of v as readonly Json[]) {
    if (it === null) {
      out.push({ Key: "", Value: null });
      continue;
    }
    if (!isObject(it)) return undefined;
    const key = member(it, "Key");
    if (key !== undefined && key !== null && typeof key !== "string") return undefined;
    out.push({ Key: key ?? "", Value: member(it, "Value") ?? null });
  }
  return out;
}

function applyList(l: ListPatch, v: Json | undefined): Json {
  const items = decodeList(v);
  if (!items) return v ?? null;
  const byKey = new Map<string, Json>();
  let order: string[] = [];
  for (const it of items) {
    byKey.set(it.Key, it.Value);
    order.push(it.Key);
  }
  for (const d of l.Delete ?? []) {
    if (byKey.has(d.Key)) {
      byKey.delete(d.Key);
      order = removeKey(order, d.Key);
    }
  }
  for (const c of l.Create ?? []) {
    if (!byKey.has(c.Key)) order.push(c.Key);
    byKey.set(c.Key, c.Value);
  }
  for (const [k, child] of entries(l.Update)) {
    if (!byKey.has(k)) continue;
    byKey.set(k, apply(child, byKey.get(k)));
  }
  if (l.Order) order = applyOrder(order, l.Order);
  return order.map((k) => ({ Key: k, Value: byKey.get(k) ?? null }));
}

function removeKey(order: string[], key: string): string[] {
  const i = order.indexOf(key);
  return i < 0 ? order : [...order.slice(0, i), ...order.slice(i + 1)];
}

function applyOrder(cur: string[], o: Order): string[] {
  const declaredKeys = o.Declared ?? [];
  if (declaredKeys.length === 0) return cur;
  const declared = new Set(declaredKeys);
  const seats: number[] = [];
  cur.forEach((k, i) => {
    if (declared.has(k)) seats.push(i);
  });
  const out = [...cur];
  let fill = 0;
  for (const k of declaredKeys) {
    if (fill >= seats.length) break;
    out[seats[fill] as number] = k;
    fill++;
  }
  return out;
}

function reversed(o: Order | null | undefined): Order | undefined {
  if (!o || !o.Prior || o.Prior.length === 0) return undefined;
  const r: { -readonly [K in keyof Order]: Order[K] } = { Declared: o.Prior, Moved: o.PriorMoved ?? null };
  if (o.Declared?.length) r.Prior = o.Declared;
  if (o.Moved?.length) r.PriorMoved = o.Moved;
  return r;
}

export function inverse(p: Patch): Patch {
  if (p.scalar) return { scalar: { Before: p.scalar.After, After: p.scalar.Before } };
  if (p.object) {
    const o = p.object;
    const set: Record<string, Json> | undefined = o.Delete ? { ...o.Delete } : undefined;
    let del: Record<string, Json> | undefined = o.Set ? { ...o.Set } : undefined;
    let update: Record<string, Patch> | undefined;
    for (const [k, c] of entries(o.Update)) {
      if (own(o.New, k)) {
        del ??= {};
        put(del, k, apply(c, {}));
        continue;
      }
      update ??= {};
      define(update, k, inverse(c));
    }
    return { object: objectPatch(set, del, update) };
  }
  if (p.list) {
    const l = p.list;
    const out: { -readonly [K in keyof ListPatch]: ListPatch[K] } = {};
    if (l.Delete?.length) out.Create = l.Delete;
    if (l.Create?.length) out.Delete = l.Create;
    if (size(l.Update) > 0) {
      const u: Record<string, Patch> = {};
      for (const [k, c] of entries(l.Update)) define(u, k, inverse(c));
      out.Update = u;
    }
    const r = reversed(l.Order);
    if (r) out.Order = r;
    return { list: out };
  }
  return identity;
}

function objectPatch(
  set?: Record<string, Json>,
  del?: Record<string, Json>,
  update?: Record<string, Patch>,
  isNew?: Record<string, boolean>,
): ObjectPatch {
  const o: { -readonly [K in keyof ObjectPatch]: ObjectPatch[K] } = {};
  if (set && size(set) > 0) o.Set = set;
  if (del && size(del) > 0) o.Delete = del;
  if (update && size(update) > 0) o.Update = update;
  if (isNew && size(isNew) > 0) o.New = isNew;
  return o;
}

export function tryMerge(p: Patch, q: Patch): Patch | undefined {
  if (isIdentity(p)) return q;
  if (isIdentity(q)) return p;
  if (p.scalar && q.scalar) return { scalar: { Before: p.scalar.Before, After: q.scalar.After } };
  if (p.scalar && q.object) return { scalar: { Before: p.scalar.Before, After: apply(q, p.scalar.After) } };
  if (p.object && q.object) {
    const o = tryMergeObject(p.object, q.object);
    return o ? { object: o } : undefined;
  }
  return undefined;
}

type Op = "none" | "set" | "delete" | "update" | "mixed";

function opOf(o: ObjectPatch, k: string): Op {
  let n = 0;
  let op: Op = "none";
  if (o.Set && has(o.Set, k)) [n, op] = [n + 1, "set"];
  if (o.Delete && has(o.Delete, k)) [n, op] = [n + 1, "delete"];
  if (o.Update && Object.hasOwn(o.Update, k)) [n, op] = [n + 1, "update"];
  return n > 1 ? "mixed" : op;
}

interface Building {
  set: Record<string, Json>;
  del: Record<string, Json>;
  update: Record<string, Patch>;
  isNew: Record<string, boolean>;
}

function tryMergeObject(p: ObjectPatch, q: ObjectPatch): ObjectPatch | undefined {
  const out: Building = { set: {}, del: {}, update: {}, isNew: {} };
  const keys = new Set<string>();
  for (const o of [p, q]) {
    for (const m of [o.Set, o.Delete, o.Update]) for (const k of Object.keys(m ?? {})) keys.add(k);
  }
  for (const k of keys) {
    if (!mergeKey(out, k, p, q)) return undefined;
  }
  return objectPatch(out.set, out.del, out.update, out.isNew);
}

function mergeKey(out: Building, k: string, p: ObjectPatch, q: ObjectPatch): boolean {
  const pOp = opOf(p, k);
  const qOp = opOf(q, k);
  if (pOp === "mixed" || qOp === "mixed") return false;
  if (qOp === "none") copyOp(out, p, k);
  else if (pOp === "none") copyOp(out, q, k);
  else if (qOp === "set" || qOp === "delete") copyOp(out, q, k);
  else if (pOp === "delete") {
    put(out.del, k, own(p.Delete, k) ?? null);
    copyOp(out, q, k);
  } else if (pOp === "set") {
    put(out.set, k, apply(own(q.Update, k) ?? identity, own(p.Set, k) ?? null));
  } else if (own(q.Update, k)?.scalar) {
    put(out.set, k, (own(q.Update, k) as Patch).scalar?.After ?? null);
  } else {
    const child = tryMerge(own(p.Update, k) ?? identity, own(q.Update, k) ?? identity);
    if (!child) return false;
    putUpdate(out, k, child, !!own(p.New, k) || !!own(q.New, k));
  }
  return true;
}

function copyOp(out: Building, from: ObjectPatch, k: string): void {
  if (from.Set && has(from.Set, k)) put(out.set, k, from.Set[k] as Json);
  if (from.Delete && has(from.Delete, k)) put(out.del, k, from.Delete[k] as Json);
  const c = from.Update && Object.hasOwn(from.Update, k) ? from.Update[k] : undefined;
  if (c) putUpdate(out, k, c, !!own(from.New, k));
}

function putUpdate(out: Building, k: string, c: Patch, isNew: boolean): void {
  define(out.update, k, c);
  if (isNew) define(out.isNew, k, true);
}

export function setAt(base: Json | undefined, path: readonly string[], value: Json): Patch {
  if (path.length === 0) return { scalar: { Before: base ?? null, After: value } };
  const [head, ...rest] = path as [string, ...string[]];
  const obj = isObject(base) ? base : undefined;
  if (base !== undefined && !nullish(base) && !obj) {
    throw new Error(`set ${path.join(".")}: not an object`);
  }
  const exists = obj !== undefined && has(obj, head);
  const cur = obj ? member(obj, head) : undefined;
  if (rest.length === 0) {
    if (!exists) return { object: { Set: single(head, value) } };
    return { object: { Update: single(head, { scalar: { Before: cur ?? null, After: value } }) } };
  }
  const child = setAt(exists ? cur : undefined, rest, value);
  return { object: objectPatch(undefined, undefined, single(head, child), exists ? undefined : single(head, true)) };
}

export function deleteAt(base: Json | undefined, path: readonly string[]): Patch {
  if (path.length === 0) return identity;
  const [head, ...rest] = path as [string, ...string[]];
  const obj = isObject(base) ? base : undefined;
  const cur = obj ? member(obj, head) : undefined;
  if (rest.length === 0) return { object: { Delete: single(head, cur ?? null) } };
  return { object: { Update: single(head, deleteAt(cur, rest)) } };
}

function single<T>(key: string, value: T): Record<string, T> {
  const out: Record<string, T> = {};
  define(out, key, value);
  return out;
}

export function touchedKeys(p: Patch, prefix: readonly string[] = []): string[][] {
  const out: string[][] = [];
  const walk = (q: Patch, at: readonly string[]): void => {
    if (q.scalar || q.list) out.push([...at]);
    if (q.object) {
      for (const k of Object.keys(q.object.Set ?? {})) out.push([...at, k]);
      for (const k of Object.keys(q.object.Delete ?? {})) out.push([...at, k]);
      for (const [k, c] of entries(q.object.Update)) walk(c, [...at, k]);
    }
  };
  walk(p, prefix);
  return out;
}

export function applyRoot(p: Patch, root: JsonObject): JsonObject {
  if (p.object) return applyObject(root, p.object);
  if (p.scalar && isObject(p.scalar.After)) return equal(p.scalar.After, root) ? root : p.scalar.After;
  return root;
}
