import { mkdtempSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { webSocketDial } from "figaro-forms";
import { AriaClient } from "figaro-forms/aria";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { startGateway, type Gateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const prose = (n: number, markdown: string): { id: number; set: Record<string, string> } => ({ id: n, set: { type: "prose", role: "output", markdown } });
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

const good = { "x-figaro-edge": secret, "remote-user": "gluck" };

async function rig(listen?: Parameters<typeof startGateway>[0]["listen"]): Promise<{ fake: FakeAria; speech: FakeSpeech; gw: Gateway; port: number; users: string[] }> {
  const fake = new FakeAria();
  fake.addAria(id);
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const users: string[] = [];
  const gw = await startGateway({
    listen: listen ?? { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: (u) => {
      users.push(u);
      return fake.dial;
    },
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, speech, gw, port: typeof addr === "object" && addr ? addr.port : 0, users };
}

const inbox = new WeakMap<WebSocket, (Record<string, unknown> | Buffer)[]>();

function open(url: string, headers: Record<string, string> = good): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers });
    const got: (Record<string, unknown> | Buffer)[] = [];
    inbox.set(ws, got);
    ws.on("message", (d, binary) => got.push(binary ? (d as Buffer) : (JSON.parse(d.toString()) as Record<string, unknown>)));
    ws.once("open", () => ok(ws));
    ws.once("unexpected-response", (_r, res) => fail(new Error(`status ${res.statusCode}`)));
    ws.once("error", fail);
    cleanups.push(() => ws.terminate());
  });
}

const collect = (ws: WebSocket): (Record<string, unknown> | Buffer)[] => inbox.get(ws) ?? [];

const ofType = (got: (Record<string, unknown> | Buffer)[], t: string): Record<string, unknown>[] => got.filter((f): f is Record<string, unknown> => !Buffer.isBuffer(f) && f.type === t);

describe("figchat gateway", () => {
  it("refuses a request without the edge secret, from the wrong user, or from a foreign origin", async () => {
    const { port } = await rig();
    await expect(open(`ws://127.0.0.1:${port}/door`, { "remote-user": "gluck" })).rejects.toThrow("403");
    await expect(open(`ws://127.0.0.1:${port}/door`, { ...good, "remote-user": "mallory" })).rejects.toThrow("403");
    await expect(open(`ws://127.0.0.1:${port}/door`, { ...good, origin: "https://evil.example" })).rejects.toThrow("403");
    await expect(open(`ws://127.0.0.1:${port}/nowhere`)).rejects.toThrow("404");
    await expect(open(`ws://127.0.0.1:${port}/audio/not-an-id`)).rejects.toThrow("404");
    await expect(open(`ws://127.0.0.1:${port}/door`)).resolves.toBeDefined();
  });

  it("carries an AriaClient end to end through /door, one upstream per client, aria methods included", async () => {
    const { fake, port, users } = await rig();
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    const mk = (): AriaClient =>
      new AriaClient({
        dial: webSocketDial({
          url: `ws://127.0.0.1:${port}/door`,
          credential: { name: "edge", upgrade: () => ({ headers: good }) },
          WebSocket: WebSocket as never,
        }),
        retryMinMs: 5,
      });
    const a = mk();
    const b = mk();
    cleanups.push(() => a.close(), () => b.close());
    fake.finishedTurn(id, 1, "old", [{ type: "prose", role: "output", markdown: "Ciao." } as never]);
    const sa = a.attach(id);
    await sa.ready();
    await b.attach(id).ready();
    expect(fake.conns).toHaveLength(2);
    expect(users).toEqual(["gluck", "gluck"]);
    expect(sa.snapshot().view.closed).toHaveLength(1);
    await expect(sa.qua("ciao")).resolves.toMatchObject({ ok: true });
    expect(fake.calls.map((c) => c.method)).toContain("figaro.qua");
    fake.rows = [{ id } as never];
    expect((await a.list()).rows).toHaveLength(1);
  });

  it("refuses methods outside the aria set and writes", async () => {
    const { port } = await rig();
    const ws = await open(`ws://127.0.0.1:${port}/door`);
    const got = collect(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "figaro.set", params: {} }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "figaro.kill", params: {} }));
    await until("both answers", () => got.length === 2);
    expect(got.map((g) => (g as { id: number }).id)).toEqual([7, 8]);
    expect(JSON.stringify(got[0])).toContain("not allowed");
  });

  it("voices an aria over /audio: ready, then audio before the turn ends, then end with the replay key", async () => {
    const { fake, port } = await rig();
    const ws = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    const got = collect(ws);
    await until("ready", () => ofType(got, "ready").length === 1);
    expect(ofType(got, "ready")[0]).toEqual({ type: "ready", aria: id, store: "gluck" });
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    await until("audio", () => got.some((f) => Buffer.isBuffer(f)));
    expect(ofType(got, "audio.end")).toEqual([]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => ofType(got, "audio.end").length === 1);
    expect(ofType(got, "audio.end")[0]).toMatchObject({ turn: 1, key: `gluck/${id}:1/out`, audio_id: "a-1" });
  });

  it("cancels audio when the page interrupts through /door, and when the audio client asks", async () => {
    const { fake, port } = await rig();
    fake.answers.set("figaro.interrupt", { ok: true, stopped: true });
    const audio = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    const got = collect(audio);
    await until("ready", () => ofType(got, "ready").length === 1);
    const door = await open(`ws://127.0.0.1:${port}/door`);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Going on. And on")]);
    await until("audio", () => got.some((f) => Buffer.isBuffer(f)));
    door.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.interrupt", params: { figaro_id: id, queue: "keep" } }));
    await until("cancel", () => ofType(got, "audio.cancel").length === 1);
    expect(ofType(got, "audio.cancel")[0]).toMatchObject({ turn: 1, why: "interrupt" });

    fake.openTurn(id, 2, "again");
    fake.update(id, 2, [prose(0, "Second. thing")]);
    await until("second audio", () => ofType(got, "audio.start").length === 2);
    audio.send(JSON.stringify({ type: "cancel" }));
    await until("client cancel", () => ofType(got, "audio.cancel").length === 2);
    expect(ofType(got, "audio.cancel")[1]).toMatchObject({ turn: 2, why: "client" });
  });

  it("answers an unknown aria with an aria_gone error frame", async () => {
    const { port } = await rig();
    const ws = await open(`ws://127.0.0.1:${port}/audio/${"f".repeat(32)}`);
    const got = collect(ws);
    await until("error", () => ofType(got, "error").length === 1);
    expect(ofType(got, "error")[0]).toMatchObject({ code: "aria_gone" });
  });

  it("proxies GET /audio/key/{key} to the speech socket with Range, and refuses a malformed key", async () => {
    const { port, speech } = await rig();
    const get = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((ok) => {
        const req = request({ host: "127.0.0.1", port, path, headers: { ...good, range: "bytes=0-3" } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
        });
        req.end();
      });
    const key = `gluck/${id}:1/out`;
    expect(await get(`/audio/key/${key}`)).toEqual({ status: 200, body: "MP3DATA" });
    expect(speech.replays[0]).toEqual({ url: `/audio/key/${key}`, range: "bytes=0-3" });
    expect((await get(`/audio/key/not-a-key`)).status).toBe(400);
    expect(speech.replays).toHaveLength(1);
  });

  it("listens on a unix socket with the given mode", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ffg-")), "gateway.sock");
    const fake = new FakeAria();
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const gw = await startGateway({ listen: { path, mode: 0o660 }, edge: { secret, admin: "gluck" }, door: () => fake.dial, speech: speechOverSocket(speech.path), store: "gluck" });
    cleanups.push(() => gw.close());
    expect(statSync(path).mode & 0o777).toBe(0o660);
    const ws = await open(`ws+unix://${path}:/door`);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "angelus.hello", params: { version: 1 } }));
    const got = collect(ws);
    await until("hello", () => got.length === 1);
    expect(JSON.stringify(got[0])).toContain("principal");
  });
});
