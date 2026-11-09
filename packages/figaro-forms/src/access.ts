import type { FormAccess, KeyDeny } from "./wire.js";
import type { Path } from "./path.js";

export interface Refusal {
  readonly key: string;
  readonly kind: string;
  readonly reason: string;
}

export function keyUnder(path: string, key: string): boolean {
  return path === key || path.startsWith(key + ".") || path.startsWith(key + "[");
}

export function denies(d: KeyDeny, path: string): boolean {
  if (d.exact) {
    if (path !== d.key) return false;
  } else if (d.below) {
    if (!path.startsWith(d.key)) return false;
  } else if (!keyUnder(path, d.key)) {
    return false;
  }
  return !(d.except ?? []).some((e) => keyUnder(path, e));
}

export function writable(access: FormAccess | undefined): boolean {
  return access === undefined || access.mode !== "read";
}

export function refusalOf(access: FormAccess | undefined, path: Path | string): Refusal | undefined {
  const key = typeof path === "string" ? path : path.join(".");
  if (!access) return undefined;
  if (access.mode === "read") return { key, kind: "read-only", reason: "this form is read-only to you" };
  for (const d of access.deny ?? []) {
    if (denies(d, key)) return { key, kind: d.kind, reason: d.reason };
  }
  return undefined;
}
