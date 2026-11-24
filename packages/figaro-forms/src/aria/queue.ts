import { isObject, type Json, type JsonObject } from "../json.js";
import { glyphs } from "../glyphs.gen.js";
import type { FormsClient } from "../client.js";
import type { Freshness } from "../replica.js";
import type { AriaClient } from "./client.js";
import { errorOf, feedOf, idle, ReplicaFeed, readyOf, type Feed } from "./feeds.js";
import type { InterruptResponse } from "./wire.js";

export const queueIntrinsic = "queue";

export const queueRef = (aria: string): string => `${aria}/${queueIntrinsic}`;

export type QueueRowState = "queued" | "committing" | "committed" | "merged" | "dropped" | "drained" | (string & {});

export interface QueueRow {
  readonly id: number;
  readonly text: string;
  readonly sender: string | undefined;
  readonly state: QueueRowState;
  readonly at: number | undefined;
  readonly into: number | undefined;
  readonly turn: number | undefined;
  readonly merged: readonly number[];
}

export interface QueueView {
  readonly epoch: string;
  readonly rows: readonly QueueRow[];
  readonly departed: readonly QueueRow[];
}

export const emptyQueue: QueueView = { epoch: "", rows: [], departed: [] };

const live = (r: QueueRow): boolean => r.state === "queued" || r.state === "committing";

const text = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const count = (v: Json | undefined): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);

function idOf(key: string): number | undefined {
  if (!/^[0-9]+$/.test(key)) return undefined;
  const n = Number(key);
  return Number.isSafeInteger(n) ? n : undefined;
}

function rowOf(id: number, v: JsonObject): QueueRow {
  const merged = Array.isArray(v.merged) ? v.merged.filter((n): n is number => typeof n === "number") : [];
  return {
    id,
    text: text(v.text) ?? "",
    sender: text(v.sender),
    state: text(v.state) ?? "",
    at: count(v.at),
    into: count(v.into),
    turn: count(v.turn),
    merged,
  };
}

export function foldQueue(root: JsonObject): QueueView {
  const items = root.items;
  const byId = new Map<number, QueueRow>();
  if (isObject(items)) {
    for (const [key, v] of Object.entries(items)) {
      const id = idOf(key);
      if (id !== undefined && isObject(v)) byId.set(id, rowOf(id, v));
    }
  }
  const all: QueueRow[] = [];
  const seen = new Set<number>();
  if (Array.isArray(root.order)) {
    for (const n of root.order) {
      if (typeof n !== "number" || seen.has(n)) continue;
      const r = byId.get(n);
      if (!r) continue;
      seen.add(n);
      all.push(r);
    }
  }
  const rest = [...byId.values()].filter((r) => !seen.has(r.id)).sort((a, b) => a.id - b.id);
  all.push(...rest);
  return {
    epoch: text(root.epoch) ?? "",
    rows: all.filter(live),
    departed: all.filter((r) => !live(r)),
  };
}

export const queueMark = (row: QueueRow): string => (row.state === "committing" ? glyphs["queue.committing"] : glyphs["queue.waiting"]);

export type QueueRejection = "committing" | "committed" | "merged" | "stale" | "unknown" | "closed" | (string & {});

export interface QueueResult {
  readonly id: number;
  readonly outcome: "deleted" | "updated" | "rejected" | (string & {});
  readonly reason?: QueueRejection;
  readonly detail?: string;
  readonly into?: number;
}

export interface QueueDeleteResponse {
  readonly epoch: string;
  readonly results: readonly QueueResult[];
}

export interface QueueUpdateResponse {
  readonly epoch: string;
  readonly result: QueueResult;
}

export const queueMethod = {
  delete: "figaro.queue.delete",
  update: "figaro.queue.update",
} as const;

export interface QueueActions {
  drop(id: number): Promise<QueueDeleteResponse>;
  edit(id: number, text: string): Promise<QueueUpdateResponse>;
  hangUp(): Promise<InterruptResponse>;
}

export function queueActions(client: AriaClient, aria: string, epoch: () => string): QueueActions {
  const stamped = (): { readonly epoch?: string } => {
    const e = epoch();
    return e === "" ? {} : { epoch: e };
  };
  return {
    drop: (id) => client.connection.call<QueueDeleteResponse>(queueMethod.delete, { figaro_id: aria, ...stamped(), ids: [id] }),
    edit: (id, body) => client.connection.call<QueueUpdateResponse>(queueMethod.update, { figaro_id: aria, ...stamped(), id, text: body }),
    hangUp: () => client.interrupt(aria, { queue: "keep" }),
  };
}

export const queueActionsOf = (client: AriaClient, aria: string): QueueActions => queueActions(client, aria, () => foldQueue(client.forms.peek(queueRef(aria)).root).epoch);

export interface QueueState extends QueueView {
  readonly aria: string;
  readonly ready: boolean;
  readonly freshness: Freshness;
  readonly error: string | undefined;
}

export function queueFeed(forms: () => FormsClient, aria: string): Feed<QueueState> {
  return new ReplicaFeed<QueueState>(
    forms,
    queueRef(aria),
    (r) => ({ aria, ready: readyOf(r), freshness: r.status.freshness, error: errorOf(r), ...foldQueue(r.root) }),
    { aria, ...idle, ...emptyQueue },
  );
}

export const queueFeedOf = (client: AriaClient, aria: string): Feed<QueueState> => feedOf(client, `queue\0${aria}`, () => queueFeed(() => client.forms, aria));
