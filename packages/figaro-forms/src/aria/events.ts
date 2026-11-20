import type { Json } from "../json.js";
import type { Cursor } from "./cursor.js";
import type { InquirySegment, Metrics } from "./wire.js";

export type Kind = "input" | "prose" | "thinking" | "steering" | "tool" | "turn" | "metrics";

interface Base {
  readonly aria: string;
  readonly cursor: Cursor;
}

interface InTurn extends Base {
  readonly turn: number;
}

export interface Segment {
  readonly sender?: string;
  readonly senderName?: string;
  readonly text: string;
}

export interface InputEvent extends InTurn {
  readonly type: "input";
  readonly kind: "input";
  readonly text: string;
  readonly segments: readonly Segment[];
  readonly sender?: string;
  readonly senderName?: string;
  readonly at?: number;
}

interface TextDelta extends InTurn {
  readonly node: number;
  readonly text: string;
  readonly at: number;
  readonly del: number;
  readonly ins: string;
}

interface TextSettled extends InTurn {
  readonly node: number;
  readonly text: string;
}

export interface ProseDelta extends TextDelta {
  readonly type: "prose.delta";
  readonly kind: "prose";
}

export interface ProseSettled extends TextSettled {
  readonly type: "prose.settled";
  readonly kind: "prose";
}

export interface ThinkingDelta extends TextDelta {
  readonly type: "thinking.delta";
  readonly kind: "thinking";
}

export interface ThinkingSettled extends TextSettled {
  readonly type: "thinking.settled";
  readonly kind: "thinking";
}

export interface SteeringDelta extends TextDelta {
  readonly type: "steering.delta";
  readonly kind: "steering";
  readonly sender?: string;
  readonly senderName?: string;
}

export interface SteeringSettled extends TextSettled {
  readonly type: "steering.settled";
  readonly kind: "steering";
  readonly sender?: string;
  readonly senderName?: string;
}

export type ToolStatus = "running" | "ok" | "error";

export interface Tool {
  readonly node: number;
  readonly id?: string;
  readonly name?: string;
  readonly status: ToolStatus;
  readonly args?: { readonly [name: string]: Json };
  readonly input?: string;
  readonly summary?: string;
  readonly output: string;
  readonly outputBase: number;
  readonly openedAt?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

export interface ToolStart extends InTurn {
  readonly type: "tool.start";
  readonly kind: "tool";
  readonly tool: Tool;
}

export interface ToolUpdate extends InTurn {
  readonly type: "tool.update";
  readonly kind: "tool";
  readonly tool: Tool;
}

export interface ToolEnd extends InTurn {
  readonly type: "tool.end";
  readonly kind: "tool";
  readonly tool: Tool;
  readonly result: string;
  readonly failed: boolean;
}

export interface TurnEnd extends InTurn {
  readonly type: "turn.end";
  readonly kind: "turn";
  readonly reason?: string;
  readonly idle?: boolean;
  readonly replayed: boolean;
}

export interface TurnError extends InTurn {
  readonly type: "turn.error";
  readonly kind: "turn";
  readonly reason: string;
  readonly idle?: boolean;
}

export interface MetricsEvent extends Base {
  readonly type: "metrics";
  readonly kind: "metrics";
  readonly metrics: Metrics;
}

export type AriaEvent =
  | InputEvent
  | ProseDelta
  | ProseSettled
  | ThinkingDelta
  | ThinkingSettled
  | SteeringDelta
  | SteeringSettled
  | ToolStart
  | ToolUpdate
  | ToolEnd
  | TurnEnd
  | TurnError
  | MetricsEvent;

export type EventType = AriaEvent["type"];

export type Uncursored = AriaEvent extends infer E ? (E extends AriaEvent ? Omit<E, "cursor"> : never) : never;

export type EventOf<K extends Kind> = Extract<AriaEvent, { readonly kind: K }>;

export type EventFilter = Kind | readonly Kind[] | { readonly kind?: Kind | readonly Kind[]; readonly type?: EventType | readonly EventType[]; readonly turn?: number };

export function matches(filter: EventFilter | undefined, e: AriaEvent): boolean {
  if (filter === undefined) return true;
  const spec = typeof filter === "string" || Array.isArray(filter) ? { kind: filter as Kind | readonly Kind[] } : (filter as Exclude<EventFilter, Kind | readonly Kind[]>);
  if (spec.kind !== undefined && !(Array.isArray(spec.kind) ? spec.kind : [spec.kind]).includes(e.kind)) return false;
  if (spec.type !== undefined && !(Array.isArray(spec.type) ? spec.type : [spec.type]).includes(e.type)) return false;
  if (spec.turn !== undefined && !("turn" in e && e.turn === spec.turn)) return false;
  return true;
}

export interface InputView {
  readonly text: string;
  readonly segments: readonly Segment[];
  readonly sender?: string;
  readonly senderName?: string;
  readonly at?: number;
}

export interface TextNodeView {
  readonly kind: "prose" | "thinking" | "steering";
  readonly node: number;
  readonly text: string;
  readonly settled: boolean;
  readonly sender?: string;
  readonly senderName?: string;
}

export interface ToolNodeView {
  readonly kind: "tool";
  readonly node: number;
  readonly settled: boolean;
  readonly tool: Tool;
}

export type NodeView = TextNodeView | ToolNodeView;

export interface TurnEndView {
  readonly reason?: string;
  readonly idle?: boolean;
  readonly failed: boolean;
}

export interface TurnView {
  readonly turn: number;
  readonly input?: InputView;
  readonly nodes: readonly NodeView[];
  readonly sealed: boolean;
  readonly end?: TurnEndView;
}

export function segmentsOf(segments: readonly InquirySegment[] | undefined, text: string): readonly Segment[] {
  if (!segments || segments.length === 0) return text === "" ? [] : [{ text }];
  return segments.map((s) => ({ ...(s.sender ? { sender: s.sender } : {}), ...(s.name ? { senderName: s.name } : {}), text: s.text }));
}
