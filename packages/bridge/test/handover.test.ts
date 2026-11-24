import { afterEach, describe, expect, it } from "vitest";
import type { Dial, SocketEvents } from "figaro-forms";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import WebSocket from "ws";
import { handoverDial, leadFor } from "../src/handover.js";
import { Faults } from "../src/faults.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const lapseReason = "the bearer expired: reconnect with a fresh token";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Door {
  readonly dial: Dial;
  readonly renew: (until: number) => Promise<number | undefined>;
  readonly faults: Faults;
  readonly legs: number;
  readonly lapses: number;
}

interface DoorFaults {
  followAckMs?: number;
  holdReply?: { id: number; ms: number };
  lagNewMs?: number;
  killLeg?: { leg: number; afterMs: number };
  dialDelayMs?: number;
  onDial?: (leg: number) => void;
}

function faultyDoor(fake: FakeAria, ttlMs: number, notice = true, o: DoorFaults = {}): Door {
  const faults: Faults = new Faults(
    () => {},
    (n) => {
      o.onDial?.(n);
      if (n === 1 && o.dialDelayMs) faults.apply({ op: "door.stall", ms: o.dialDelayMs });
      if (o.killLeg && n === o.killLeg.leg) faults.apply({ op: "door.lapse", leg: n, notice: false, ms: o.killLeg.afterMs });
    },
  );
  faults.apply({ op: "door.bearer", ms: ttlMs, notice });
  if (o.followAckMs) faults.apply({ op: "door.delay", reply: "gateway", ms: o.followAckMs });
  if (o.holdReply) faults.apply({ op: "door.delay", reply: o.holdReply.id, ms: o.holdReply.ms, count: 1 });
  if (o.lagNewMs) faults.apply({ op: "door.delay", leg: "later", notify: true, ms: o.lagNewMs });
  const dial = faults.door(fake.dial, { session: "-", audio: false });
  cleanups.push(() => void faults.apply({ op: "clear" }));
  return {
    dial,
    renew: faults.renew(undefined),
    faults,
    get legs() {
      return faults.legsOpened;
    },
    get lapses() {
      return faults.legsCut;
    },
  };
}

function page(): { events: SocketEvents; frames: string[]; replies: Record<string, unknown>[]; closed: string[] } {
  const frames: string[] = [];
  const replies: Record<string, unknown>[] = [];
  const closed: string[] = [];
  return {
    frames,
    replies,
    closed,
    events: {
      message: (f) => {
        const j = JSON.parse(f) as Record<string, unknown>;
        if (j.method) frames.push(f);
        else replies.push(j);
      },
      closed: (r) => closed.push(r),
    },
  };
}

async function reference(fake: FakeAria): Promise<string[]> {
  const seen: string[] = [];
  const s = await fake.dial({ message: (f) => (JSON.parse(f).method ? seen.push(f) : undefined), closed: () => {} });
  s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
  await tick(5);
  return seen;
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

describe("door handover", () => {
  it("leads the lapse by a quarter of the bearer's life, between 2 s and 60 s, and forces by 1 to 10 s", () => {
    expect(leadFor(420_000)).toEqual({ open: 60_000, force: 10_000 });
    expect(leadFor(3_000)).toEqual({ open: 2_000, force: 1_000 });
    expect(leadFor(40_000)).toEqual({ open: 10_000, force: 3_200 });
  });

  it("carries a reply streaming across several lapses byte for byte, and the page never sees a close or a lapse", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000, true, { followAckMs: 120 });
    const ref = await reference(fake);
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: door.renew, log: (l) => lines.push(l), quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 7));
    fake.openTurn(id, 1, "go");
    const started = Date.now();
    let n = 0;
    while (Date.now() - started < 9_500) {
      fake.update(id, 1, [{ id: 0, ...(n === 0 ? { set: { type: "prose", role: "output", markdown: "" } } : {}), patch: { markdown: { at: n, del: 0, ins: "x" } } }]);
      n++;
      await tick(25);
    }
    fake.seal(id, 1);
    fake.done(id);
    await until("the last frame", () => p.frames.length === ref.length);
    expect(door.legs).toBeGreaterThanOrEqual(4);
    expect(lines.filter((l) => l.startsWith("door handover done"))).toHaveLength(door.legs - 1);
    expect(p.closed).toEqual([]);
    expect(p.frames.some((f) => f.includes("door.lapsed"))).toBe(false);
    expect(p.frames).toEqual(ref);
    expect(fake.conns.filter((c) => c.open)).toHaveLength(2);
  }, 20_000);

  it("moves between turns when the stream is quiet, before the deadline", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000);
    const ref = await reference(fake);
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: door.renew, log: (l) => lines.push(l), quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 1));
    for (let t = 1; t <= 4; t++) {
      fake.openTurn(id, t, `turn ${t}`);
      for (let k = 0; k < 5; k++) {
        fake.update(id, t, [{ id: 0, ...(k === 0 ? { set: { type: "prose", role: "output", markdown: "" } } : {}), patch: { markdown: { at: k, del: 0, ins: "y" } } }]);
        await tick(20);
      }
      fake.seal(id, t);
      fake.done(id);
      await tick(1_200);
    }
    await until("all frames", () => p.frames.length === ref.length);
    expect(p.frames).toEqual(ref);
    expect(p.closed).toEqual([]);
    expect(lines.filter((l) => l.startsWith("door handover done (between turns)")).length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes("(deadline)"))).toBe(false);
  }, 20_000);

  it("answers a request sent on the old leg from the old leg, and sends new requests on the new one", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    fake.finishedTurn(id, 1, "old", [{ type: "prose", role: "output", markdown: "Ciao." } as never]);
    const door = faultyDoor(fake, 3_000);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    fake.holdReads = true;
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.read", params: { figaro_id: id } }));
    await until("a second leg", () => door.legs === 2, 4_000);
    fake.release();
    await until("read answer", () => p.replies.some((r) => r.id === 2));
    await until("the old leg closed", () => fake.conns.filter((c) => c.open).length === 1);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.read", params: { figaro_id: id } }));
    await until("second read answer", () => p.replies.some((r) => r.id === 3));
    const answered = fake.conns.filter((c) => c.received.some((f) => f.method === "figaro.read"));
    expect(answered).toHaveLength(2);
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("passes a close through when no handover can help: no renewable bearer", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 1_500);
    const p = page();
    const lines: string[] = [];
    const stale = Date.now() + 1_500;
    const sock = await handoverDial(door.dial, { renew: async () => stale, log: (l) => lines.push(l) })(p.events);
    cleanups.push(() => sock.close());
    await until("the close", () => p.closed.length === 1, 4_000);
    expect(p.closed).toEqual([lapseReason]);
    expect(lines.some((l) => l.includes("no bearer outlasting"))).toBe(true);
  }, 10_000);

  it("keeps an aria a qua followed when it moves, as the daemon follows on qua", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, text: "hi" } }));
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.follow", params: { figaro_id: "@recent", channels: ["form"] } }));
    fake.addForm("@recent", {});
    await until("a second leg", () => door.legs === 2, 4_000);
    await until("its follows", () => (fake.conns[fake.conns.length - 1]?.follows.size ?? 0) === 2);
    const last = fake.conns[fake.conns.length - 1]!;
    expect([...last.follows].sort()).toEqual([id, "@recent"]);
    expect(last.channels.get("@recent")).toEqual(["form"]);
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("loses nothing when the old leg lapses while the new leg's follows are still unanswered", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000, false, { followAckMs: 1_600 });
    const ref = await reference(fake);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 7));
    fake.openTurn(id, 1, "go");
    const started = Date.now();
    let n = 0;
    while (Date.now() - started < 4_500) {
      fake.update(id, 1, [{ id: 0, ...(n === 0 ? { set: { type: "prose", role: "output", markdown: "" } } : {}), patch: { markdown: { at: n, del: 0, ins: "z" } } }]);
      n++;
      await tick(25);
    }
    fake.seal(id, 1);
    await until("the last frame", () => p.frames.length >= ref.length, 4_000);
    expect(door.lapses).toBeGreaterThanOrEqual(1);
    expect(p.closed).toEqual([]);
    expect(p.frames).toEqual(ref);
  }, 15_000);

  it("follows on the new leg an aria whose qua is answered on the old leg after the switch, and drops an unfollow there too", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    fake.addForm("@recent", {});
    const door = faultyDoor(fake, 3_000, true, { holdReply: { id: 5, ms: 2_400 } });
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "figaro.follow", params: { figaro_id: "@recent" } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 4));
    fake.conns[fake.conns.length - 1]!.follows.add(id);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "figaro.qua", params: { figaro_id: id, text: "hi" } }));
    await until("a second leg", () => door.legs === 2, 4_000);
    await until("the qua answer", () => p.replies.some((r) => r.id === 5), 4_000);
    await until("the aria followed on the new leg", () => fake.conns[fake.conns.length - 1]!.follows.has(id), 300);
    expect(door.legs).toBe(2);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "figaro.unfollow", params: { figaro_id: "@recent" } }));
    await until("unfollow answer", () => p.replies.some((r) => r.id === 6));
    expect(fake.conns.filter((c) => c.open).every((c) => !c.follows.has("@recent"))).toBe(true);
    fake.openTurn(id, 2, "after");
    await until("a frame after the switch", () => p.frames.some((f) => f.includes('"after"')));
    expect(p.closed).toEqual([]);
  }, 12_000);

  it("carries an unfollow answered on the old leg to the new leg it is moving to", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    fake.addForm("@recent", {});
    const door = faultyDoor(fake, 3_000, true, { followAckMs: 600 });
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: "@recent" } }));
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answers", () => p.replies.filter((r) => r.id === 1 || r.id === 2).length === 2);
    await until("a second leg following", () => door.legs === 2 && fake.conns[fake.conns.length - 1]!.follows.size === 2, 4_000);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.unfollow", params: { figaro_id: "@recent" } }));
    await until("unfollow answer", () => p.replies.some((r) => r.id === 3));
    await until("the old leg closed", () => fake.conns.filter((c) => c.open).length === 1, 4_000);
    const open = fake.conns.filter((c) => c.open);
    expect([...open[0]!.follows]).toEqual([id]);
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("doubles nothing when the new leg's copies arrive after the switch, with repeated identical frames in the stream", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000, true, { lagNewMs: 80 });
    const ref = await reference(fake);
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: door.renew, log: (l) => lines.push(l), quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 7));
    const started = Date.now();
    let t = 0;
    while (Date.now() - started < 7_000) {
      t++;
      fake.openTurn(id, t, "go");
      for (let k = 0; k < 4; k++) {
        fake.update(id, t, [{ id: 0, ...(k === 0 ? { set: { type: "prose", role: "output", markdown: "" } } : {}), patch: { markdown: { at: k, del: 0, ins: "w" } } }]);
        await tick(15);
      }
      fake.seal(id, t);
      fake.done(id);
      fake.done(id);
      await tick(15);
    }
    await until("the last frame", () => p.frames.length >= ref.length, 4_000);
    await tick(300);
    expect(door.legs).toBeGreaterThanOrEqual(3);
    expect(p.frames.length).toBe(ref.length);
    expect(p.frames).toEqual(ref);
    expect(p.closed).toEqual([]);
  }, 20_000);

  it("anchors on the right copy when a frame identical to the new leg's first was delivered before the new leg followed", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    let moving = false;
    const door = faultyDoor(fake, 3_000, true, { dialDelayMs: 150, onDial: (n) => (moving = n === 2) });
    const ref = await reference(fake);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("the move begins", () => moving, 4_000);
    fake.done(id);
    fake.openTurn(id, 1, "a");
    await until("the new leg following", () => fake.conns.length === 3 && fake.conns[2]!.follows.has(id), 2_000);
    fake.done(id);
    fake.openTurn(id, 2, "b");
    await until("the old leg closed", () => fake.conns.filter((c) => c.open).length === 2, 3_000);
    fake.openTurn(id, 3, "c");
    await until("all frames", () => p.frames.length >= ref.length);
    await tick(100);
    expect(p.frames).toEqual(ref);
  }, 10_000);

  it("answers the page with an error for a request the retired leg took to its close, and refuses a reserved id", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 1));
    fake.holdReads = true;
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "figaro.read", params: { figaro_id: id } }));
    await until("an error for the read", () => p.replies.some((r) => r.id === 9), 5_000);
    expect(JSON.stringify(p.replies.find((r) => r.id === 9))).toContain("ended before answering");
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: -1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("reserved id refused", () => p.replies.some((r) => r.id === -1));
    expect(JSON.stringify(p.replies.find((r) => r.id === -1))).toContain("reserved");
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("gives up a move at once when the new leg dies before its follows are answered", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000, true, { followAckMs: 5_000, killLeg: { leg: 2, afterMs: 100 } });
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: door.renew, log: (l) => lines.push(`${Date.now()} ${l}`), quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("a second leg", () => door.legs === 2, 4_000);
    const t = Date.now();
    await until("the move given up", () => lines.some((l) => l.includes("abandoned")), 2_000);
    expect(Date.now() - t).toBeLessThan(1_000);
  }, 10_000);

  it("moves at once on a lapse notice it did not expect, and never passes the notice on", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 60_000);
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: door.renew, log: (l) => lines.push(l), quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => p.replies.some((r) => r.id === 1));
    door.faults.apply({ op: "door.lapse", notice: true });
    await until("a lapse", () => door.lapses >= 1, 4_000);
    await until("a second leg", () => door.legs === 2);
    await tick(200);
    expect(lines.some((l) => l.startsWith("door handover done (lapse notice)"))).toBe(true);
    expect(p.frames.some((f) => f.includes("door.lapsed"))).toBe(false);
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("moves before a lapse the door gives no notice of", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000, false);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await tick(7_000);
    expect(door.legs).toBeGreaterThanOrEqual(3);
    expect(door.lapses).toBe(0);
    expect(p.closed).toEqual([]);
  }, 12_000);

  it("keeps a page's /door socket and an /audio listener open through the gateway across lapses", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = faultyDoor(fake, 3_000);
    const speech = await startFakeSpeech();
    const secret = "s".repeat(40);
    const lines: string[] = [];
    const gw = await startGateway({
      listen: { port: 0 },
      edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
      door: () => door.dial,
      renew: door.renew,
      speech: speechOverSocket(speech.path),
      speechSocket: speech.path,
      store: "gluck",
      log: (l) => lines.push(l),
    });
    cleanups.push(() => void gw.close(), () => void speech.stop());
    const addr = gw.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
    const closes: number[] = [];
    const pageWs = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers });
    const audioWs = new WebSocket(`ws://127.0.0.1:${port}/audio/${id}`, { headers });
    for (const w of [pageWs, audioWs]) {
      w.on("close", (c) => closes.push(c));
      cleanups.push(() => w.terminate());
    }
    const audio: Record<string, unknown>[] = [];
    audioWs.on("message", (d, binary) => !binary && audio.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise<void>((ok) => pageWs.once("open", () => ok()));
    pageWs.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("audio ready", () => audio.some((f) => f.type === "ready"));
    await tick(6_500);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [{ id: 0, set: { type: "prose", role: "output", markdown: "Hello there. Rest" } }]);
    fake.seal(id, 1);
    fake.done(id);
    await until("audio end", () => audio.some((f) => f.type === "audio.end"));
    expect(door.legs).toBeGreaterThanOrEqual(6);
    expect(closes).toEqual([]);
    expect(lines.filter((l) => l.startsWith("door handover done")).length).toBeGreaterThanOrEqual(4);
    expect(lines.some((l) => l.includes("door closed"))).toBe(false);
  }, 20_000);
});
