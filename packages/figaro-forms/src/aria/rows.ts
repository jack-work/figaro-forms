import { compareStrings, isObject, type Json, type JsonObject } from "../json.js";

export const moreOf = (root: JsonObject): number => {
  const n = root.more;
  return typeof n === "number" && n > 0 ? n : 0;
};

export const text = (v: Json | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const num = (v: Json | undefined): number | undefined => (typeof v === "number" ? v : undefined);

export const byRecent = (a: { activeAt: number | undefined; sortKey: string }, b: { activeAt: number | undefined; sortKey: string }): number => {
  const d = (b.activeAt ?? 0) - (a.activeAt ?? 0);
  return d !== 0 ? d : compareStrings(a.sortKey, b.sortKey);
};

export function rowsOf(level: Json | undefined): [string, JsonObject][] {
  if (!isObject(level)) return [];
  const out: [string, JsonObject][] = [];
  for (const k of Object.keys(level)) {
    const v = level[k];
    if (isObject(v)) out.push([k, v]);
  }
  return out;
}
