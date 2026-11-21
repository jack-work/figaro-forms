import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { stt, type SttOptions } from "../src/stt.js";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { fakePcm, startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const secret = "s".repeat(40);
const aria = "gluck/0123456789abcdef0123456789abcdef";
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

type Limits = Partial<Pick<SttOptions, "maxConcurrent" | "idleMs" | "maxStreamMs" | "maxStreamBytes">>;

async function rig(limits: Limits = {}, socket?: string): Promise<{ speech: FakeSpeech; port: number }> {
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const path = socket ?? speech.path;
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => new FakeAria().dial,
    speech: speechOverSocket(path),
    speechSocket: path,
    store: "gluck",
    ...stt({ socket: path, store: "gluck", ...limits }),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { speech, port: typeof addr === "object" && addr ? addr.port : 0 };
}

interface Client {
  readonly ws: WebSocket;
  readonly got: Record<string, unknown>[];
  readonly closed: Promise<{ code: number; reason: string }>;
}

async function dial(port: number, query = `?aria=${encodeURIComponent(aria)}`): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stt/stream${query}`, { headers });
  cleanups.push(() => ws.terminate());
  const got: Record<string, unknown>[] = [];
  ws.on("message", (d, binary) => {
    if (!binary) got.push(JSON.parse(d.toString()) as Record<string, unknown>);
  });
  const closed = new Promise<{ code: number; reason: string }>((ok) => ws.once("close", (code, reason) => ok({ code, reason: reason.toString() })));
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("unexpected-response", (_r, res) => fail(new Error(`status ${res.statusCode}`)));
    ws.once("error", fail);
  });
  return { ws, got, closed };
}

const types = (c: Client): string[] => c.got.map((f) => String(f.type));
const ofType = (c: Client, t: string): Record<string, unknown>[] => c.got.filter((f) => f.type === t);
const frame = (bytes = 6400): Buffer => fakePcm(bytes);

async function errorOf(c: Client): Promise<{ code: unknown; close: number }> {
  const { code } = await c.closed;
  const errs = ofType(c, "error");
  expect(errs).toHaveLength(1);
  expect(typeof errs[0]?.text).toBe("string");
  return { code: errs[0]?.code, close: code };
}

function post(port: number, body: Buffer): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", method: "POST", path: `/stt?aria=${encodeURIComponent(aria)}`, headers: { ...headers, "content-type": "audio/webm" } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("WS /stt/stream", () => {
  it("passes PCM to speech and answers ready, partials, finals in order, then done with the joined text, closing 1000", async () => {
    const { speech, port } = await rig();
    const c = await dial(port, `?aria=${encodeURIComponent(aria)}&lang=en-GB`);
    for (let i = 0; i < 3; i++) c.ws.send(frame(), { binary: true });
    await until("three partials", () => ofType(c, "partial").length === 3);
    c.ws.send(JSON.stringify({ type: "end" }));
    expect((await c.closed).code).toBe(1000);
    expect(types(c)).toEqual(["ready", "partial", "partial", "partial", "final", "done"]);
    expect(ofType(c, "partial").map((f) => f.text)).toEqual(["hello", "hello figaro", "hello figaro how"]);
    expect(ofType(c, "final")[0]).toEqual({ type: "final", text: "hello figaro how", offset_ms: 0, duration_ms: 600 });
    expect(ofType(c, "done")[0]).toEqual({ type: "done", audio_id: "clip-2", duration_ms: 600, text: "hello figaro how" });
    const call = speech.streams[0]!;
    expect(new URL(call.url, "http://speech").searchParams.get("lang")).toBe("en-GB");
    expect(call.url).not.toContain("aria");
    expect(Buffer.concat(call.audio).length).toBe(3 * 6400);
  });

  it("buffers audio sent before ready and passes it on once speech is open", async () => {
    const { speech, port } = await rig();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stt/stream?aria=${encodeURIComponent(aria)}`, { headers });
    cleanups.push(() => ws.terminate());
    await new Promise<void>((ok) => ws.once("open", () => ok()));
    ws.send(frame(3200), { binary: true });
    ws.send(frame(3200), { binary: true });
    await until("both frames at speech", () => speech.streams[0]?.audio.length === 2);
  });

  it("caps audio held before speech is ready at 2 s of PCM: past it, unreachable and 1011, speech dropped", async () => {
    const { speech, port } = await rig();
    speech.streamReady = false;
    const c = await dial(port);
    for (let i = 0; i < 10; i++) c.ws.send(frame(), { binary: true });
    await until("speech dialed", () => speech.streams.length === 1);
    await tick(50);
    expect(c.got).toEqual([]);
    c.ws.send(frame(), { binary: true });
    expect(await errorOf(c)).toEqual({ code: "unreachable", close: 1011 });
    await until("speech dropped", () => speech.streams[0]?.closed === true);
    expect(speech.streams[0]?.audio).toEqual([]);
  });

  it("on cancel sends no done, tells speech to cancel, and closes 1000", async () => {
    const { speech, port } = await rig();
    const c = await dial(port);
    c.ws.send(frame(), { binary: true });
    await until("a partial", () => ofType(c, "partial").length === 1);
    c.ws.send(JSON.stringify({ type: "cancel" }));
    expect((await c.closed).code).toBe(1000);
    expect(ofType(c, "done")).toEqual([]);
    expect(speech.streams[0]?.frames).toEqual([{ type: "cancel" }]);
  });

  it.each([
    ["no aria", ""],
    ["an aria from another store", `?aria=${encodeURIComponent("other/0123456789abcdef0123456789abcdef")}`],
    ["a malformed aria", "?aria=gluck/xyz"],
    ["a malformed lang", `?aria=${encodeURIComponent(aria)}&lang=english`],
  ])("refuses %s with bad-request and 1008, before speech", async (_what, query) => {
    const { speech, port } = await rig();
    expect(await errorOf(await dial(port, query))).toEqual({ code: "bad-request", close: 1008 });
    expect(speech.streams).toHaveLength(0);
  });

  it("answers unreachable and 1011 when the speech socket is down", async () => {
    const gone = join(mkdtempSync(join(tmpdir(), "ffs-")), "absent.sock");
    const { port } = await rig({}, gone);
    expect(await errorOf(await dial(port))).toEqual({ code: "unreachable", close: 1011 });
  });

  it("passes speech's own error through with 1011", async () => {
    const { speech, port } = await rig();
    speech.streamFailAfter = 2;
    const c = await dial(port);
    c.ws.send(frame(), { binary: true });
    c.ws.send(frame(), { binary: true });
    expect(await errorOf(c)).toEqual({ code: "speech", close: 1011 });
    expect(types(c)).toEqual(["ready", "partial", "error"]);
  });

  it.each([
    ["an odd-length audio frame", frame(6399)],
    ["an audio frame over 6400 bytes", frame(6402)],
    ["an empty audio frame", Buffer.alloc(0)],
    ["a text frame other than end or cancel", JSON.stringify({ type: "say" })],
    ["a text frame that is not JSON", "end"],
  ])("refuses %s with bad-request and 1008, and drops speech", async (_what, bad) => {
    const { speech, port } = await rig();
    const c = await dial(port);
    await until("ready", () => ofType(c, "ready").length === 1);
    c.ws.send(bad, { binary: Buffer.isBuffer(bad) });
    expect(await errorOf(c)).toEqual({ code: "bad-request", close: 1008 });
    await until("speech dropped", () => speech.streams[0]?.closed === true);
    expect(ofType(c, "done")).toEqual([]);
  });

  it("closes idle with 1011 after no audio for idleMs, and drops speech", async () => {
    const { speech, port } = await rig({ idleMs: 150 });
    const c = await dial(port);
    c.ws.send(frame(), { binary: true });
    const started = Date.now();
    expect(await errorOf(c)).toEqual({ code: "idle", close: 1011 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await until("speech dropped", () => speech.streams[0]?.closed === true);
  });

  it("keeps a session alive while audio keeps coming, past idleMs", async () => {
    const { port } = await rig({ idleMs: 150 });
    const c = await dial(port);
    for (let i = 0; i < 5; i++) {
      c.ws.send(frame(), { binary: true });
      await tick(60);
    }
    c.ws.send(JSON.stringify({ type: "end" }));
    expect((await c.closed).code).toBe(1000);
    expect(ofType(c, "done")).toHaveLength(1);
  });

  it("closes too-long with 1011 past maxStreamMs", async () => {
    const { port } = await rig({ maxStreamMs: 200 });
    const c = await dial(port);
    const beat = setInterval(() => c.ws.readyState === c.ws.OPEN && c.ws.send(frame(), { binary: true }), 30);
    cleanups.push(() => clearInterval(beat));
    expect(await errorOf(c)).toEqual({ code: "too-long", close: 1011 });
  });

  it("closes too-long with 1011 past maxStreamBytes", async () => {
    const { port } = await rig({ maxStreamBytes: 3 * 6400 });
    const c = await dial(port);
    for (let i = 0; i < 4; i++) c.ws.send(frame(), { binary: true });
    expect(await errorOf(c)).toEqual({ code: "too-long", close: 1011 });
  });

  it("shares the in-flight cap with POST /stt: busy and 1011 past it, free again after done", async () => {
    const { port } = await rig({ maxConcurrent: 1 });
    const first = await dial(port);
    await until("ready", () => ofType(first, "ready").length === 1);
    expect(await errorOf(await dial(port))).toEqual({ code: "busy", close: 1011 });
    expect(await post(port, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))).toBe(503);
    first.ws.send(frame(), { binary: true });
    first.ws.send(JSON.stringify({ type: "end" }));
    expect((await first.closed).code).toBe(1000);
    let status = 0;
    for (const end = Date.now() + 3000; status !== 200 && Date.now() < end; await tick(10)) status = await post(port, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]));
    expect(status).toBe(200);
    const again = await dial(port);
    await until("ready again", () => ofType(again, "ready").length === 1);
  });

  it("cancels recognition upstream when the client drops mid-stream", async () => {
    const { speech, port } = await rig();
    const c = await dial(port);
    c.ws.send(frame(), { binary: true });
    await until("a partial", () => ofType(c, "partial").length === 1);
    c.ws.terminate();
    await until("speech dropped", () => speech.streams[0]?.closed === true);
    expect(speech.streams[0]?.frames.some((f) => f.type === "end")).toBe(false);
  });
});
