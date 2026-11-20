import { afterEach, describe, expect, it } from "vitest";
import { AriaClient, AriaUnavailable, ariaRefusal, type AppliedFrame, type DoneEntry, type Message, type AriaStream, type TurnEnd } from "../../src/aria/index.js";
import { RpcError } from "../../src/rpc.js";
import { FakeAria, settle, tick } from "./fake-aria.js";

const open: AriaClient[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

function setup(fake = new FakeAria()): { fake: FakeAria; client: AriaClient } {
  const client = new AriaClient({ dial: fake.dial, retryMinMs: 5, retryMaxMs: 10, releaseGraceMs: 5 });
  open.push(client);
  return { fake, client };
}

const prose = (id: number, markdown: string): { id: number; set: Record<string, string> } => ({ id, set: { type: "prose", role: "output", markdown } });
const more = (id: number, at: number, ins: string): { id: number; patch: { markdown: { at: number; del: number; ins: string } } } => ({ id, patch: { markdown: { at, del: 0, ins } } });

function frames(stream: AriaStream): AppliedFrame[] {
  const seen: AppliedFrame[] = [];
  stream.onFrame((a) => seen.push(a));
  return seen;
}

const closed = (s: AriaStream): readonly Message[] => s.snapshot().view.closed;
const texts = (ms: readonly Message[]): string[] => ms.flatMap((m) => m.nodes.map((n) => n.markdown ?? ""));

describe("attach, catch up, follow", () => {
  it("follows the transcript channel before it reads, and reads before it reports live", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.finishedTurn("a1", 1, "hello", [{ type: "prose", markdown: "ciao" }]);
    const s = client.attach("a1");
    const seen = frames(s);
    await s.ready();
    const methods = fake.calls.map((c) => c.method);
    expect(methods.slice(0, 3)).toEqual(["angelus.hello", "figaro.follow", "figaro.read"]);
    expect(fake.calls[1]?.params).toMatchObject({ figaro_id: "a1", channels: ["transcript"] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: "read", closed: [{ turn: 1, from: 0, inquiry: "hello", role: "output", nodes: [{ type: "prose", markdown: "ciao" }] }] });
    expect(s.state).toBe("live");
  });

  it("streams a live turn as the daemon sends it: an open message, then closed at the seal, then turn.done", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    const seen = frames(s);
    const dones: DoneEntry[] = [];
    s.onDone((d) => dones.push(d));
    await s.ready();
    seen.length = 0;
    fake.openTurn("a1", 1, "say something");
    fake.update("a1", 1, [prose(0, "Buon")]);
    fake.update("a1", 1, [more(0, 4, "giorno")]);
    fake.closeRound("a1", 1);
    await settle();
    expect(s.snapshot().view.closed).toEqual([]);
    expect(s.snapshot().view.open).toMatchObject({ turn: 1, inquiry: "say something", role: "output", nodes: [{ type: "prose", markdown: "Buongiorno" }] });
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    expect(seen.map((a) => a.source)).toEqual(["push", "push", "push", "push", "push"]);
    expect(seen[1]?.nodes).toMatchObject([{ turn: 1, id: 0, node: { markdown: "Buon" }, delta: { id: 0 } }]);
    expect(seen[2]?.nodes).toMatchObject([{ turn: 1, id: 0, node: { markdown: "Buongiorno" }, delta: { patch: { markdown: { at: 4, del: 0, ins: "giorno" } } } }]);
    expect(seen[4]?.closed).toMatchObject([{ turn: 1, from: 0, nodes: [{ markdown: "Buongiorno" }] }]);
    expect(s.snapshot().view).toMatchObject({ closed: [{ turn: 1 }], open: undefined });
    expect(dones).toEqual([{ reason: "stop", idle: true }]);
    expect(s.snapshot().done).toEqual({ reason: "stop", idle: true });
    expect(s.cursor).toBe(1);
  });

  it("lets a consumer iterate the frames it is told", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const iter = s.frames();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "hi")]);
    const first = await iter.next();
    expect(first.value).toMatchObject({ source: "push", frame: { parts: [{ turn: 1, inquiry: "q" }] } });
    const second = await iter.next();
    expect(second.value?.nodes).toMatchObject([{ id: 0, node: { type: "prose", markdown: "hi" } }]);
    await iter.return?.();
  });

  it("pages a long catch-up from the start across several reads", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.pageNodes = 2;
    for (let t = 1; t <= 4; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }, { type: "prose", markdown: `b${t}` }, { type: "prose", markdown: `c${t}` }]);
    const s = client.attach("a1", { from: "start" });
    await s.ready();
    expect(texts(closed(s))).toEqual(["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3", "c3", "a4", "b4", "c4"]);
    expect(closed(s).filter((m) => m.inquiry !== undefined).map((m) => m.turn)).toEqual([1, 2, 3, 4]);
    expect(fake.reads.length).toBeGreaterThan(3);
    expect(s.cursor).toBe(4);
    expect(s.transcript.query({ turn: 1, node: 0 }, { turn: 4, node: 2 }).every((seg) => seg.gap === undefined)).toBe(true);
  });

  it("starts from the tail by default and loads older turns without announcing them", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.pageNodes = 2;
    for (let t = 1; t <= 5; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }]);
    const s = client.attach("a1");
    const seen = frames(s);
    await s.ready();
    expect(fake.reads[0]).toMatchObject({ backward: true });
    expect(closed(s).map((m) => m.turn)).toEqual([4, 5]);
    expect(s.snapshot().olderAvailable).toBe(true);
    const before = seen.length;
    expect(await s.loadOlder()).toBe(true);
    expect(seen.length).toBe(before);
    expect(closed(s).map((m) => m.turn)).toEqual([2, 3, 4, 5]);
    await s.loadOlder();
    await s.loadOlder();
    expect(closed(s).map((m) => m.turn)).toEqual([1, 2, 3, 4, 5]);
    expect(s.snapshot().olderAvailable).toBe(false);
    expect(s.cursor).toBe(5);
  });

  it("closes a hole between what it holds and an anchor with ensure", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.pageNodes = 2;
    for (let t = 1; t <= 6; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }]);
    const s = client.attach("a1");
    await s.ready();
    expect(closed(s).map((m) => m.turn)).toEqual([5, 6]);
    await s.ensure({ turn: 1, node: 0 }, { turn: 6, node: 0 });
    expect(closed(s).map((m) => m.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.snapshot().olderAvailable).toBe(false);
  });

  it("resumes from a cursor and reads from that turn, not from the start", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    for (let t = 1; t <= 3; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }]);
    const s = client.attach("a1", { cursor: 3 });
    await s.ready();
    expect(fake.reads[0]).toMatchObject({ at: { turn: 3, node: 0 } });
    expect(closed(s)).toMatchObject([{ turn: 3, inquiry: "q3", nodes: [{ markdown: "a3" }] }]);
    expect(s.snapshot().olderAvailable).toBe(true);
  });

  it("applies frames that arrive while the catch-up read is in flight, once", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.holdReads = true;
    const s = client.attach("a1");
    await settle();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "one ")]);
    fake.update("a1", 1, [more(0, 4, "two ")]);
    fake.release();
    await settle();
    fake.update("a1", 1, [more(0, 8, "three")]);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    expect(closed(s)).toMatchObject([{ turn: 1, from: 0, inquiry: "q", nodes: [{ markdown: "one two three" }] }]);
    expect(s.snapshot().view.open).toBeUndefined();
  });
});

describe("frame versions across a reconnect", () => {
  it("applies pushes again after a reconnect even if the daemon's versions restart lower", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "a ")]);
    fake.update("a1", 1, [more(0, 2, "b ")]);
    fake.update("a1", 1, [more(0, 4, "c ")]);
    await settle();
    const t = fake.turns.get("a1")?.[0];
    if (t?.open) t.open.ver = 1;
    fake.drop();
    await tick(60);
    await settle();
    fake.update("a1", 1, [more(0, 6, "d")]);
    await settle();
    expect(s.snapshot().view.open).toMatchObject({ nodes: [{ markdown: "a b c d" }] });
  });
});

describe("a push that overlaps the read that catches up", () => {
  it("is not applied twice: a patch repeated on text that already holds it would corrupt it", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "one ")]);
    fake.update("a1", 1, [more(0, 4, "two ")]);
    fake.holdReads = true;
    const s = client.attach("a1");
    await settle();
    fake.update("a1", 1, [more(0, 8, "three ")]);
    fake.update("a1", 1, [more(0, 14, "four")]);
    fake.release();
    await settle();
    expect(s.snapshot().view.open).toMatchObject({ nodes: [{ markdown: "one two three four" }] });
    fake.update("a1", 1, [more(0, 18, " five")]);
    await settle();
    expect(s.snapshot().view.open).toMatchObject({ nodes: [{ markdown: "one two three four five" }] });
  });
});

describe("which turn ended, and why", () => {
  it("names the turn and the daemon's reason for a turn that ends while it follows", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const ends: TurnEnd[] = [];
    s.onTurnEnd((e) => ends.push(e));
    for (const [turn, reason] of [[1, "stop"], [2, "interrupted"], [3, "error: provider down"]] as const) {
      fake.openTurn("a1", turn, `q${turn}`);
      fake.update("a1", turn, [prose(0, "x")]);
      fake.seal("a1", turn);
      fake.done("a1", reason, true);
      await settle();
    }
    expect(ends).toEqual([
      { turn: 1, replayed: false, done: { reason: "stop", idle: true } },
      { turn: 2, replayed: false, done: { reason: "interrupted", idle: true } },
      { turn: 3, replayed: false, done: { reason: "error: provider down", idle: true } },
    ]);
    expect(s.snapshot().ends).toEqual(ends);
  });

  it("names the turn when turn.done arrives before the seal, and does not tell it again at the seal", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const ends: TurnEnd[] = [];
    s.onTurnEnd((e) => ends.push(e));
    fake.openTurn("a1", 1, "q1");
    fake.update("a1", 1, [prose(0, "x")]);
    fake.done("a1", "stop", true);
    await settle();
    fake.seal("a1", 1);
    await settle();
    fake.openTurn("a1", 2, "q2");
    fake.update("a1", 2, [prose(0, "y")]);
    fake.seal("a1", 2);
    fake.done("a1", "stop", true);
    await settle();
    expect(ends).toEqual([
      { turn: 1, replayed: false, done: { reason: "stop", idle: true } },
      { turn: 2, replayed: false, done: { reason: "stop", idle: true } },
    ]);
  });

  it("names the open turn when it ends without a seal", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const ends: TurnEnd[] = [];
    s.onTurnEnd((e) => ends.push(e));
    fake.openTurn("a1", 1, "q1");
    fake.update("a1", 1, [prose(0, "x")]);
    fake.seal("a1", 1);
    fake.done("a1");
    fake.openTurn("a1", 2, "q2");
    fake.update("a1", 2, [prose(0, "y")]);
    fake.done("a1", "interrupted", true);
    await settle();
    expect(ends.map((e) => [e.turn, e.done?.reason])).toEqual([[1, "stop"], [2, "interrupted"]]);
  });

  it("names the turn but not the reason for turns it only reads: the daemon does not keep one (figaro#200)", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.finishedTurn("a1", 1, "q1", [{ type: "prose", markdown: "a" }]);
    fake.finishedTurn("a1", 2, "q2", [{ type: "prose", markdown: "b" }]);
    const s = client.attach("a1");
    const ends: TurnEnd[] = [];
    s.onTurnEnd((e) => ends.push(e));
    await s.ready();
    expect(ends).toEqual([{ turn: 1, replayed: true }, { turn: 2, replayed: true }]);
    expect(ends.every((e) => e.done === undefined)).toBe(true);
  });

  it("tells a turn that finished while the socket was down as replayed, with its turn", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const ends: TurnEnd[] = [];
    s.onTurnEnd((e) => ends.push(e));
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "partial")]);
    await settle();
    fake.drop();
    fake.seal("a1", 1);
    await tick(60);
    await settle();
    expect(ends).toEqual([{ turn: 1, replayed: true }]);
  });

  it("does not tell a turn twice when a re-read meets it again", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const ends: TurnEnd[] = [];
    s.onTurnEnd((e) => ends.push(e));
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "x")]);
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    fake.drop();
    await tick(60);
    await settle();
    expect(ends).toHaveLength(1);
  });
});

describe("reconnect and gaps", () => {
  it("resumes after a dropped socket without a gap or a duplicate, though frames were missed", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "alpha ")]);
    await settle();
    fake.drop("network");
    fake.update("a1", 1, [more(0, 6, "beta ")], { drop: true });
    fake.update("a1", 1, [more(0, 11, "gamma ")], { drop: true });
    await tick(60);
    await settle();
    expect(fake.dials).toBe(2);
    expect(s.snapshot().view.open).toMatchObject({ nodes: [{ markdown: "alpha beta gamma " }] });
    fake.update("a1", 1, [more(0, 17, "delta")]);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    expect(closed(s)).toMatchObject([{ turn: 1, from: 0, inquiry: "q", nodes: [{ markdown: "alpha beta gamma delta" }] }]);
    expect(closed(s)).toHaveLength(1);
  });

  it("reads a turn that finished while the socket was down and closes it", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "partial")]);
    await settle();
    fake.drop();
    fake.update("a1", 1, [more(0, 7, " and more")], { drop: true });
    fake.seal("a1", 1);
    await tick(60);
    await settle();
    expect(closed(s)).toMatchObject([{ turn: 1, nodes: [{ markdown: "partial and more" }] }]);
    expect(s.snapshot().view.open).toBeUndefined();
    expect(s.cursor).toBe(1);
  });

  it("reads again when a close marker names a version it never reached", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "a ")]);
    fake.update("a1", 1, [more(0, 2, "b ")], { drop: true });
    await settle();
    const reads = fake.reads.length;
    fake.closeRound("a1", 1);
    await settle();
    expect(fake.reads.length).toBe(reads + 1);
    expect(s.snapshot().view.open).toMatchObject({ nodes: [{ markdown: "a b " }] });
    fake.seal("a1", 1);
    await settle();
    expect(texts(closed(s))).toEqual(["a b "]);
  });

  it("reports offline while the connection is down and live again after", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const phases: string[] = [];
    s.onChange(() => {
      const p = s.state;
      if (phases.at(-1) !== p) phases.push(p);
    });
    fake.drop();
    await tick(60);
    await settle();
    expect(phases).toContain("offline");
    expect(phases.at(-1)).toBe("live");
  });
});

describe("refusals", () => {
  it("shows a refused follow as refused, and rejects ready()", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.refuseFollow.set("a1", { code: -32020, message: "user:gluck lacks listen on aria:a1" });
    const s = client.attach("a1");
    await expect(s.ready()).rejects.toBeInstanceOf(AriaUnavailable);
    expect(s.state).toBe("refused");
    expect(s.snapshot().refusal).toMatchObject({ kind: "denied", code: -32020 });
  });

  it("shows an aria the caller cannot see as gone", async () => {
    const { client } = setup();
    const s = client.attach("nope");
    await expect(s.ready()).rejects.toMatchObject({ refusal: { kind: "not_found" } });
    expect(s.state).toBe("gone");
  });

  it("marks a stream closed when the daemon closes the aria", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    fake.closed("a1");
    await settle();
    expect(s.state).toBe("closed");
  });
});

describe("shared streams and detaching", () => {
  it("shares one stream per aria and unfollows when the last holder leaves", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const a = client.retain("a1");
    const b = client.retain("a1");
    expect(a).toBe(b);
    await a.ready();
    client.release("a1");
    client.release("a1");
    await tick(40);
    expect(fake.calls.filter((c) => c.method === "figaro.unfollow")).toHaveLength(1);
    expect(a.state).toBe("detached");
  });

  it("never leaks frames of one aria into another's stream", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.addAria("a2");
    const s1 = client.attach("a1");
    const s2 = client.attach("a2");
    const e1 = frames(s1);
    const e2 = frames(s2);
    await Promise.all([s1.ready(), s2.ready()]);
    fake.openTurn("a1", 1, "for one");
    fake.openTurn("a2", 1, "for two");
    await settle();
    expect(e1.flatMap((a) => (a.open ? [a.open.inquiry] : []))).toEqual(["for one"]);
    expect(e2.flatMap((a) => (a.open ? [a.open.inquiry] : []))).toEqual(["for two"]);
  });
});

describe("calls", () => {
  it("prompts, interrupts, forks and lists with figaro's own method shapes", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.answers.set("figaro.qua", { ok: true, cursor: 4, active: true });
    fake.answers.set("figaro.interrupt", { ok: true, stopped: true });
    fake.answers.set("figaro.fork", { parent: "a1", continuation: "a1c", alternative: "a1x" });
    fake.rows = [{ id: "a1", state: "idle", handle: "one" }];
    fake.listRefused = 3;
    expect(await client.qua("a1", "ciao")).toEqual({ ok: true, cursor: 4, active: true });
    expect(await client.interrupt("a1", { queue: "clear" })).toMatchObject({ stopped: true });
    expect(await client.fork("a1", { atTurn: 2 })).toMatchObject({ alternative: "a1x" });
    const list = await client.list({ limit: 10 });
    expect(list.rows.map((r) => r.id)).toEqual(["a1"]);
    expect(list.refused).toBe(3);
    const sent = Object.fromEntries(fake.calls.map((c) => [c.method, c.params]));
    expect(sent["figaro.qua"]).toEqual({ figaro_id: "a1", text: "ciao" });
    expect(sent["figaro.interrupt"]).toEqual({ figaro_id: "a1", queue: "clear" });
    expect(sent["figaro.fork"]).toEqual({ figaro_id: "a1", at_turn: 2 });
    expect(sent["figaro.list"]).toEqual({ limit: 10 });
  });

  it("passes a daemon error through as an RpcError", async () => {
    const { client } = setup();
    const err = await client.qua("a1", "x").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: -32601 });
  });
});

describe("refusal classes", () => {
  it("names what the daemon refused, by its code or its words", () => {
    expect(ariaRefusal(new RpcError(-32020, "user:x holds no role"))).toMatchObject({ kind: "denied" });
    expect(ariaRefusal(new RpcError(-32000, "figaro.read: aria abc not found"))).toMatchObject({ kind: "not_found" });
    expect(ariaRefusal(new RpcError(-32042, "dormant"))).toMatchObject({ kind: "dormant" });
    expect(ariaRefusal(new RpcError(-32030, "moving"))).toMatchObject({ kind: "moved" });
    expect(ariaRefusal(new RpcError(-32041, "unavailable"))).toMatchObject({ kind: "unavailable" });
    expect(ariaRefusal(new RpcError(-32000, "something broke"))).toBeUndefined();
    expect(ariaRefusal(new Error("not found"))).toBeUndefined();
  });
});
