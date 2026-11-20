import type { Json } from "../json.js";
import { anchorOfCursor, formatCursor, parseCursor, type Cursor } from "./cursor.js";
import {
  segmentsOf,
  type AriaEvent,
  type InputView,
  type NodeView,
  type Tool,
  type ToolStatus,
  type TurnEndView,
  type TurnView,
  type Uncursored,
} from "./events.js";
import { diffText, spliceBytes } from "./utf8.js";
import type { Anchor, Metrics, NodeDelta, Page, TurnPart, Node } from "./wire.js";

type Raw = { -readonly [K in keyof Node]?: Node[K] } & { type?: string };

interface NodeState {
  raw: Raw;
  settled: boolean;
  toldStarted: boolean;
  toldText: string;
  toldTool: string | undefined;
  toldSettled: boolean;
  toldEnd: boolean;
}

interface Done {
  readonly reason: string;
  readonly idle: boolean | undefined;
}

interface TurnState {
  readonly id: number;
  input: InputView | undefined;
  inputTold: boolean;
  nodes: (NodeState | undefined)[];
  lowest: number;
  sealed: boolean;
  replaySeal: boolean;
  tailPending: boolean;
  superseded: boolean;
  ver: number;
  done: Done | undefined;
  doneTold: boolean;
  endTold: boolean;
}

export type FoldMode = "read" | "push";

export interface Folded {
  readonly resync: boolean;
}

export interface TranscriptOptions {
  readonly aria: string;
  readonly from?: Cursor;
  readonly emit: (e: AriaEvent) => void;
}

const textTypes = new Set(["prose", "thinking", "steering"]);

export class Transcript {
  private readonly aria: string;
  private readonly out: (e: AriaEvent) => void;
  private readonly turns = new Map<number, TurnState>();
  private readonly order: number[] = [];
  private readonly dirty = new Set<number>();
  private readonly viewDirty = new Set<number>();
  private readonly viewCache = new Map<number, TurnView>();
  private viewList: readonly TurnView[] = [];
  private newest = 0;
  private base = 0;
  private floorTurn = 0;
  private floorPos = 0;
  private metrics: Metrics | undefined;
  private metricsKey = "";
  private metricsDirty = false;
  private revision = 0;
  private muted = false;

  constructor(o: TranscriptOptions) {
    this.aria = o.aria;
    this.out = o.emit;
    const floor = o.from === undefined ? undefined : parseCursor(o.from);
    if (floor) {
      this.floorTurn = floor.turn;
      this.floorPos = floor.pos;
    }
  }

  get version(): number {
    return this.revision;
  }

  get latestMetrics(): Metrics | undefined {
    return this.metrics;
  }

  get newestTurn(): number {
    return this.newest;
  }

  oldestHeld(): Anchor | undefined {
    const id = this.order[0];
    const t = id === undefined ? undefined : this.turns.get(id);
    return t ? { turn: t.id, node: t.lowest } : undefined;
  }

  quietly(fn: () => void): void {
    this.muted = true;
    try {
      fn();
    } finally {
      this.muted = false;
    }
  }

  fold(page: Page, mode: FoldMode): Folded {
    let resync = false;
    for (const part of page.parts) {
      if (this.foldPart(part, mode)) resync = true;
    }
    if (page.metrics) {
      const key = JSON.stringify(page.metrics);
      if (key !== this.metricsKey) {
        this.metricsKey = key;
        this.metrics = page.metrics;
        this.metricsDirty = true;
      }
    }
    this.revision++;
    return { resync };
  }

  done(reason: string, idle: boolean | undefined): void {
    const t = this.turns.get(this.newest);
    if (!t) return;
    t.done = { reason, idle };
    t.doneTold = false;
    this.touch(t.id);
    this.revision++;
  }

  flush(): void {
    const ids = [...this.dirty].sort((a, b) => a - b);
    this.dirty.clear();
    for (const id of ids) {
      const t = this.turns.get(id);
      if (!t) continue;
      this.emitInput(t);
      for (let i = 0; i < t.nodes.length; i++) {
        const n = t.nodes[i];
        if (n) this.emitNode(t, i, n);
      }
      this.emitEnd(t);
    }
    if (this.metricsDirty && this.metrics) {
      this.metricsDirty = false;
      this.emit({ type: "metrics", kind: "metrics", aria: this.aria, metrics: this.metrics });
    }
  }

  resume(): Cursor {
    return formatCursor(this.position());
  }

  resumeAnchor(): Anchor {
    return anchorOfCursor(this.resume()) ?? { turn: 0, node: 0 };
  }

  view(): readonly TurnView[] {
    if (this.viewDirty.size === 0) return this.viewList;
    for (const id of this.viewDirty) {
      const t = this.turns.get(id);
      if (t) this.viewCache.set(id, this.buildTurn(t));
    }
    this.viewDirty.clear();
    this.viewList = this.order.map((id) => this.viewCache.get(id)).filter((v): v is TurnView => v !== undefined);
    return this.viewList;
  }

  private position(): { turn: number; pos: number } {
    while (this.base < this.order.length) {
      const t = this.turns.get(this.order[this.base] as number);
      if (t && !this.complete(t)) break;
      this.base++;
    }
    if (this.base >= this.order.length) {
      const last = this.order[this.order.length - 1];
      return last === undefined ? { turn: this.floorTurn, pos: this.floorPos } : { turn: last + 1, pos: 0 };
    }
    const t = this.turns.get(this.order[this.base] as number) as TurnState;
    if (t.input && !t.inputTold) return { turn: t.id, pos: 0 };
    let n = t.lowest;
    while (t.nodes[n]?.toldSettled) n++;
    return { turn: t.id, pos: 1 + n };
  }

  private complete(t: TurnState): boolean {
    return t.endTold || t.superseded;
  }

  private ensure(id: number): TurnState {
    let t = this.turns.get(id);
    if (t) return t;
    t = {
      id,
      input: undefined,
      inputTold: false,
      nodes: [],
      lowest: id === this.floorTurn ? Math.max(0, this.floorPos - 1) : 0,
      sealed: false,
      replaySeal: false,
      tailPending: false,
      superseded: false,
      ver: -1,
      done: undefined,
      doneTold: false,
      endTold: false,
    };
    this.turns.set(id, t);
    if (id > this.newest) {
      for (const olderId of this.order) {
        const older = this.turns.get(olderId) as TurnState;
        if (older.superseded) continue;
        older.superseded = true;
        this.settleAll(older);
        this.touch(older.id);
      }
      this.order.push(id);
      this.newest = id;
    } else {
      this.order.push(id);
      this.order.sort((a, b) => a - b);
      this.base = 0;
    }
    return t;
  }

  private touch(id: number): void {
    this.dirty.add(id);
    this.viewDirty.add(id);
  }

  private settleAll(t: TurnState): void {
    for (const n of t.nodes) if (n) n.settled = true;
  }

  private foldPart(part: TurnPart, mode: FoldMode): boolean {
    if (part.turn < this.floorTurn) return false;
    const t = this.ensure(part.turn);
    this.touch(t.id);
    const skipInput = part.turn === this.floorTurn && this.floorPos >= 1;
    if (!t.input && (part.inquiry || (part.inquiry_segments && part.inquiry_segments.length > 0))) {
      t.input = inputOf(part);
      if (skipInput) t.inputTold = true;
    }
    const floorNode = part.turn === this.floorTurn ? Math.max(0, this.floorPos - 1) : 0;
    const nodes = part.nodes ?? [];
    const liveFrom = part.live ? part.live.from : Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const idx = part.from + i;
      if (idx < floorNode) continue;
      const settled = part.sealed || idx < liveFrom;
      const cur = t.nodes[idx];
      if (cur?.settled) continue;
      t.nodes[idx] = absorb(cur, nodes[i] as Node, settled);
    }
    if (nodes.length > 0 && part.from < t.lowest && part.from >= floorNode) t.lowest = part.from;
    if (part.clipped_tail) t.tailPending = true;
    else if (nodes.length > 0 || part.sealed) t.tailPending = false;

    let resync = false;
    if (part.live && !t.sealed) resync = this.foldLive(t, part, mode);
    if (part.sealed) {
      t.sealed = true;
      if (mode === "read") t.replaySeal = true;
      t.ver = -1;
      this.settleAll(t);
    }
    return resync;
  }

  private foldLive(t: TurnState, part: TurnPart, mode: FoldMode): boolean {
    const live = part.live;
    if (!live) return false;
    const deltas = live.nodes ?? [];
    if (deltas.length > 0) {
      if (live.v === 0) {
        t.ver = 0;
      } else if (live.v <= t.ver) {
        return false;
      } else if (live.v === t.ver + 1) {
        t.ver = live.v;
      } else {
        return true;
      }
      for (const d of deltas) this.applyDelta(t, d, live.from);
      return false;
    }
    if (mode === "read" || (part.nodes && part.nodes.length > 0)) {
      t.ver = live.v;
      return false;
    }
    if (t.ver === live.v || (t.ver === -1 && live.v === 0 && !t.nodes.some((n) => n && !n.settled))) {
      this.settleAll(t);
      t.ver = -1;
      return false;
    }
    return t.ver < live.v;
  }

  private applyDelta(t: TurnState, d: NodeDelta, liveFrom: number): void {
    if (t.id === this.floorTurn && d.id < this.floorPos - 1) return;
    let n = t.nodes[d.id];
    if (n?.settled) return;
    if (!n) {
      n = blank();
      t.nodes[d.id] = n;
      if (d.id < t.lowest) t.lowest = d.id;
    }
    if (d.id < liveFrom) n.settled = true;
    const raw = n.raw as Record<string, unknown>;
    if (d.set) for (const [k, v] of Object.entries(d.set)) raw[k] = v;
    if (d.unset) for (const k of d.unset) delete raw[k];
    if (d.patch) {
      for (const [field, dl] of Object.entries(d.patch)) {
        const prev = typeof raw[field] === "string" ? (raw[field] as string) : "";
        raw[field] = spliceBytes(prev, dl.at, dl.del, dl.ins);
      }
    }
  }

  private emit(e: Uncursored): void {
    if (this.muted) return;
    this.out({ ...e, cursor: this.resume() } as AriaEvent);
  }

  private emitInput(t: TurnState): void {
    if (!t.input || t.inputTold) return;
    t.inputTold = true;
    const i = t.input;
    this.emit({
      type: "input",
      kind: "input",
      aria: this.aria,
      turn: t.id,
      text: i.text,
      segments: i.segments,
      ...(i.sender !== undefined ? { sender: i.sender } : {}),
      ...(i.senderName !== undefined ? { senderName: i.senderName } : {}),
      ...(i.at !== undefined ? { at: i.at } : {}),
    });
  }

  private emitNode(t: TurnState, idx: number, n: NodeState): void {
    const type = n.raw.type;
    if (!type) return;
    if (type === "tool") {
      this.emitTool(t, idx, n);
      return;
    }
    if (!textTypes.has(type)) {
      this.emitUnknown(t, idx, n, type);
      return;
    }
    this.emitText(t, idx, n, type as "prose" | "thinking" | "steering");
  }

  private emitUnknown(t: TurnState, idx: number, n: NodeState, nodeType: string): void {
    const text = n.raw.markdown;
    if (!n.settled) {
      if (text !== undefined && text !== n.toldText) {
        n.toldText = text;
        n.toldStarted = true;
        this.emit({ type: "unknown.delta", kind: "unknown", aria: this.aria, turn: t.id, node: idx, nodeType, text });
      }
      return;
    }
    if (n.toldSettled) return;
    n.toldSettled = true;
    n.toldStarted = true;
    this.emit({ type: "unknown.settled", kind: "unknown", aria: this.aria, turn: t.id, node: idx, nodeType, ...(text !== undefined ? { text } : {}) });
  }

  private emitText(t: TurnState, idx: number, n: NodeState, kind: "prose" | "thinking" | "steering"): void {
    const text = n.raw.markdown ?? "";
    const who = kind === "steering" ? { ...(n.raw.sender ? { sender: n.raw.sender } : {}), ...(n.raw.sender_name ? { senderName: n.raw.sender_name } : {}) } : {};
    const delta = (): void => {
      const s = diffText(n.toldText, text);
      if (!s) return;
      n.toldText = text;
      n.toldStarted = true;
      this.emit({ type: `${kind}.delta`, kind, aria: this.aria, turn: t.id, node: idx, text, at: s.at, del: s.del, ins: s.ins, ...who } as never);
    };
    if (!n.settled) {
      delta();
      return;
    }
    if (n.toldSettled) return;
    if (n.toldStarted) delta();
    n.toldSettled = true;
    n.toldText = text;
    n.toldStarted = true;
    this.emit({ type: `${kind}.settled`, kind, aria: this.aria, turn: t.id, node: idx, text, ...who } as never);
  }

  private emitTool(t: TurnState, idx: number, n: NodeState): void {
    const tool = toolOf(idx, n.raw);
    const key = JSON.stringify(tool);
    if (!n.toldStarted) {
      n.toldStarted = true;
      n.toldTool = key;
      this.emit({ type: "tool.start", kind: "tool", aria: this.aria, turn: t.id, tool });
    } else if (key !== n.toldTool && tool.status === "running") {
      n.toldTool = key;
      this.emit({ type: "tool.update", kind: "tool", aria: this.aria, turn: t.id, tool });
    }
    const finished = tool.status !== "running" || n.settled;
    if (finished && !n.toldEnd) {
      n.toldEnd = true;
      n.toldTool = key;
      this.emit({ type: "tool.end", kind: "tool", aria: this.aria, turn: t.id, tool, result: tool.output, failed: tool.status === "error" });
    }
    if (n.settled && !n.toldSettled) n.toldSettled = true;
  }

  private emitEnd(t: TurnState): void {
    if (t.sealed === false && t.done === undefined) return;
    if (t.nodes.some((n) => n && !n.settled)) return;
    if (t.done && !t.doneTold) {
      t.doneTold = true;
      t.endTold = true;
      const { reason, idle } = t.done;
      const idleField = idle !== undefined ? { idle } : {};
      if (reason.startsWith("error")) {
        this.emit({ type: "turn.error", kind: "turn", aria: this.aria, turn: t.id, reason, ...idleField });
      } else {
        this.emit({ type: "turn.end", kind: "turn", aria: this.aria, turn: t.id, reason, ...idleField, replayed: false });
      }
      return;
    }
    if (!t.endTold && t.sealed && t.replaySeal && !t.tailPending && !t.done) {
      t.endTold = true;
      this.emit({ type: "turn.end", kind: "turn", aria: this.aria, turn: t.id, replayed: true });
    }
  }

  private buildTurn(t: TurnState): TurnView {
    const nodes: NodeView[] = [];
    for (let i = 0; i < t.nodes.length; i++) {
      const n = t.nodes[i];
      if (!n || !n.raw.type) continue;
      if (n.raw.type === "tool") {
        nodes.push({ kind: "tool", node: i, settled: n.settled, tool: toolOf(i, n.raw) });
      } else if (!textTypes.has(n.raw.type)) {
        nodes.push({ kind: "unknown", node: i, type: n.raw.type, settled: n.settled, ...(n.raw.markdown !== undefined ? { text: n.raw.markdown } : {}) });
      } else {
        const kind = n.raw.type as "prose" | "thinking" | "steering";
        nodes.push({
          kind,
          node: i,
          text: n.raw.markdown ?? "",
          settled: n.settled,
          ...(kind === "steering" && n.raw.sender ? { sender: n.raw.sender } : {}),
          ...(kind === "steering" && n.raw.sender_name ? { senderName: n.raw.sender_name } : {}),
        });
      }
    }
    const end: TurnEndView | undefined = t.done
      ? { reason: t.done.reason, ...(t.done.idle !== undefined ? { idle: t.done.idle } : {}), failed: t.done.reason.startsWith("error") }
      : t.endTold
        ? { failed: false }
        : undefined;
    return { turn: t.id, ...(t.input ? { input: t.input } : {}), nodes, sealed: t.sealed, ...(end ? { end } : {}) };
  }
}

function blank(): NodeState {
  return { raw: {}, settled: false, toldStarted: false, toldText: "", toldTool: undefined, toldSettled: false, toldEnd: false };
}

function absorb(cur: NodeState | undefined, wire: Node, settled: boolean): NodeState {
  const n = cur ?? blank();
  n.raw = { ...wire } as Raw;
  if (settled) n.settled = true;
  return n;
}

function inputOf(part: TurnPart): InputView {
  const text = part.inquiry ?? "";
  const segments = segmentsOf(part.inquiry_segments, text);
  const first = segments.find((s) => s.sender !== undefined);
  return {
    text,
    segments,
    ...(first?.sender !== undefined ? { sender: first.sender } : {}),
    ...(first?.senderName !== undefined ? { senderName: first.senderName } : {}),
    ...(part.at !== undefined ? { at: part.at } : {}),
  };
}

function toolOf(node: number, raw: Raw): Tool {
  const status: ToolStatus = raw.status === "ok" ? "ok" : raw.status === "error" ? "error" : "running";
  return {
    node,
    status,
    output: raw.output ?? "",
    outputBase: raw.output_base ?? 0,
    ...(raw.tool_call_id !== undefined ? { id: raw.tool_call_id } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
    ...(raw.args !== undefined ? { args: raw.args as { readonly [name: string]: Json } } : {}),
    ...(raw.input !== undefined ? { input: raw.input } : {}),
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.opened_at !== undefined ? { openedAt: raw.opened_at } : {}),
    ...(raw.started_at !== undefined ? { startedAt: raw.started_at } : {}),
    ...(raw.finished_at !== undefined ? { finishedAt: raw.finished_at } : {}),
  };
}
