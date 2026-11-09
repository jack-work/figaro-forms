import { isObject, member, type Json, type JsonObject } from "./json.js";

export type Path = readonly string[];
export type PathLike = string | Path;

export function resolve(root: Json | undefined, path: PathLike): Path {
  if (typeof path !== "string") return path;
  if (path === "") return [];
  const out: string[] = [];
  let cur: Json | undefined = root;
  let rest = path;
  while (rest !== "") {
    const obj = isObject(cur) ? cur : undefined;
    const seg = obj ? longestMember(obj, rest) : undefined;
    if (seg === undefined) {
      out.push(...rest.split("."));
      return out;
    }
    out.push(seg);
    cur = obj ? member(obj, seg) : undefined;
    rest = rest.length === seg.length ? "" : rest.slice(seg.length + 1);
  }
  return out;
}

function longestMember(obj: JsonObject, rest: string): string | undefined {
  if (Object.hasOwn(obj, rest)) return rest;
  let best: string | undefined;
  for (const name of Object.keys(obj)) {
    if (name.length < rest.length && rest.startsWith(name + ".") && name.length > (best?.length ?? -1)) best = name;
  }
  return best;
}

export function getAt(root: Json | undefined, path: Path): Json | undefined {
  let cur: Json | undefined = root;
  for (const seg of path) {
    if (!isObject(cur)) return undefined;
    cur = member(cur, seg);
  }
  return cur;
}

export function dotted(path: Path): string {
  return path.join(".");
}
