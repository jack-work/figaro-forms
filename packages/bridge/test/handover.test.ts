import { afterEach, describe, expect, it } from "vitest";
import type { Dial, Socket, SocketEvents } from "figaro-forms";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import WebSocket from "ws";
import { handoverDial, leadFor } from "../src/handover.js";
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
  legs: number;
  lapses: number;
}

function lapsingDoor(fake: FakeAria, ttlMs: number, notice = true, o: { followAckMs?: number; claimedSkewMs?: number; holdReply?: { id: number; ms: number } } = {}): Door {
  let tokenExp = 0;
  const door: Door = {
    legs: 0,
    lapses: 0,
    renew: async (until) => {
      if (tokenExp + (o.claimedSkewMs ?? 0) < until) tokenExp = Date.now() + ttlMs;
      return tokenExp + (o.claimedSkewMs ?? 0);
    },
    dial: async (outer: SocketEvents) => {
      const exp = tokenExp;
      door.legs++;
      let dead = false;
      const inner = await fake.dial({
        message: (f) => {
          if (dead) return;
          if (o.holdReply && JSON.parse(f).id === o.holdReply.id && !JSON.parse(f).method) {
            setTimeout(() => !dead && outer.message(f), o.holdReply.ms);
            return;
          }
          if (o.followAckMs && f.includes("gw-handover")) {
            setTimeout(() => !dead && outer.message(f), o.followAckMs);
            return;
          }
          outer.message(f);
        },
        closed: (r) => {
          if (!dead) {
            dead = true;
            outer.closed(r);
          }
        },
      });
      const lapse = setTimeout(() => {
        if (dead) return;
        door.lapses++;
        if (notice) outer.message(JSON.stringify({ jsonrpc: "2.0", method: "door.lapsed", params: { reason: lapseReason, after_ms: ttlMs } }));
        setTimeout(() => {
          if (dead) return;
          dead = true;
          inner.close();
          outer.closed(lapseReason);
        }, 50);
      }, Math.max(0, exp - Date.now()));
      cleanups.push(() => clearTimeout(lapse));
      const socket: Socket = {
        send: (f) => {
          if (dead) throw new Error("socket closed");
          inner.send(f);
        },
        close: () => {
          if (dead) return;
          dead = true;
          clearTimeout(lapse);
          inner.close();
        },
      };
      return socket;
    },
  };
  return door;
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
    const door = lapsingDoor(fake, 3_000, true, { followAckMs: 120 });
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
    const door = lapsingDoor(fake, 3_000);
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
    const door = lapsingDoor(fake, 3_000);
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    fake.holdReads = true;
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.read", params: { figaro_id: id } }));
    await until("a second leg", () => door.legs === 2, 4_000);
    fake.release();
    await until("read answer", () => p.replies.some((r) => r.id === 2));
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.read", params: { figaro_id: id } }));
    await until("second read answer", () => p.replies.some((r) => r.id === 3));
    const answered = fake.conns.filter((c) => c.received.some((f) => f.method === "figaro.read"));
    expect(answered).toHaveLength(2);
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("passes a close through when no handover can help: no renewable bearer", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = lapsingDoor(fake, 1_500);
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: async () => door.renew(0), log: (l) => lines.push(l) })(p.events);
    cleanups.push(() => sock.close());
    await until("the close", () => p.closed.length === 1, 4_000);
    expect(p.closed).toEqual([lapseReason]);
    expect(lines.some((l) => l.includes("no bearer outlasting"))).toBe(true);
  }, 10_000);

  it("keeps an aria a qua followed when it moves, as the daemon follows on qua", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = lapsingDoor(fake, 3_000);
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
    const door = lapsingDoor(fake, 3_000, false, { followAckMs: 1_600 });
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
    const door = lapsingDoor(fake, 3_000, true, { holdReply: { id: 5, ms: 2_400 } });
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
    const door = lapsingDoor(fake, 3_000, true, { followAckMs: 600 });
    const p = page();
    const sock = await handoverDial(door.dial, { renew: door.renew, quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: "@recent" } }));
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answers", () => p.replies.filter((r) => r.id === 1 || r.id === 2).length === 2);
    await until("a second leg following", () => door.legs === 2 && fake.conns[fake.conns.length - 1]!.follows.size === 2, 4_000);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.unfollow", params: { figaro_id: "@recent" } }));
    await until("unfollow answer", () => p.replies.some((r) => r.id === 3));
    await tick(800);
    const open = fake.conns.filter((c) => c.open);
    expect(open).toHaveLength(1);
    expect([...open[0]!.follows]).toEqual([id]);
    expect(p.closed).toEqual([]);
  }, 10_000);

  it("moves at once on a lapse notice it did not expect, and never passes the notice on", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const door = lapsingDoor(fake, 1_500, true, { claimedSkewMs: 60_000 });
    const p = page();
    const lines: string[] = [];
    const sock = await handoverDial(door.dial, { renew: door.renew, log: (l) => lines.push(l), quietMs: 50 })(p.events);
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
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
    const door = lapsingDoor(fake, 3_000, false);
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
    const door = lapsingDoor(fake, 3_000);
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
