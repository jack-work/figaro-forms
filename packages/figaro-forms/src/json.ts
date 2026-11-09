export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export type JsonObject = { readonly [key: string]: Json };

export function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function nullish(v: Json | undefined): boolean {
  return v === undefined || v === null;
}

export function has(o: JsonObject, key: string): boolean {
  return Object.hasOwn(o, key);
}

export function member(o: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

export function put(o: Record<string, Json>, key: string, value: Json): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

export function copyObject(o: JsonObject): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of Object.keys(o)) put(out, k, o[k] as Json);
  return out;
}

export function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return nullish(a) && nullish(b);
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equal(x, (b as readonly Json[])[i]));
  }
  if (Array.isArray(b)) return false;
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => has(bo, k) && equal(ao[k], bo[k]));
}

export function canonical(v: Json | undefined): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
