import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { recordingTracer, type FinishedSpan } from "../src/trace.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const good = { "x-figaro-edge": secret, "remote-user": "gluck" };
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

async function rig(compress?: boolean): Promise<{ fake: FakeAria; port: number; lines: string[]; spans: FinishedSpan[] }> {
  const fake = new FakeAria();
  fake.addAria(id);
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const lines: string[] = [];
  const spans: FinishedSpan[] = [];
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => fake.dial,
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    log: (l) => lines.push(l),
    tracer: recordingTracer((s) => spans.push(s)),
    ...(compress === undefined ? {} : { compress }),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, port: typeof addr === "object" && addr ? addr.port : 0, lines, spans };
}

async function session(port: number, offer: boolean, calls: number): Promise<{ ext: string; wire: number; raw: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers: good, perMessageDeflate: offer });
  cleanups.push(() => ws.terminate());
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", fail);
  });
  let raw = 0;
  let answers = 0;
  ws.on("message", (d: Buffer) => {
    raw += d.length;
    answers++;
  });
  for (let i = 1; i <= calls; i++) ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method: "figaro.list", params: {} }));
  await until("answers", () => answers === calls);
  const wire = (ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
  const ext = ws.extensions;
  ws.close();
  return { ext, wire, raw };
}

describe("compression on /door", () => {
  it("negotiates permessage-deflate and sends repeated JSON at a fraction of its size", async () => {
    const { fake, port, lines, spans } = await rig();
    fake.rows = Array.from({ length: 60 }, (_, i) => ({ id: `${String(i).padStart(32, "0")}`, mantra: `a mantra ${i % 5}`, state: "dormant" }) as never);
    const r = await session(port, true, 20);
    expect(r.ext).toContain("permessage-deflate");
    expect(r.wire * 8).toBeLessThan(r.raw);
    await until("closed line", () => lines.some((l) => l.startsWith("door: session closed")));
    const line = lines.find((l) => l.startsWith("door: session closed"))!;
    expect(line).toMatch(/frames_out=20 bytes_out=\d+ wire_out=\d+ frames_in=20 bytes_in=\d+ wire_in=\d+ deflate=true session=-$/);
    const out = Number(/bytes_out=(\d+)/.exec(line)![1]);
    const wire = Number(/wire_out=(\d+)/.exec(line)![1]);
    expect(out).toBe(r.raw);
    expect(wire * 8).toBeLessThan(out);
    await until("span", () => spans.some((s) => s.name === "door session"));
    expect(spans.find((s) => s.name === "door session")!.attributes).toMatchObject({ "door.frames_out": 20, "door.bytes_out": out, "door.deflate": true });
  });

  it("serves a client that does not offer it, and turns it off with compress false", async () => {
    for (const [compress, offer] of [[undefined, false], [false, true]] as const) {
      const { fake, port, lines } = await rig(compress);
      fake.rows = Array.from({ length: 60 }, (_, i) => ({ id: `${String(i).padStart(32, "0")}`, mantra: `a mantra ${i % 5}` }) as never);
      const r = await session(port, offer, 3);
      expect(r.ext).toBe("");
      expect(r.wire).toBeGreaterThan(r.raw);
      await until("closed line", () => lines.some((l) => l.startsWith("door: session closed")));
      expect(lines.find((l) => l.startsWith("door: session closed"))).toContain("deflate=false");
    }
  });
});

describe("the session close line on /door", () => {
  it("names the close code, the reason and how long the socket lived", async () => {
    const { port, lines, spans } = await rig();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers: good });
    cleanups.push(() => ws.terminate());
    await new Promise<void>((ok, fail) => {
      ws.once("open", () => ok());
      ws.once("error", fail);
    });
    ws.close(4001, "page hidden");
    await until("closed line", () => lines.some((l) => l.startsWith("door: session closed")));
    expect(lines.find((l) => l.startsWith("door: session closed"))).toMatch(/ code=4001 reason=page hidden lived_ms=\d+ /);
    await until("span", () => spans.some((s) => s.name === "door session"));
    expect(spans.find((s) => s.name === "door session")!.attributes).toMatchObject({ "ws.close_code": 4001 });
  });
});
