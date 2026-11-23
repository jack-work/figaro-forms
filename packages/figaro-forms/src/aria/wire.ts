import type { Json } from "../json.js";
import { method } from "../wire.js";

export const ariaMethod = {
  frame: "figaro.aria",
  turnDone: "turn.done",
  closed: method.closed,
  read: "figaro.read",
  follow: method.follow,
  unfollow: method.unfollow,
  qua: "figaro.qua",
  interrupt: "figaro.interrupt",
  fork: "figaro.fork",
  list: method.list,
} as const;

export interface Anchor {
  readonly turn: number;
  readonly node: number;
}

export interface Delta {
  readonly at: number;
  readonly del: number;
  readonly ins: string;
}

export interface Src {
  readonly lt: number;
  readonly block: number;
}

export const roleInput = "input";
export const roleOutput = "output";

export type NodeType = "prose" | "thinking" | "tool" | "steering" | (string & {});

export type FormKind = "bound" | "studied" | "role" | (string & {});
export type FormEvent = "set" | "removed" | "deleted" | (string & {});

export interface TranscriptFormDelta {
  readonly value?: Json;
  readonly prev?: Json;
  readonly kind: FormKind;
  readonly event?: FormEvent;
  readonly form: string;
}

export interface Node {
  readonly type: NodeType;
  readonly role?: "input" | "output" | (string & {});
  readonly lts?: readonly number[];
  readonly src?: readonly Src[];
  readonly tool_call_id?: string;
  readonly v?: number;
  readonly at?: number;
  readonly markdown?: string;
  readonly sender?: string;
  readonly sender_name?: string;
  readonly id?: string;
  readonly name?: string;
  readonly args?: { readonly [name: string]: Json };
  readonly status?: "running" | "ok" | "error" | (string & {});
  readonly input?: string;
  readonly output?: string;
  readonly output_base?: number;
  readonly summary?: string;
  readonly label?: string;
  readonly head_arg?: string;
  readonly body_arg?: string;
  readonly diff?: boolean;
  readonly opened_at?: number;
  readonly started_at?: number;
  readonly finished_at?: number;
  readonly formDeltas?: { readonly [key: string]: TranscriptFormDelta };
}

export interface NodeDelta {
  readonly id: number;
  readonly set?: { readonly [field: string]: Json };
  readonly unset?: readonly string[];
  readonly patch?: { readonly [field: string]: Delta };
}

export interface Live {
  readonly from: number;
  readonly v: number;
  readonly nodes?: readonly NodeDelta[];
}

export interface InquirySegment {
  readonly sender?: string;
  readonly name?: string;
  readonly text: string;
}

export interface Turn {
  readonly turn: number;
  readonly inquiry?: string;
  readonly inquiry_segments?: readonly InquirySegment[];
  readonly at?: number;
  readonly formDeltas?: { readonly [key: string]: TranscriptFormDelta };
  readonly forked_from?: string;
  readonly lts?: readonly number[];
  readonly sealed: boolean;
  readonly nodes?: readonly Node[];
  readonly live?: Live;
}

export interface TurnPart extends Turn {
  readonly from: number;
  readonly clipped_head?: boolean;
  readonly clipped_tail?: boolean;
}

export interface Metrics {
  readonly context_tokens: number;
  readonly context_exact: boolean;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly mantra?: string;
}

export interface More {
  readonly before?: boolean;
  readonly after?: boolean;
}

export interface Page {
  readonly parts: readonly TurnPart[];
  readonly more: More;
  readonly next?: Anchor;
  readonly prev?: Anchor;
  readonly metrics?: Metrics;
}

export interface AriaFrame extends Page {
  readonly figaro_id: string;
}

export interface DoneEntry {
  readonly reason: string;
  readonly idle?: boolean;
}

export interface TurnDone extends DoneEntry {
  readonly figaro_id: string;
}

export interface ReadRequest {
  readonly figaro_id: string;
  readonly at?: Anchor;
  readonly backward?: boolean;
  readonly limit?: number;
  readonly floor?: Anchor;
}

export interface QuaImage {
  readonly mime_type?: string;
  readonly data: string;
}

export interface QuaResponse {
  readonly ok: boolean;
  readonly cursor: number;
  readonly active?: boolean;
}

export type QueueDisposition = "keep" | "clear";

export interface InterruptResponse {
  readonly ok: boolean;
  readonly stopped?: boolean;
  readonly cleared?: boolean;
  readonly epoch?: string;
  readonly queue?: readonly { readonly [field: string]: Json }[];
}

export interface ForkRequest {
  readonly figaro_id: string;
  readonly at_turn?: number;
  readonly at_lt?: number;
  readonly outfits?: readonly string[];
}

export interface ForkResponse {
  readonly parent: string;
  readonly continuation: string;
  readonly alternative: string;
  readonly owner_note?: string;
}

export interface ListRequest {
  readonly global?: boolean;
  readonly limit?: number;
  readonly before?: string;
  readonly ids_only?: boolean;
}

export interface AriaRow {
  readonly id: string;
  readonly short?: string;
  readonly handle?: string;
  readonly node?: string;
  readonly state: "active" | "idle" | "dormant" | (string & {});
  readonly mantra?: string;
  readonly parent?: string;
  readonly present?: string;
  readonly trunk?: string;
  readonly vector?: readonly number[];
  readonly roles?: readonly string[];
  readonly kind?: string;
  readonly created_at?: number;
  readonly last_active?: number;
  readonly message_count?: number;
  readonly retired_at?: number;
  readonly reaped_at?: number;
  readonly name?: string;
  readonly target_aria?: string;
  readonly outfit_name?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface ListResponse {
  readonly figaros: readonly AriaRow[];
  readonly next_before?: string;
  readonly refused?: number;
  readonly refused_why?: string;
  readonly unreachable?: readonly { readonly [field: string]: Json }[];
}
