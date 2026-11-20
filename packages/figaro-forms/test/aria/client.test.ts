import { afterEach, describe, expect, it } from "vitest";
import { AriaClient, AriaUnavailable, ariaRefusal, type AriaEvent, type AriaStream } from "../../src/aria/index.js";
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

function collect(stream: AriaStream): AriaEvent[] {
  const events: AriaEvent[] = [];
  stream.subscribe((e) => events.push(e));
  return events;
}

const shape = (es: readonly AriaEvent[]): string[] => es.filter((e) => e.kind !== "metrics").map((e) => `${e.type}${"turn" in e ? `@${e.turn}` : ""}`);

describe("attach, catch up, follow", () => {
  it("follows the transcript channel before it reads, and reads before it reports live", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.finishedTurn("a1", 1, "hello", [{ type: "prose", markdown: "ciao" }]);
    const s = client.attach("a1");
    const events = collect(s);
    await s.ready();
    const methods = fake.calls.map((c) => c.method);
    expect(methods.slice(0, 3)).toEqual(["angelus.hello", "figaro.follow", "figaro.read"]);
    expect(fake.calls[1]?.params).toMatchObject({ figaro_id: "a1", channels: ["transcript"] });
    expect(shape(events)).toEqual(["input@1", "prose.settled@1", "turn.end@1"]);
    expect(s.state).toBe("live");
  });

  it("streams a live turn: input, deltas, settled at the close marker, end at turn.done", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    const events = collect(s);
    await s.ready();
    fake.openTurn("a1", 1, "say something");
    fake.update("a1", 1, [prose(0, "Buon")]);
    fake.update("a1", 1, [more(0, 4, "giorno")]);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    expect(shape(events)).toEqual(["input@1", "prose.delta@1", "prose.delta@1", "prose.settled@1", "turn.end@1"]);
    expect(events.filter((e) => e.type === "prose.delta").map((e) => (e as { text: string }).text)).toEqual(["Buon", "Buongiorno"]);
    expect(events.at(-1)).toMatchObject({ type: "turn.end", reason: "stop", idle: true, replayed: false });
    expect(s.cursor).toBe("2.0");
  });

  it("lets a consumer subscribe to one kind, or iterate it", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    await s.ready();
    const proseOnly: AriaEvent[] = [];
    s.on("prose", (e) => proseOnly.push(e));
    const iter = s.events({ kind: "turn" });
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "hi")]);
    fake.update("a1", 1, [{ id: 1, set: { type: "thinking", markdown: "hm" } }]);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    fake.done("a1");
    const first = await iter.next();
    expect(first.value).toMatchObject({ type: "turn.end", turn: 1 });
    await iter.return?.();
    expect(proseOnly.map((e) => e.type)).toEqual(["prose.delta", "prose.settled"]);
  });

  it("pages a long catch-up from the start across several reads", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.pageNodes = 2;
    for (let t = 1; t <= 4; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }, { type: "prose", markdown: `b${t}` }, { type: "prose", markdown: `c${t}` }]);
    const s = client.attach("a1", { from: "start" });
    const events = collect(s);
    await s.ready();
    const texts = events.filter((e) => e.type === "prose.settled").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3", "c3", "a4", "b4", "c4"]);
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(4);
    expect(fake.reads.length).toBeGreaterThan(3);
    expect(s.cursor).toBe("5.0");
  });

  it("starts from the tail by default and loads older turns quietly", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.pageNodes = 2;
    for (let t = 1; t <= 5; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }]);
    const s = client.attach("a1");
    const events = collect(s);
    await s.ready();
    expect(fake.reads[0]).toMatchObject({ backward: true });
    expect(events.filter((e) => e.type === "input").map((e) => (e as { turn: number }).turn)).toEqual([4, 5]);
    expect(s.snapshot().olderAvailable).toBe(true);
    const before = events.length;
    expect(await s.loadOlder()).toBe(true);
    expect(events.length).toBe(before);
    expect(s.snapshot().turns.map((t) => t.turn)).toEqual([2, 3, 4, 5]);
    await s.loadOlder();
    await s.loadOlder();
    expect(s.snapshot().turns.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5]);
    expect(s.snapshot().olderAvailable).toBe(false);
    expect(s.cursor).toBe("6.0");
  });

  it("resumes from a cursor and reads from there, not from the start", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    for (let t = 1; t <= 3; t++) fake.finishedTurn("a1", t, `q${t}`, [{ type: "prose", markdown: `a${t}` }]);
    const s = client.attach("a1", { cursor: "3.0" });
    const events = collect(s);
    await s.ready();
    expect(fake.reads[0]).toMatchObject({ at: { turn: 3, node: 0 } });
    expect(shape(events)).toEqual(["input@3", "prose.settled@3", "turn.end@3"]);
  });

  it("applies frames that arrive while the catch-up read is in flight, once", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    fake.holdReads = true;
    const s = client.attach("a1");
    const events = collect(s);
    await settle();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "one ")]);
    fake.holdReads = true;
    fake.update("a1", 1, [more(0, 4, "two ")]);
    fake.release();
    await settle();
    fake.update("a1", 1, [more(0, 8, "three")]);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    const settled = events.filter((e) => e.type === "prose.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ text: "one two three" });
    expect(events.filter((e) => e.type === "input")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1);
  });
});

describe("reconnect and gaps", () => {
  it("resumes after a dropped socket without a gap or a duplicate, though frames were missed", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    const events = collect(s);
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
    fake.update("a1", 1, [more(0, 17, "delta")]);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    fake.done("a1");
    await settle();
    const deltas = events.filter((e) => e.type === "prose.delta") as unknown as { text: string }[];
    expect(deltas.map((d) => d.text)).toEqual(["alpha ", "alpha beta gamma ", "alpha beta gamma delta"]);
    expect(events.filter((e) => e.type === "prose.settled")).toHaveLength(1);
    expect(events.filter((e) => e.type === "input")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1);
  });

  it("reads a turn that finished while the socket was down and ends it as replayed", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    const events = collect(s);
    await s.ready();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "partial")]);
    await settle();
    fake.drop();
    fake.update("a1", 1, [more(0, 7, " and more")], { drop: true });
    fake.seal("a1", 1);
    await tick(60);
    await settle();
    expect(events.filter((e) => e.type === "prose.settled")).toMatchObject([{ text: "partial and more" }]);
    expect(events.filter((e) => e.kind !== "metrics").at(-1)).toMatchObject({ type: "turn.end", replayed: true });
  });

  it("repairs a missing frame in the middle of a stream by reading again", async () => {
    const { fake, client } = setup();
    fake.addAria("a1");
    const s = client.attach("a1");
    const events = collect(s);
    await s.ready();
    fake.openTurn("a1", 1, "q");
    fake.update("a1", 1, [prose(0, "a ")]);
    fake.update("a1", 1, [more(0, 2, "b ")], { drop: true });
    fake.update("a1", 1, [more(0, 4, "c ")]);
    await settle();
    expect(fake.reads.length).toBe(2);
    fake.closeRound("a1", 1);
    fake.seal("a1", 1);
    await settle();
    const settled = events.filter((e) => e.type === "prose.settled") as unknown as { text: string }[];
    expect(settled.map((e) => e.text)).toEqual(["a b c "]);
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
    const e1 = collect(s1);
    const e2 = collect(s2);
    await Promise.all([s1.ready(), s2.ready()]);
    fake.openTurn("a1", 1, "for one");
    fake.openTurn("a2", 1, "for two");
    await settle();
    expect(e1.map((e) => (e as { text?: string }).text)).toEqual(["for one"]);
    expect(e2.map((e) => (e as { text?: string }).text)).toEqual(["for two"]);
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
    expect(await client.prompt("a1", "ciao")).toEqual({ ok: true, cursor: 4, active: true });
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
    const err = await client.prompt("a1", "x").catch((e: unknown) => e);
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
