import { mkdtempSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
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

async function rig(listen?: Parameters<typeof startGateway>[0]["listen"], extra: Partial<Parameters<typeof startGateway>[0]> = {}): Promise<{ fake: FakeAria; speech: FakeSpeech; gw: Gateway; port: number; users: string[] }> {
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
    ...extra,
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

describe("figaro gateway", () => {
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

  it("refuses methods outside the gateway set", async () => {
    const { port } = await rig();
    const ws = await open(`ws://127.0.0.1:${port}/door`);
    const got = collect(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "figaro.form.create", params: {} }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "figaro.kill", params: {} }));
    await until("both answers", () => got.length === 2);
    expect(got.map((g) => (g as { id: number }).id)).toEqual([7, 8]);
    expect(JSON.stringify(got[0])).toContain("not allowed");
  });

  it("refuses a qua or fork that carries a form patch, outfits, seat, studies or abdication, naming the field", async () => {
    const { fake, port } = await rig();
    const ws = await open(`ws://127.0.0.1:${port}/door`);
    const got = collect(ws);
    const cases: [string, Record<string, unknown>, string][] = [
      ["figaro.qua", { figaro_id: id, text: "x", form: { patch: { set: {} } } }, "form"],
      ["figaro.qua", { figaro_id: id, text: "x", form: { context: { a: 1 } } }, "form"],
      ["figaro.qua", { figaro_id: id, text: "x", form: { outfits: ["o"] } }, "form"],
      ["figaro.fork", { figaro_id: id, patch: { set: {} } }, "patch"],
      ["figaro.fork", { figaro_id: id, seat: "@role" }, "seat"],
      ["figaro.fork", { figaro_id: id, abdicates: true }, "abdicates"],
      ["figaro.fork", { figaro_id: id, outfits: ["o"] }, "outfits"],
      ["figaro.fork", { figaro_id: id, studies: "all" }, "studies"],
    ];
    cases.forEach(([method, params], i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method, params })));
    await until("every refusal", () => got.length === cases.length);
    cases.forEach(([method, , field], i) => {
      const reply = got.find((g) => (g as { id: number }).id === 100 + i) as { error?: { message: string } };
      expect(reply.error?.message, `${method} ${field}`).toContain(`may not carry ${field}`);
    });
    expect(fake.calls.map((c) => c.method)).not.toContain("figaro.qua");
    expect(fake.calls.map((c) => c.method)).not.toContain("figaro.fork");
  });

  it("passes create naming outfits, outfit spec lookups and a plain set, and refuses every other field, naming it", async () => {
    const { fake, port } = await rig();
    fake.answers.set("figaro.create", { figaro_id: "new" });
    fake.answers.set("angelus.outfits", { outfits: [] });
    const ws = await open(`ws://127.0.0.1:${port}/door`);
    const got = collect(ws);
    const calls: [string, Record<string, unknown>, string | undefined][] = [
      ["figaro.create", { outfits: ["mock"] }, undefined],
      ["figaro.create", {}, undefined],
      ["figaro.create", { outfits: ["mock"], patch: { object: {} } }, "patch"],
      ["figaro.create", { cwd: "/tmp" }, "cwd"],
      ["angelus.outfits", { spec: "mock" }, undefined],
      ["angelus.outfits", { spec: "mock", fold: true }, "fold"],
      ["figaro.set", { figaro_id: id, patch: { object: {} }, client: "c", seq: 1 }, undefined],
      ["figaro.set", { figaro_id: id, patch: { object: {} }, outfits: ["o"] }, "outfits"],
      ["figaro.set", { figaro_id: id, patch: { object: {} }, assert: true }, "assert"],
      ["figaro.set", { figaro_id: id, patch: { object: {} }, if_version: 3 }, "if_version"],
    ];
    calls.forEach(([method, params], i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 200 + i, method, params })));
    await until("every answer", () => got.length === calls.length);
    calls.forEach(([method, , field], i) => {
      const reply = got.find((g) => (g as { id: number }).id === 200 + i) as { result?: unknown; error?: { message: string } };
      if (field === undefined) expect(reply.error?.message ?? "", method).not.toContain("gateway:");
      else expect(reply.error?.message, `${method} ${field}`).toContain(`may not carry ${field}`);
    });
    const reached = fake.calls.map((c) => c.method);
    expect(reached.filter((m) => m === "figaro.create")).toHaveLength(2);
    expect(reached.filter((m) => m === "angelus.outfits")).toHaveLength(1);
    expect(reached.filter((m) => m === "figaro.set")).toHaveLength(1);
  });

  it("still passes a plain qua with images and a fork at a turn", async () => {
    const { fake, port } = await rig();
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    fake.answers.set("figaro.fork", { parent: id, continuation: "c", alternative: "a" });
    const ws = await open(`ws://127.0.0.1:${port}/door`);
    const got = collect(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "angelus.hello", params: { version: 1 } }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.qua", params: { figaro_id: id, text: "x", images: [{ data: "AA==" }] } }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.fork", params: { figaro_id: id, at_turn: 2 } }));
    await until("answers", () => got.length === 3);
    expect(got.every((g) => "result" in (g as object))).toBe(true);
  });

  it("answers 400 to a request target or escape that cannot be parsed, and stays up", async () => {
    const { port } = await rig();
    const raw = (target: string): Promise<string> =>
      new Promise((ok) => {
        const s = connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nx-figaro-edge: ${secret}\r\nremote-user: gluck\r\nConnection: close\r\n\r\n`));
        let out = "";
        s.on("data", (d) => (out += d.toString()));
        s.on("close", () => ok(out.split("\r\n")[0] ?? ""));
      });
    expect(await raw("//")).toContain("400");
    expect(await raw("/audio/key/%E0%A4%A")).toContain("400");
    expect(await raw("/nothing")).toContain("404");
  });

  it("replays only keys of its own store", async () => {
    const { port } = await rig();
    const r = await fetch(`http://127.0.0.1:${port}/audio/key/${encodeURIComponent(`other/${id}:1/out`)}`, { headers: good });
    expect(r.status).toBe(404);
  });

  it("does not put the door's address in the close reason when the door is unreachable", async () => {
    const lines: string[] = [];
    const { port } = await rig(undefined, { door: () => async () => { throw new Error("could not open wss://user:pw@door.example/door?token=SECRET"); }, log: (l) => lines.push(l) });
    const ws = await open(`ws://127.0.0.1:${port}/door`);
    const closed = await new Promise<string>((ok) => ws.on("close", (_c, reason) => ok(reason.toString())));
    expect(closed).toBe("door unreachable");
    expect(lines.join("\n")).toContain("door.example");
    expect(lines.join("\n")).not.toMatch(/SECRET|pw@/);
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

  it("logs each step of an /audio follow without secrets or query strings", async () => {
    const lines: string[] = [];
    const { fake, port } = await rig(undefined, { log: (l) => lines.push(l) });
    const ws = await open(`ws://127.0.0.1:${port}/audio/${id}?token=hunter2`);
    const got = collect(ws);
    await until("ready", () => ofType(got, "ready").length === 1);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    await until("audio", () => got.some((f) => Buffer.isBuffer(f)));
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => ofType(got, "audio.end").length === 1);
    ws.close();
    await until("closed log", () => lines.some((l) => l.startsWith("audio: closed")));
    const text = lines.join("\n");
    expect(text).toContain(`audio: connect aria=${id} user=gluck`);
    expect(text).toContain(`audio: follow ready aria=${id}`);
    expect(text).toContain(`turn seen aria=${id} turn=1`);
    expect(text).toContain(`tts open aria=${id} turn=1 key=gluck/${id}:1/out`);
    expect(text).toMatch(/tts done aria=\w+ turn=1 chunks=\d+ bytes=\d+ audio_id=a-1/);
    expect(text).toMatch(/audio: closed aria=\w+ code=\d+ reason=.* json=\d+ binary=[1-9]/);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("token=");
  });

  it("logs and tells the client when the follow cannot start: unknown aria, refused follow", async () => {
    const lines: string[] = [];
    const { fake, port } = await rig(undefined, { log: (l) => lines.push(l) });
    const gone = "f".repeat(32);
    const a = await open(`ws://127.0.0.1:${port}/audio/${gone}`);
    await until("gone", () => ofType(collect(a), "error").length === 1);
    expect(ofType(collect(a), "error")[0]).toMatchObject({ code: "aria_gone" });
    expect(lines.join("\n")).toContain(`audio: follow failed aria=${gone} code=aria_gone`);

    const denied = "e".repeat(32);
    fake.addAria(denied);
    fake.refuseFollow.set(denied, { code: -32020, message: "user:gluck lacks listen on aria:e" });
    const b = await open(`ws://127.0.0.1:${port}/audio/${denied}`);
    await until("denied", () => ofType(collect(b), "error").length === 1);
    expect(ofType(collect(b), "error")[0]).toMatchObject({ code: "denied", text: expect.stringContaining("lacks listen") });
    expect(lines.join("\n")).toContain(`audio: follow failed aria=${denied} code=denied`);
    await until("closed", () => b.readyState === WebSocket.CLOSED);
  });

  it("refuses a store the gateway does not serve with an error frame, and accepts its own", async () => {
    const lines: string[] = [];
    const { port } = await rig(undefined, { log: (l) => lines.push(l) });
    const other = await open(`ws://127.0.0.1:${port}/audio/spain/${id}`);
    await until("error", () => ofType(collect(other), "error").length === 1);
    expect(ofType(collect(other), "error")[0]).toMatchObject({ code: "store" });
    await until("closed", () => other.readyState === WebSocket.CLOSED);
    expect(lines.join("\n")).toContain("store spain is not served here");
    const own = await open(`ws://127.0.0.1:${port}/audio/gluck/${id}`);
    await until("ready", () => ofType(collect(own), "ready").length === 1);
    expect(ofType(collect(own), "ready")[0]).toEqual({ type: "ready", aria: id, store: "gluck" });
  });

  it("answers a speech service that cannot be reached with a speech error frame and a log line", async () => {
    const lines: string[] = [];
    const { fake, port } = await rig(undefined, { log: (l) => lines.push(l), speech: speechOverSocket("/nonexistent/speech.sock") });
    const ws = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    const got = collect(ws);
    await until("ready", () => ofType(got, "ready").length === 1);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    await until("error", () => ofType(got, "error").length === 1);
    expect(ofType(got, "error")[0]).toMatchObject({ turn: 1, code: "speech" });
    expect(lines.join("\n")).toMatch(/tts error aria=\w+ turn=1/);
  });

  it("answers a speech dial that throws with a speech error frame", async () => {
    const lines: string[] = [];
    const { fake, port } = await rig(undefined, {
      log: (l) => lines.push(l),
      speech: () => {
        throw new Error("no speech for you");
      },
    });
    const ws = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    const got = collect(ws);
    await until("ready", () => ofType(got, "ready").length === 1);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    await until("error", () => ofType(got, "error").length === 1);
    expect(ofType(got, "error")[0]).toMatchObject({ turn: 1, code: "speech", text: "no speech for you" });
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

  it("hands unknown HTTP routes behind the gate to a seam, for speech in", async () => {
    const fake = new FakeAria();
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const seen: string[] = [];
    const gw = await startGateway({
      listen: { port: 0 },
      edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
      door: () => fake.dial,
      speech: speechOverSocket(speech.path),
      store: "gluck",
      routes: (req, res, path, user) => {
        if (path !== "/stt" || req.method !== "POST") return false;
        seen.push(user);
        res.writeHead(202).end();
        return true;
      },
    });
    cleanups.push(() => gw.close());
    const addr = gw.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const post = (path: string, headers: Record<string, string>): Promise<number> =>
      new Promise((ok) => {
        const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        });
        req.end();
      });
    expect(await post("/stt", good)).toBe(202);
    expect(await post("/stt", {})).toBe(403);
    expect(await post("/other", good)).toBe(404);
    expect(seen).toEqual(["gluck"]);
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

  it("says a finished turn over /audio to the asker only, and answers a stored key with audio.stored", async () => {
    const { fake, speech, port } = await rig();
    fake.finishedTurn(id, 1, "q", [{ type: "prose", role: "output", markdown: "Replay me." } as never]);
    fake.finishedTurn(id, 2, "q", [{ type: "prose", role: "output", markdown: "Kept." } as never]);
    const asker = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    const bystander = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    asker.send(JSON.stringify({ type: "say", turn: 1 }));
    await until("end", () => ofType(collect(asker), "audio.end").length === 1);
    expect(ofType(collect(asker), "audio.start")[0]).toMatchObject({ turn: 1, key: `gluck/${id}:1/out`, say: true });
    expect(collect(asker).some((f) => Buffer.isBuffer(f))).toBe(true);
    expect(collect(bystander).map((f) => (Buffer.isBuffer(f) ? "pcm" : f.type))).toEqual(["ready"]);
    speech.keyed[`gluck/${id}:2/out`] = "000001-0123456789abcdef";
    const calls = speech.calls.length;
    asker.send(JSON.stringify({ type: "say", turn: 2 }));
    await until("stored", () => ofType(collect(asker), "audio.stored").length === 1);
    expect(ofType(collect(asker), "audio.stored")[0]).toEqual({ type: "audio.stored", turn: 2, key: `gluck/${id}:2/out` });
    expect(speech.calls.length).toBe(calls);
  });

});
