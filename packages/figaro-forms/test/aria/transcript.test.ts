import { describe, expect, it } from "vitest";
import type { AriaEvent } from "../../src/aria/events.js";
import { Transcript } from "../../src/aria/transcript.js";
import { doneOf, frameOf, loadTape, pushes, reads } from "./tape.js";

function run(name: string, from?: string): { events: AriaEvent[]; t: Transcript } {
  const events: AriaEvent[] = [];
  const t = new Transcript({ aria: "a1", ...(from ? { from } : {}), emit: (e) => events.push(e) });
  const tape = loadTape(name);
  const first = reads(tape)[0];
  if (first) {
    t.fold(first, "read");
    t.flush();
  }
  for (const l of pushes(tape)) {
    if (l.method === "figaro.aria") t.fold(frameOf(l), "push");
    if (l.method === "turn.done") {
      const d = doneOf(l);
      t.done(d.reason, d.idle);
    }
    t.flush();
  }
  return { events, t };
}

const types = (es: readonly AriaEvent[]): string[] =>
  es.map((e) => `${e.type}${"turn" in e ? `@${e.turn}` : ""}${"node" in e ? `.${e.node}` : "tool" in e ? `.${e.tool.node}` : ""}`);

describe("transcript on a recorded plain turn and a tool turn", () => {
  const { events, t } = run("plain-tool");

  it("catches up the sealed seed turn, then follows both live turns in order", () => {
    expect(types(events).filter((x) => !x.startsWith("metrics"))).toEqual([
      "input@1",
      "prose.settled@1.0",
      "turn.end@1",
      "input@2",
      "prose.delta@2.0",
      "prose.delta@2.0",
      "prose.delta@2.0",
      "prose.settled@2.0",
      "turn.end@2",
      "input@3",
      "prose.delta@3.0",
      "tool.start@3.1",
      "tool.update@3.1",
      "tool.update@3.1",
      "tool.update@3.1",
      "tool.end@3.1",
      "prose.delta@3.2",
      "prose.delta@3.2",
      "prose.settled@3.0",
      "prose.settled@3.2",
      "turn.end@3",
    ]);
  });

  it("builds prose from byte-offset patches", () => {
    const settled = events.filter((e) => e.type === "prose.settled").map((e) => (e as { text: string }).text);
    expect(settled).toEqual(["Buongiorno, signore. Largo al factotum. ", "Buongiorno, signore. Largo al factotum. ", "Let me look. ", "The tool said tool-ran-ok. Done."]);
  });

  it("each prose delta names the splice and carries the whole text so far", () => {
    const d = events.filter((e) => e.type === "prose.delta" && e.turn === 2) as { text: string; at: number; del: number; ins: string }[];
    expect(d.map((x) => x.text)).toEqual(["Buongiorno, ", "Buongiorno, signore. Largo ", "Buongiorno, signore. Largo al factotum. "]);
    expect(d.map((x) => [x.at, x.del, x.ins])).toEqual([[0, 0, "Buongiorno, "], [12, 0, "signore. Largo "], [27, 0, "al factotum. "]]);
  });

  it("tool events carry name, args, output and the final status", () => {
    const start = events.find((e) => e.type === "tool.start");
    const end = events.find((e) => e.type === "tool.end");
    expect(start).toMatchObject({ tool: { name: "bash", status: "running", id: "call_1" } });
    expect(end).toMatchObject({ result: "tool-ran-ok", failed: false, tool: { name: "bash", status: "ok", args: { command: "echo tool-ran-ok" }, output: "tool-ran-ok" } });
  });

  it("turn.end carries the daemon's reason and idle flag when seen live, and says so when replayed", () => {
    const ends = events.filter((e) => e.type === "turn.end");
    expect(ends.map((e) => (e as { replayed: boolean }).replayed)).toEqual([true, false, false]);
    expect(ends[2]).toMatchObject({ reason: "stop", idle: true });
  });

  it("ends with a cursor at the start of the next turn", () => {
    expect(t.resume()).toBe("4.0");
  });
});

describe("transcript on a steered turn", () => {
  const { events } = run("steer");

  it("emits the steering node as its own kind, after the tool it interrupted", () => {
    const steer = events.filter((e) => e.kind === "steering");
    expect(steer.map((e) => e.type)).toEqual(["steering.delta", "steering.settled"]);
    expect(steer[1]).toMatchObject({ turn: 2, node: 2, text: "also consider this" });
  });

  it("restarts versions on the second round without duplicating the first round's nodes", () => {
    const proseTurn2 = events.filter((e) => e.kind === "prose" && e.turn === 2).map((e) => e.type);
    expect(proseTurn2.filter((x) => x === "prose.settled")).toHaveLength(2);
    expect(events.filter((e) => e.type === "tool.end")).toHaveLength(1);
  });
});

describe("transcript on a failed turn", () => {
  const { events } = run("error");

  it("emits turn.error with the daemon's reason", () => {
    const failed = events.find((e) => e.type === "turn.error");
    expect(failed).toMatchObject({ turn: 2, idle: true });
    expect((failed as { reason: string }).reason).toContain("the fake model refused on purpose");
  });
});

describe("transcript attached mid-turn", () => {
  const tape = loadTape("midturn");
  const read = reads(tape)[0] as NonNullable<ReturnType<typeof reads>[number]>;
  const live = pushes(tape).filter((l) => l.method === "figaro.aria");

  it("takes the snapshot, then only the frames past its version", () => {
    const events: AriaEvent[] = [];
    const t = new Transcript({ aria: "a1", emit: (e) => events.push(e) });
    t.fold(read, "read");
    t.flush();
    for (const l of live) {
      const r = t.fold(frameOf(l), "push");
      expect(r.resync).toBe(false);
      t.flush();
    }
    const deltas = events.filter((e) => e.type === "prose.delta" && e.turn === 2) as { text: string }[];
    expect(deltas[0]?.text).toBe("one two three four five ");
    expect(deltas.at(-1)?.text).toBe("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen. ");
    expect(events.filter((e) => e.type === "prose.settled" && e.turn === 2)).toHaveLength(1);
  });

  it("hears nothing twice when every frame is delivered twice", () => {
    const once: AriaEvent[] = [];
    const twice: AriaEvent[] = [];
    const a = new Transcript({ aria: "a1", emit: (e) => once.push(e) });
    const b = new Transcript({ aria: "a1", emit: (e) => twice.push(e) });
    for (const t of [a, b]) {
      t.fold(read, "read");
      t.flush();
    }
    for (const l of live) {
      a.fold(frameOf(l), "push");
      a.flush();
      b.fold(frameOf(l), "push");
      b.flush();
      b.fold(frameOf(l), "push");
      b.flush();
    }
    expect(twice.map((e) => e.type)).toEqual(once.map((e) => e.type));
  });

  it("asks for a resync when a frame is missing", () => {
    const t = new Transcript({ aria: "a1", emit: () => {} });
    t.fold(read, "read");
    t.flush();
    const skipped = live.filter((l) => frameOf(l).parts[0]?.live?.v !== 6);
    const results = skipped.map((l) => t.fold(frameOf(l), "push").resync);
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
  });

  it("resumes from a cursor without repeating what the cursor passed", () => {
    const first: AriaEvent[] = [];
    const a = new Transcript({ aria: "a1", emit: (e) => first.push(e) });
    a.fold(read, "read");
    a.flush();
    const cursor = a.resume();
    expect(cursor).toBe("2.1");
    const resumed: AriaEvent[] = [];
    const b = new Transcript({ aria: "a1", from: cursor, emit: (e) => resumed.push(e) });
    b.fold(read, "read");
    b.flush();
    expect(resumed.filter((e) => e.kind !== "metrics").map((e) => e.type)).toEqual(["prose.delta"]);
    expect(resumed[0]).toMatchObject({ turn: 2, node: 0, text: "one two three four five " });
  });

  it("resumes at the next turn when the last turn is complete", () => {
    const full = run("plain-tool");
    const resumed: AriaEvent[] = [];
    const tape = loadTape("plain-tool");
    const b = new Transcript({ aria: "a1", from: full.t.resume(), emit: (e) => resumed.push(e) });
    const last = reads(tape).at(-1) as NonNullable<ReturnType<typeof reads>[number]>;
    b.fold({ ...last, parts: last.parts.filter((p) => p.turn >= 4) }, "read");
    b.flush();
    expect(resumed.filter((e) => e.kind !== "metrics")).toEqual([]);
  });
});

describe("transcript on hand-made frames", () => {
  const part = (over: Record<string, unknown>): never => ({ turn: 1, from: 0, sealed: false, ...over }) as never;
  const page = (...parts: unknown[]): never => ({ parts, more: {} }) as never;

  it("names who sent the opening input and a steering node", () => {
    const events: AriaEvent[] = [];
    const t = new Transcript({ aria: "a1", emit: (e) => events.push(e) });
    t.fold(
      page(
        part({
          inquiry: "from the King\n\nand a postscript",
          inquiry_segments: [
            { sender: "ee927149", name: "arsonist-grill", text: "from the King" },
            { sender: "cli", text: "and a postscript" },
          ],
          live: { from: 0, v: 0, nodes: [{ id: 0, set: { type: "steering", role: "input", markdown: "mind the tide", sender: "b0587ace", sender_name: "forms-lane" } }] },
        }),
      ),
      "push",
    );
    t.flush();
    expect(events[0]).toMatchObject({ type: "input", sender: "ee927149", senderName: "arsonist-grill" });
    expect((events[0] as unknown as { segments: unknown[] }).segments).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "steering.delta", sender: "b0587ace", senderName: "forms-lane", text: "mind the tide" });
  });

  it("shows a node type it does not know as an unknown node, with its text when it has one", () => {
    const events: AriaEvent[] = [];
    const t = new Transcript({ aria: "a1", emit: (e) => events.push(e) });
    t.fold(
      page(
        part({
          live: {
            from: 0,
            v: 0,
            nodes: [
              { id: 0, set: { type: "citation", markdown: "see [1]" } },
              { id: 1, set: { type: "image" } },
            ],
          },
        }),
      ),
      "push",
    );
    t.flush();
    t.fold(page(part({ live: { from: 0, v: 0 } })), "push");
    t.flush();
    expect(events.map((e) => e.type)).toEqual(["unknown.delta", "unknown.settled", "unknown.settled"]);
    expect(events[0]).toMatchObject({ kind: "unknown", node: 0, nodeType: "citation", text: "see [1]" });
    expect(events[2]).toMatchObject({ node: 1, nodeType: "image" });
    expect("text" in (events[2] as object)).toBe(false);
    expect(t.view()[0]?.nodes).toEqual([
      { kind: "unknown", node: 0, type: "citation", settled: true, text: "see [1]" },
      { kind: "unknown", node: 1, type: "image", settled: true },
    ]);
    expect(t.resume()).toBe("1.3");
  });

  it("splices multibyte text by byte offsets", () => {
    const events: AriaEvent[] = [];
    const t = new Transcript({ aria: "a1", emit: (e) => events.push(e) });
    t.fold(page(part({ live: { from: 0, v: 0, nodes: [{ id: 0, set: { type: "prose", markdown: "señor 日" } }] } })), "push");
    t.fold(page(part({ live: { from: 0, v: 1, nodes: [{ id: 0, patch: { markdown: { at: 10, del: 0, ins: "本 😀" } } }] } })), "push");
    t.flush();
    expect((events.at(-1) as { text: string }).text).toBe("señor 日本 😀");
  });

  it("settles a streamed node when the close marker matches the highest version, and not before", () => {
    const events: AriaEvent[] = [];
    const t = new Transcript({ aria: "a1", emit: (e) => events.push(e) });
    t.fold(page(part({ live: { from: 0, v: 0, nodes: [{ id: 0, set: { type: "thinking", markdown: "hm" } }] } })), "push");
    t.flush();
    expect(events.map((e) => e.type)).toEqual(["thinking.delta"]);
    t.fold(page(part({ live: { from: 0, v: 0 } })), "push");
    t.flush();
    expect(events.map((e) => e.type)).toEqual(["thinking.delta", "thinking.settled"]);
  });

  it("asks for a resync on a close marker for a version it never reached", () => {
    const t = new Transcript({ aria: "a1", emit: () => {} });
    t.fold(page(part({ live: { from: 0, v: 0, nodes: [{ id: 0, set: { type: "prose", markdown: "a" } }] } })), "push");
    expect(t.fold(page(part({ live: { from: 0, v: 3 } })), "push").resync).toBe(true);
  });

  it("holds turn.end back until the remaining pages of a clipped turn have arrived", () => {
    const events: AriaEvent[] = [];
    const t = new Transcript({ aria: "a1", emit: (e) => events.push(e) });
    const node = (text: string) => ({ type: "prose", markdown: text });
    t.fold(page(part({ sealed: true, inquiry: "q", nodes: [node("a"), node("b")], clipped_tail: true })), "read");
    t.flush();
    expect(events.map((e) => e.type)).toEqual(["input", "prose.settled", "prose.settled"]);
    t.fold(page(part({ sealed: true, from: 2, nodes: [node("c")] })), "read");
    t.flush();
    expect(events.map((e) => e.type)).toEqual(["input", "prose.settled", "prose.settled", "prose.settled", "turn.end"]);
  });

  it("builds a view that reflects the open node and shares unchanged turns", () => {
    const t = new Transcript({ aria: "a1", emit: () => {} });
    t.fold(page(part({ turn: 1, sealed: true, inquiry: "q1", nodes: [{ type: "prose", markdown: "done" }] })), "read");
    t.fold(page(part({ turn: 2, inquiry: "q2", live: { from: 0, v: 0, nodes: [{ id: 0, set: { type: "prose", markdown: "str" } }] } })), "push");
    t.flush();
    const v1 = t.view();
    expect(v1.map((x) => [x.turn, x.sealed, x.nodes.map((n) => (n.kind === "prose" ? [n.text, n.settled] : []))])).toEqual([
      [1, true, [["done", true]]],
      [2, false, [["str", false]]],
    ]);
    t.fold(page(part({ turn: 2, live: { from: 0, v: 1, nodes: [{ id: 0, patch: { markdown: { at: 3, del: 0, ins: "eam" } } }] } })), "push");
    const v2 = t.view();
    expect(v2[0]).toBe(v1[0]);
    expect(v2[1]).not.toBe(v1[1]);
  });
});

describe("what the push stream built, a fresh read of the same turns builds too", () => {
  for (const name of ["plain-tool", "steer", "error", "midturn"]) {
    it(`agrees on ${name}`, () => {
      const live = run(name);
      const tape = loadTape(name);
      const last = reads(tape).at(-1) as NonNullable<ReturnType<typeof reads>[number]>;
      const fresh = new Transcript({ aria: "a1", emit: () => {} });
      fresh.fold(last, "read");
      const strip = (turns: readonly import("../../src/aria/events.js").TurnView[]) =>
        turns.map((t) => ({
          turn: t.turn,
          input: t.input?.text,
          sealed: t.sealed,
          nodes: t.nodes.map((n) => (n.kind === "tool" ? { ...n, tool: { ...n.tool, openedAt: undefined } } : n)),
        }));
      expect(strip(live.t.view())).toEqual(strip(fresh.view()));
    });
  }
});
