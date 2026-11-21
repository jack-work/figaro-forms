import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Dial, Socket } from "figaro-forms";
import { AriaClient } from "figaro-forms/aria";
import { webSocketDial } from "figaro-forms";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { Faults } from "../src/faults.js";
import { startGateway } from "../src/gateway.js";
import { handoverDial } from "../src/handover.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function watchCrashes(): unknown[] {
  const errors: unknown[] = [];
  const on = (e: unknown): void => void errors.push(e);
  process.on("unhandledRejection", on);
  process.on("uncaughtException", on);
  cleanups.push(() => {
    process.off("unhandledRejection", on);
    process.off("uncaughtException", on);
  });
  return errors;
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

const deadAfter = (dial: Dial, sends: number): Dial => async (events) => {
  const s = await dial(events);
  let n = 0;
  const socket: Socket = {
    send: (f) => {
      if (++n > sends) throw new Error("socket closed");
      s.send(f);
    },
    close: () => s.close(),
  };
  return socket;
};

async function gateway(o: { door: Dial; faults?: Faults }): Promise<number> {
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const gw = await startGateway({ listen: { port: 0 }, edge: { secret, admin: "gluck", peers: ["127.0.0.1"] }, door: () => o.door, speech: speechOverSocket(speech.path), speechSocket: speech.path, store: "gluck", log: () => {}, ...(o.faults ? { faults: o.faults } : {}) });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

describe("a door that fails a send", () => {
  it("never takes the gateway down: the page's socket closes 1011 and the next page is served", async () => {
    const errors = watchCrashes();
    const fake = new FakeAria();
    fake.addAria(id);
    const port = await gateway({ door: deadAfter(fake.dial, 0) });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers });
    cleanups.push(() => ws.terminate());
    const closed = new Promise<number>((ok) => ws.once("close", (c) => ok(c)));
    await new Promise((ok) => ws.once("open", ok));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    expect(await closed).toBe(1011);
    const again = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers });
    cleanups.push(() => again.terminate());
    await new Promise((ok) => again.once("open", ok));
    expect(errors).toEqual([]);
  });

  it("answers the page's request with an error when the handover's current leg fails the send", async () => {
    const errors = watchCrashes();
    const fake = new FakeAria();
    fake.addAria(id);
    const replies: Record<string, unknown>[] = [];
    const sock = await handoverDial(deadAfter(fake.dial, 0), { renew: async () => undefined })({ message: (f) => replies.push(JSON.parse(f) as Record<string, unknown>), closed: () => {} });
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "figaro.qua", params: { figaro_id: id, text: "x" } }));
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32003, message: "gateway: the door connection is closed; send again" } }]);
    sock.send(JSON.stringify({ jsonrpc: "2.0", method: "note" }));
    await tick(20);
    expect(errors).toEqual([]);
  });

  it("drops a follow it carries to a leg that fails the send, with no unhandled rejection", async () => {
    const errors = watchCrashes();
    const fake = new FakeAria();
    fake.addAria(id);
    fake.addForm("@recent", {});
    const faults = new Faults();
    faults.apply({ op: "door.bearer", ms: 3_000 });
    faults.apply({ op: "door.delay", reply: 5, ms: 2_400, count: 1 });
    let legs = 0;
    const base = faults.door(fake.dial, { session: "-", audio: false });
    const door: Dial = async (events) => (++legs === 1 ? base(events) : deadAfter(base, 1)(events));
    const replies: Record<string, unknown>[] = [];
    const sock = await handoverDial(door, { renew: faults.renew(undefined), quietMs: 50 })({ message: (f) => replies.push(JSON.parse(f) as Record<string, unknown>), closed: () => {} });
    cleanups.push(() => sock.close());
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "figaro.follow", params: { figaro_id: "@recent" } }));
    await until("follow answer", () => replies.some((r) => r.id === 4));
    fake.conns[fake.conns.length - 1]!.follows.add(id);
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "figaro.qua", params: { figaro_id: id, text: "hi" } }));
    await until("a second leg", () => legs === 2, 4_000);
    await until("the qua answer", () => replies.some((r) => r.id === 5), 4_000);
    await tick(100);
    expect(errors).toEqual([]);
  }, 10_000);

  it("survives the fuzz case: lapses without notice on short bearers, with a page and audio attached", async () => {
    const errors = watchCrashes();
    const fake = new FakeAria();
    fake.addAria(id);
    fake.addForm("@recent", {});
    const faults = new Faults();
    const port = await gateway({ door: fake.dial, faults });
    const client = new AriaClient({ dial: webSocketDial({ url: `ws://127.0.0.1:${port}/door`, credential: { name: "edge", upgrade: () => ({ headers }) }, WebSocket: WebSocket as never }), retryMinMs: 20 });
    cleanups.push(() => client.close());
    await client.attach(id).ready();
    const audio = new WebSocket(`ws://127.0.0.1:${port}/audio/${id}`, { headers });
    cleanups.push(() => audio.terminate());
    await new Promise((ok) => audio.once("message", ok));
    for (const [bearer, notice] of [[1_500, false], [3_000, false], [1_500, true], [null, false]] as const) {
      faults.apply({ op: "door.bearer", ms: bearer });
      await tick(300);
      faults.apply({ op: "door.lapse", notice });
      await tick(800);
    }
    faults.apply({ op: "door.lapse", notice: false, ms: 0 });
    await tick(500);
    const fresh = new AriaClient({ dial: webSocketDial({ url: `ws://127.0.0.1:${port}/door`, credential: { name: "edge", upgrade: () => ({ headers }) }, WebSocket: WebSocket as never }), retryMinMs: 20 });
    cleanups.push(() => fresh.close());
    await fresh.attach(id).ready();
    expect(errors).toEqual([]);
  }, 20_000);
});
