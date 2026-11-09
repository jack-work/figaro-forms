import type { Json, JsonObject } from "../json.js";
import type { FormRef } from "../client.js";
import { intrinsicKeys, wellKnownKeys } from "./known-keys.gen.js";
import type { KeyDoc } from "./keys.js";

export type { KeyDoc, KeyMode } from "./keys.js";
export { intrinsicKeys, wellKnownKeys };

export const forms = {
  models: "@models",
  arias: "@arias",
  topology: "@topology",
  recent: "@recent",
  reaped: "@reaped",
  troupe: "@troupe",
} as const;

export const intrinsics = ["runtime", "queue"] as const;
export type Intrinsic = (typeof intrinsics)[number];

export type FormKind = "catalog" | "caller" | "unbound" | "aria" | "remote" | "unknown";

const catalogs = new Set<string>([forms.models, forms.reaped, forms.troupe]);
const callerForms = new Set<string>([forms.arias, forms.topology, forms.recent]);

export function kindOf(id: string): FormKind {
  if (catalogs.has(id)) return "catalog";
  if (callerForms.has(id)) return "caller";
  if (id.includes("/")) return "remote";
  if (/^@[0-9a-f]+$/.test(id)) return "unbound";
  if (/^[0-9a-f]+$/.test(id)) return "aria";
  return "unknown";
}

export function intrinsic(id: string, name: Intrinsic): FormRef {
  return { id, intrinsic: name };
}

export function isRole(form: JsonObject): boolean {
  return typeof form["target-aria"] === "string";
}

export function roleTarget(form: JsonObject): string | undefined {
  const t = Object.hasOwn(form, "target-aria") ? form["target-aria"] : undefined;
  return typeof t === "string" ? t : undefined;
}

function matches(pattern: string, key: string): boolean {
  const p = pattern.split(".");
  const k = key.split(".");
  if (p.length !== k.length) return false;
  return p.every((seg, i) => (seg.startsWith("<") && seg.endsWith(">")) || seg === k[i]);
}

export function describeKey(key: string, intrinsicName?: string): KeyDoc | undefined {
  const catalog = intrinsicName ? (intrinsicKeys[intrinsicName] ?? []) : wellKnownKeys;
  return catalog.find((d) => matches(d.key, key)) ?? catalog.find((d) => key.startsWith(d.key + "."));
}

export type TurnState = "idle" | "accepted" | "committing" | "thinking" | "tooling";

export interface Runtime {
  readonly state: TurnState | undefined;
  readonly turn: string | undefined;
  readonly since: number | undefined;
  readonly reason: string | undefined;
  readonly model: string | undefined;
  readonly busy: boolean;
}

const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: Json | undefined): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: Json | undefined): JsonObject | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;

export function runtimeOf(root: JsonObject): Runtime {
  const turn = obj(root.turn);
  const state = str(turn?.state) as TurnState | undefined;
  return {
    state,
    turn: str(turn?.id) ?? (num(turn?.id) !== undefined ? String(turn?.id) : undefined),
    since: num(turn?.since),
    reason: str(turn?.reason),
    model: str(root.model),
    busy: state !== undefined && state !== "idle",
  };
}

export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly sender: string | undefined;
  readonly state: string | undefined;
  readonly at: number | undefined;
}

export function queueOf(root: JsonObject): QueuedMessage[] {
  const items = obj(root.items) ?? {};
  const order = Array.isArray(root.order) ? (root.order as Json[]).filter((x): x is string => typeof x === "string") : Object.keys(items);
  return order.flatMap((id) => {
    const it = obj(items[id]);
    if (!it) return [];
    return [{ id, text: str(it.text) ?? "", sender: str(it.sender), state: str(it.state), at: num(it.at) }];
  });
}

export interface AriaSystem {
  readonly model: string | undefined;
  readonly provider: string | undefined;
  readonly cwd: string | undefined;
  readonly mantra: string | undefined;
  readonly forkedFrom: string | undefined;
  readonly studies: readonly string[];
}

export function ariaOf(root: JsonObject): AriaSystem {
  const sys = obj(root.system) ?? {};
  const studies = sys.studies;
  return {
    model: str(sys.model),
    provider: str(sys.provider),
    cwd: str(sys.cwd),
    mantra: str(root.mantra),
    forkedFrom: str(sys.forked_from),
    studies: Array.isArray(studies) ? (studies as Json[]).filter((x): x is string => typeof x === "string") : [],
  };
}
