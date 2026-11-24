import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AriaClient, ariaRefusal, type AppliedFrame, type AriaStream, type Message, type TurnEnd } from "../../src/aria/index.js";
import { startDaemon, type Daemon } from "./daemon.js";

const bin = process.env.FIGARO_BIN;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const turnOf = (s: AriaStream, turn: number): Message[] => s.snapshot().view.closed.filter((m) => m.turn === turn);
const nodesOf = (s: AriaStream, turn: number): Message["nodes"][number][] => turnOf(s, turn).flatMap((m) => [...m.nodes]);

describe.skipIf(!bin)("conformance against a disposable figaro daemon (FIGARO_BIN)", () => {
  let daemon: Daemon;
  const clients: AriaClient[] = [];

  const connect = (user = "gluck"): AriaClient => {
    const c = new AriaClient({ dial: daemon.dial(user), retryMinMs: 50, retryMaxMs: 200 });
    clients.push(c);
    return c;
  };

  interface Attended {
    readonly s: AriaStream;
    readonly frames: AppliedFrame[];
    readonly ends: TurnEnd[];
  }

  const attend = async (c: AriaClient, id: string, o?: Parameters<AriaClient["attach"]>[1]): Promise<Attended> => {
    const s = c.attach(id, o);
    const frames: AppliedFrame[] = [];
    const ends: TurnEnd[] = [];
    s.onFrame((a) => frames.push(a));
    s.onTurnEnd((e) => ends.push(e));
    await s.ready();
    return { s, frames, ends };
  };

  const ended = (a: Attended, turn: number): boolean => a.ends.some((e) => e.turn === turn);

  beforeAll(async () => {
    daemon = await startDaemon(bin as string);
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await daemon?.stop();
  }, 60_000);

  it("catches up a finished turn the daemon holds, then follows a prompt sent through the daemon", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const a = await attend(c, id);
    expect(a.s.snapshot().view.closed).toMatchObject([{ turn: 1, from: 0, inquiry: "seed", role: "output", nodes: [{ type: "prose", markdown: "Buongiorno, signore. Largo al factotum. " }] }]);
    expect(a.s.snapshot().view.open).toBeUndefined();
    expect(a.ends).toEqual([{ turn: 1, replayed: true }]);

    const sent = await a.s.qua("say hi");
    expect(sent.ok).toBe(true);
    await until("the second turn to end", () => ended(a, 2));
    expect(a.ends.at(-1)).toEqual({ turn: 2, replayed: false, done: { reason: "stop", idle: true } });
    expect(turnOf(a.s, 2)).toMatchObject([{ turn: 2, from: 0, inquiry: "say hi", nodes: [{ type: "prose", markdown: "Buongiorno, signore. Largo al factotum. " }] }]);
    const grown = a.frames.flatMap((f) => f.nodes.filter((n) => n.turn === 2 && n.node.type === "prose").map((n) => n.node.markdown ?? ""));
    expect(grown.length).toBeGreaterThan(1);
    for (let i = 1; i < grown.length; i++) expect((grown[i] as string).startsWith(grown[i - 1] as string)).toBe(true);
    expect(a.frames.some((f) => f.source === "push" && f.open?.turn === 2)).toBe(true);
    expect(a.s.cursor).toBe(2);
  });

  it("carries a tool call as one node that runs and then reports its arguments and output", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const a = await attend(c, id);
    await a.s.qua("[tool] run it");
    await until("the tool turn to end", () => ended(a, 2));
    const seen = a.frames.flatMap((f) => f.nodes.filter((n) => n.node.type === "tool").map((n) => n.node.status));
    expect(seen[0]).toBe("running");
    expect(seen.at(-1)).toBe("ok");
    const nodes = nodesOf(a.s, 2);
    expect(nodes.map((n) => n.type)).toEqual(["prose", "tool", "prose"]);
    expect(nodes[1]).toMatchObject({ name: "bash", status: "ok", output: "tool-ran-ok", args: { command: "echo tool-ran-ok" } });
    expect(nodes.filter((n) => n.type === "prose").map((n) => n.markdown)).toEqual(["Let me look. ", "The tool said tool-ran-ok. Done."]);
  });

  it("shows a message sent mid-turn as a steering node", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const a = await attend(c, id);
    await a.s.qua("[slowtool] go");
    await until("the tool to start", () => a.frames.some((f) => f.nodes.some((n) => n.node.type === "tool")));
    await a.s.qua("also consider this");
    await until("the turn to end", () => ended(a, 2));
    const steer = nodesOf(a.s, 2).filter((n) => n.type === "steering");
    expect(steer).toMatchObject([{ type: "steering", role: "input", markdown: "also consider this" }]);
  }, 30_000);

  it("ends a refused turn with the provider's words in the reason", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const a = await attend(c, id);
    await a.s.qua("[boom] now");
    await until("the error", () => ended(a, 2));
    const end = a.ends.find((e) => e.turn === 2);
    expect(end?.replayed).toBe(false);
    expect(end?.done?.reason).toContain("the fake model refused on purpose");
    expect(end?.done?.reason.startsWith("error")).toBe(true);
    expect(end?.done?.idle).toBe(true);
  });

  it("resumes across a dropped connection mid-reply with no gap and no duplicate", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const a = await attend(c, id);
    await a.s.qua("[slow] stream for a while");
    await until("some prose", () => a.frames.some((f) => f.source === "push" && f.nodes.some((n) => n.turn === 2 && n.node.type === "prose")));
    c.connection.reconnectNow();
    await until("the turn to end", () => ended(a, 2), 30_000);
    expect(turnOf(a.s, 2)).toHaveLength(1);
    expect(turnOf(a.s, 2)).toMatchObject([{ inquiry: "[slow] stream for a while", nodes: [{ markdown: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen. " }] }]);
    expect(a.ends.filter((e) => e.turn === 2)).toHaveLength(1);
    expect(a.s.snapshot().view.open).toBeUndefined();
  }, 40_000);

  it("resumes in a second client from the cursor of the first, and holds the same new turn", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const a = connect();
    const first = await attend(a, id);
    await first.s.qua("say hi");
    await until("turn 2", () => ended(first, 2));
    const cursor = first.s.cursor;
    expect(cursor).toBe(2);

    const b = connect();
    const second = await attend(b, id, { cursor });
    expect(second.s.snapshot().view.closed.map((m) => m.turn)).toEqual([2]);
    await first.s.qua("[tool] again");
    await until("turn 3 on both", () => ended(first, 3) && ended(second, 3));
    expect(turnOf(second.s, 3)).toEqual(turnOf(first.s, 3));
    expect(second.s.snapshot().view.closed.some((m) => m.turn < 2)).toBe(false);
  }, 40_000);

  it("interrupts a running turn and reports it as interrupted", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const a = await attend(c, id);
    await a.s.qua("[slow] stream for a while");
    await until("some prose", () => a.frames.some((f) => f.source === "push" && f.nodes.some((n) => n.turn === 2 && n.node.type === "prose")));
    const r = await a.s.interrupt();
    expect(r.ok).toBe(true);
    await until("the turn to end", () => ended(a, 2));
    expect(a.ends.find((e) => e.turn === 2)).toMatchObject({ replayed: false, done: { reason: "interrupted" } });
    expect(a.s.snapshot().view.open).toBeUndefined();
  }, 30_000);

  it("lists figaros, forks one, and attends the fork", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const list = await c.list();
    expect(list.rows.map((r) => r.id)).toContain(id);
    const forked = await c.fork(id);
    expect(forked.alternative).not.toBe(id);
    const a = await attend(c, forked.alternative);
    expect(a.s.snapshot().view.closed.some((m) => m.turn === 1 && m.inquiry === "seed")).toBe(true);
  });

  it("lets a read-only principal attend, and refuses it a qua, an interrupt and a fork in the daemon's words", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const v = connect("viewer");
    const a = await attend(v, id);
    expect(a.s.snapshot().view.closed).toMatchObject([{ turn: 1, inquiry: "seed" }]);
    for (const attempt of [() => v.qua(id, "nope"), () => v.interrupt(id), () => v.fork(id)]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(ariaRefusal(err)).toMatchObject({ kind: "denied", code: -32020 });
    }
  });

  it("shows an aria that does not exist as gone", async () => {
    const c = connect();
    const s = c.attach("00000000000000000000000000000000");
    await expect(s.ready()).rejects.toMatchObject({ refusal: { kind: "not_found" } });
    expect(s.state).toBe("gone");
  });
});
