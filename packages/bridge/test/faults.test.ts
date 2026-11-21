import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { AttachStore, type Tools } from "../src/attach.js";
import { Faults, faultSocket, faultsRefusal } from "../src/faults.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { stt } from "../src/stt.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const prose = (n: number, markdown: string): { id: number; set: Record<string, string> } => ({ id: n, set: { type: "prose", role: "output", markdown } });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

const tools: Tools = {
  picture: async (_d, from) => ({ mime: from === "png" ? "image/png" : "image/jpeg", data: Buffer.from(`scaled ${from}`) }),
  pdfText: async () => ({ text: "text", pages: 1 }),
  pdfPages: async () => [],
};
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]);

async function rig(faults?: Faults, renewMs?: number): Promise<{ fake: FakeAria; port: number; lines: string[] }> {
  const fake = new FakeAria();
  fake.addAria(id);
  fake.rows = [{ id, mantra: "m" } as never];
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const lines: string[] = [];
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => fake.dial,
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    log: (l) => lines.push(l),
    attachments: new AttachStore({ tools }),
    ...stt({ socket: speech.path, store: "gluck", ...(faults ? { gate: () => faults.speechGate() } : {}) }),
    ...(renewMs ? { renew: async () => Date.now() + renewMs } : {}),
    ...(faults ? { faults } : {}),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, port: typeof addr === "object" && addr ? addr.port : 0, lines };
}

function open(url: string): Promise<{ ws: WebSocket; text: string[]; binary: number[]; closes: number[] }> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers });
    const text: string[] = [];
    const binary: number[] = [];
    const closes: number[] = [];
    ws.on("message", (d: Buffer, isBinary) => (isBinary ? binary.push(d.length) : text.push(d.toString())));
    ws.on("close", (c) => closes.push(c));
    ws.once("open", () => ok({ ws, text, binary, closes }));
    ws.once("error", fail);
    cleanups.push(() => ws.terminate());
  });
}

function post(port: number, path: string, body: Buffer, extra: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", method: "POST", path, agent: false, headers: { ...headers, "x-attach-name": "a.png", ...extra } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: b ? (JSON.parse(b) as Record<string, unknown>) : {} }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

async function session(faults?: Faults): Promise<{ page: string[]; audio: string[]; pcm: number[]; moved: number }> {
  const { fake, port, lines } = await rig(faults, 2_500);
  const page = await open(`ws://127.0.0.1:${port}/door`);
  const audio = await open(`ws://127.0.0.1:${port}/audio/${id}`);
  const call = async (n: number, method: string, params: Record<string, unknown>): Promise<void> => {
    page.ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    await until(`answer ${n}`, () => page.text.some((t) => (JSON.parse(t) as { id?: number }).id === n));
  };
  await call(1, "angelus.hello", { version: 1 });
  await call(2, "figaro.list", {});
  await call(3, "figaro.follow", { figaro_id: id });
  await until("audio ready", () => audio.text.some((t) => t.includes('"ready"')));
  const att = await post(port, "/attach", png);
  fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
  await call(4, "figaro.qua", { figaro_id: id, text: "look", attachments: [att.body.id] });
  for (const turn of [1, 2]) {
    fake.openTurn(id, turn, `turn ${turn}`);
    fake.update(id, turn, [prose(0, "Hello there. Rest")]);
    fake.update(id, turn, [{ id: 0, patch: { markdown: { at: 17, del: 0, ins: " of it." } } }]);
    fake.seal(id, turn);
    fake.done(id);
    await until(`audio end ${turn}`, () => audio.text.filter((t) => t.includes('"audio.end"')).length === turn);
    if (turn === 1) await tick(2_600);
  }
  await call(5, "figaro.read", { figaro_id: id });
  return { page: page.text, audio: audio.text, pcm: audio.binary, moved: lines.filter((l) => l.startsWith("door handover done")).length };
}

describe("faults", () => {
  it("off and idle are the same gateway: every page and audio frame byte for byte, across a handover", async () => {
    const off = await session();
    for (const c of cleanups.splice(0).reverse()) await c();
    const idle = await session(new Faults());
    expect(idle.page).toEqual(off.page);
    expect(idle.audio).toEqual(off.audio);
    expect(idle.pcm).toEqual(off.pcm);
    expect(off.page.length).toBeGreaterThan(10);
    expect(off.audio.filter((t) => t.includes('"audio.end"'))).toHaveLength(2);
    expect(off.moved).toBeGreaterThanOrEqual(2);
    expect(idle.moved).toBe(off.moved);
  }, 30_000);

  it("drops, delays and closes page frames, scoped to a session, and counts down", async () => {
    const faults = new Faults();
    const { fake, port } = await rig(faults);
    const a = await open(`ws://127.0.0.1:${port}/door?session=aaaaaaaaaaaa`);
    const b = await open(`ws://127.0.0.1:${port}/door?session=bbbbbbbbbbbb`);
    for (const p of [a, b]) p.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("both follow", () => [a, b].every((p) => p.text.length === 1));
    expect(faults.apply({ op: "page.drop", method: "figaro.aria", count: 2, session: "aaaaaaaaaaaa" })).toEqual({ ok: true });
    fake.openTurn(id, 1, "x");
    fake.update(id, 1, [prose(0, "one")]);
    fake.update(id, 1, [{ id: 0, patch: { markdown: { at: 3, del: 0, ins: " two" } } }]);
    await until("b gets three", () => b.text.length === 4);
    await tick(50);
    expect(a.text.length).toBe(2);
    faults.apply({ op: "page.delay", ms: 300, count: 1 });
    const t0 = Date.now();
    fake.seal(id, 1);
    await until("a gets the seal late", () => a.text.length === 3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(faults.apply({ op: "page.close", code: 4000, session: "bbbbbbbbbbbb" })).toEqual({ ok: true, sockets: 1 });
    await until("b closed", () => b.closes.length === 1);
    expect(b.closes).toEqual([4000]);
    expect(a.closes).toEqual([]);
  });

  it("lapses the door on cue and the handover hides it; a short bearer makes it repeat", async () => {
    const faults = new Faults();
    const { port, lines } = await rig(faults);
    faults.apply({ op: "door.bearer", ms: 3_000 });
    const p = await open(`ws://127.0.0.1:${port}/door`);
    p.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow", () => p.text.length === 1);
    expect(faults.apply({ op: "door.lapse", notice: true })).toMatchObject({ ok: true });
    await until("moved on the notice", () => lines.some((l) => l.startsWith("door handover done (lapse notice)")));
    await tick(3_500);
    expect(lines.filter((l) => l.startsWith("door handover done")).length).toBeGreaterThanOrEqual(2);
    expect(p.closes).toEqual([]);
  }, 10_000);

  it("stalls and fails speech: audio comes late, then an error frame; dictation answers 502", async () => {
    const faults = new Faults();
    const { fake, port } = await rig(faults);
    const audio = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    await until("ready", () => audio.text.some((t) => t.includes('"ready"')));
    faults.apply({ op: "speech.stall", ms: 400, count: 1 });
    const t0 = Date.now();
    fake.openTurn(id, 1, "x");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    await until("late audio", () => audio.binary.length > 0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    fake.seal(id, 1);
    fake.done(id);
    faults.apply({ op: "speech.fail", count: 1 });
    fake.openTurn(id, 2, "y");
    fake.update(id, 2, [prose(0, "Again. More")]);
    await until("speech error", () => audio.text.some((t) => t.includes('"code":"speech"')));
    faults.apply({ op: "speech.fail", count: 1 });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("clip")]);
    expect(await post(port, `/stt?aria=gluck/${id}`, webm, { "content-type": "audio/webm" })).toMatchObject({ status: 502, body: { error: "fault: speech failed" } });
  });

  it("takes ops as JSON lines on its socket, answers each, and refuses what it does not know", async () => {
    const faults = new Faults();
    const path = join(mkdtempSync(join(tmpdir(), "faults-")), "f.sock");
    const lines: string[] = [];
    const srv = await faultSocket(path, faults, (l) => lines.push(l));
    cleanups.push(() => new Promise<void>((ok) => srv.close(() => ok())));
    const answers: Record<string, unknown>[] = [];
    const c = connect(path);
    cleanups.push(() => void c.destroy());
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        answers.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        buf = buf.slice(i + 1);
      }
    });
    c.write('{"op":"page.drop","method":"figaro.aria","count":2}\n{"op":"nope"}\nnot json\n{"op":"page.delay"}\n{"op":"state"}\n');
    await until("five answers", () => answers.length === 5);
    expect(answers[0]).toEqual({ ok: true });
    expect(answers[1]).toEqual({ ok: false, error: "unknown op nope" });
    expect(answers[2]!.ok).toBe(false);
    expect(answers[3]).toEqual({ ok: false, error: "page.delay needs ms" });
    expect(answers[4]).toMatchObject({ ok: true, rules: [{ kind: "page.drop", count: 2 }] });
    expect(lines[0]).toMatch(/^faults armed on .*test mode$/);
  });

  it("refuses to arm on a production-shaped gateway", () => {
    expect(faultsRefusal({ path: "/run/figaro-gateway/gateway.sock" }, undefined)).toContain("loopback --port");
    expect(faultsRefusal({ port: 8080, host: "0.0.0.0" }, [])).toContain("0.0.0.0");
    expect(faultsRefusal({ port: 8080, host: "127.0.0.1" }, ["10.0.0.5"])).toContain("10.0.0.5");
    expect(faultsRefusal({ port: 8080, host: "127.0.0.1" }, ["127.0.0.1"])).toBeUndefined();
  });
});
