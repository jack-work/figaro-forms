import { request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { Dictations } from "../src/dictation.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { stt } from "../src/stt.js";
import { fakePcm, startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const sa = "Ab3_x-9ZqQ1w2E4r";
const sb = "Zz9_y-8YpP0v1D3q";
const clip = "202611-0123456789abcdef";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(what: string, ok: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

async function rig(now?: () => number): Promise<{ fake: FakeAria; speech: FakeSpeech; port: number; lines: string[] }> {
  const fake = new FakeAria();
  fake.addAria(id);
  fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
  const speech = await startFakeSpeech();
  speech.streamAudioId = clip;
  cleanups.push(() => speech.stop());
  const lines: string[] = [];
  const dictations = new Dictations({ socket: speech.path, store: "gluck", log: (l) => lines.push(l), ...(now ? { now } : {}) });
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => fake.dial,
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    log: (l) => lines.push(l),
    dictations,
    ...stt({ socket: speech.path, store: "gluck", dictations }),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, speech, port: typeof addr === "object" && addr ? addr.port : 0, lines };
}

function open(url: string): Promise<{ ws: WebSocket; got: Record<string, unknown>[] }> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers });
    const got: Record<string, unknown>[] = [];
    ws.on("message", (d, binary) => !binary && got.push(JSON.parse(d.toString()) as Record<string, unknown>));
    ws.once("open", () => ok({ ws, got }));
    ws.once("error", fail);
    cleanups.push(() => ws.terminate());
  });
}

async function dictate(port: number, session: string): Promise<void> {
  const s = await open(`ws://127.0.0.1:${port}/stt/stream?aria=${encodeURIComponent(`gluck/${id}`)}&session=${session}`);
  await until("ready", () => s.got.some((f) => f.type === "ready"));
  for (let i = 0; i < 3; i++) s.ws.send(fakePcm(1280), { binary: true });
  s.ws.send(JSON.stringify({ type: "end" }));
  await until("done", () => s.got.some((f) => f.type === "done"));
}

async function send(port: number, session: string): Promise<void> {
  const p = await open(`ws://127.0.0.1:${port}/door?session=${session}`);
  p.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
  p.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.qua", params: { figaro_id: id, text: "what I said" } }));
  await until("qua answer", () => p.got.some((f) => f.id === 2));
}

function get(port: number, path: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", path, agent: false, headers: { ...headers, range: "bytes=0-1" } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("dictation audio", () => {
  it("keys a streamed dictation's clip to the turn its page's next qua opens, so /in plays", async () => {
    const { fake, speech, port, lines } = await rig();
    await dictate(port, sa);
    await send(port, sa);
    fake.openTurn(id, 5, "what I said");
    await until("the clip keyed", () => speech.attached.length === 1);
    expect(speech.attached).toEqual([{ audioId: clip, key: `gluck/${id}:5/in` }]);
    expect(lines).toContain(`dictation keyed audio_id=${clip} key=gluck/${id}:5/in session=${sa}`);
    expect(await get(port, `/audio/key/gluck/${id}%3A5/in`)).toBe(200);
    expect(speech.replays.at(-1)).toMatchObject({ url: `/audio/key/gluck/${id}:5/in`, range: "bytes=0-1" });
  });

  it("keys nothing for another page's qua, a qua with no dictation, or a dictation past its time", async () => {
    let now = 1_000_000;
    const { fake, speech, port } = await rig(() => now);
    await send(port, sa);
    fake.openTurn(id, 1, "typed");
    await dictate(port, sa);
    await send(port, sb);
    fake.openTurn(id, 2, "someone else");
    now += 11 * 60_000;
    await send(port, sa);
    fake.openTurn(id, 3, "late");
    await tick(100);
    expect(speech.attached).toEqual([]);
  });

  it("serves /in and /out keys and still refuses anything else", async () => {
    const { port } = await rig();
    expect(await get(port, `/audio/key/gluck/${id}:7/in`)).toBe(200);
    expect(await get(port, `/audio/key/gluck/${id}:7/out`)).toBe(200);
    expect(await get(port, `/audio/key/gluck/${id}:7/other`)).toBe(400);
    expect(await get(port, `/audio/key/elsewhere/${id}:7/in`)).toBe(404);
  });
});
