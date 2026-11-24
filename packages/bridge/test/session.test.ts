import { request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { noSession, sessionList, sessionOf, withSession } from "../src/session.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { stt } from "../src/stt.js";
import { startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const good = { "x-figaro-edge": secret, "remote-user": "gluck" };
const sa = "Ab3_x-9ZqQ1w2E4r";
const sb = "Zz9_y-8YpP0v1D3q";
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

async function rig(): Promise<{ fake: FakeAria; speech: FakeSpeech; port: number; dials: { user: string; session: string }[]; lines: string[] }> {
  const fake = new FakeAria();
  fake.addAria(id);
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const dials: { user: string; session: string }[] = [];
  const lines: string[] = [];
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    upstream: (user, session) => {
      dials.push({ user, session });
      return fake.dial;
    },
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    ...stt({ socket: speech.path, store: "gluck", log: (l) => lines.push(l) }),
    log: (l) => lines.push(l),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, speech, port: typeof addr === "object" && addr ? addr.port : 0, dials, lines };
}

function open(url: string, headers: Record<string, string> = good): Promise<{ ws: WebSocket; got: Record<string, unknown>[] }> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers });
    const got: Record<string, unknown>[] = [];
    ws.on("message", (d, binary) => {
      if (!binary) got.push(JSON.parse(d.toString()) as Record<string, unknown>);
    });
    ws.once("open", () => ok({ ws, got }));
    ws.once("error", fail);
    cleanups.push(() => ws.terminate());
  });
}

function http(port: number, method: string, path: string, headers: Record<string, string>, body = Buffer.alloc(0)): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", method, path, headers: { ...good, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(body);
  });
}

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("clip")]);

describe("session id parsing", () => {
  const req = (headers: Record<string, string>, url = "/rpc"): { headers: Record<string, string>; url: string } => ({ headers, url });

  it("takes the header, and the session query only on an upgrade", () => {
    expect(sessionOf(req({ "x-figchat-session": sa }), false)).toBe(sa);
    expect(sessionOf(req({}, `/rpc?session=${sa}`), true)).toBe(sa);
    expect(sessionOf(req({}, `/stt?session=${sa}`), false)).toBe(noSession);
    expect(sessionOf(req({ "x-figchat-session": sa }, `/rpc?session=${sb}`), true)).toBe(sa);
  });

  it("gives '-' for a missing or ill-formed id, and a bad header does not fall back to the query", () => {
    for (const bad of ["", "short", "x".repeat(65), "has space ok ok", "a,bcdefghij", "a=b;c=d1234"]) {
      expect(sessionOf(req({ "x-figchat-session": bad }, `/rpc?session=${sa}`), true)).toBe(noSession);
    }
    expect(sessionOf(req({}), true)).toBe(noSession);
  });

  it("lists listening sessions deduped, in first-seen order, without '-', at most 8", () => {
    expect(sessionList([sb, undefined, sa, noSession, sb])).toEqual([sb, sa]);
    const many = Array.from({ length: 10 }, (_, i) => `session-${String(i).padStart(2, "0")}`);
    expect(sessionList(many)).toEqual(many.slice(0, 8));
  });

  it("adds the header to the upstream credential, keeping its own, and leaves it untouched without a session", async () => {
    const base = { name: "bearer", upgrade: () => ({ headers: { Authorization: "Bearer t" } }) };
    expect(withSession(base, noSession)).toBe(base);
    expect(withSession(undefined, noSession)).toBeUndefined();
    expect((await withSession(base, sa)!.upgrade()).headers).toEqual({ Authorization: "Bearer t", "X-Figchat-Session": sa });
    expect((await withSession(undefined, sa)!.upgrade()).headers).toEqual({ "X-Figchat-Session": sa });
  });
});

describe("session ids through the gateway", () => {
  it("dials the upstream with the page's session and logs each call by method, aria and session, never params or pushes", async () => {
    const { fake, port, dials, lines } = await rig();
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    const { ws, got } = await open(`ws://127.0.0.1:${port}/rpc?session=${sa}`);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    await until("follow answer", () => got.some((f) => f.id === 1));
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "pushed words")]);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.qua", params: { figaro_id: id, text: "private words" } }));
    await until("qua answer", () => got.some((f) => f.id === 2));
    expect(dials).toEqual([{ user: "gluck", session: sa }]);
    const upstreamLines = lines.filter((l) => l.startsWith("upstream: "));
    expect(upstreamLines).toEqual([`upstream: call method=figaro.follow aria=${id} session=${sa}`, `upstream: call method=figaro.qua aria=${id} session=${sa}`]);
    const all = lines.join("\n");
    expect(all).not.toContain("private words");
    expect(all).not.toContain("figaro.aria");
  });

  it("treats a bad or missing session as '-' and changes nothing else", async () => {
    for (const headers of [good, { ...good, "x-figchat-session": "no good!" }]) {
      const { fake, port, dials, lines } = await rig();
      fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
      const { ws, got } = await open(`ws://127.0.0.1:${port}/rpc`, headers);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, text: "x" } }));
      await until("qua answer", () => got.some((f) => f.id === 1));
      expect(got.find((f) => f.id === 1)).toMatchObject({ result: { ok: true } });
      expect(dials).toEqual([{ user: "gluck", session: noSession }]);
      expect(lines).toContain(`upstream: call method=figaro.qua aria=${id} session=-`);
    }
  });

  it("names every listening session on the speech socket and on each audio line, deduped", async () => {
    const { fake, speech, port, lines } = await rig();
    const a = await open(`ws://127.0.0.1:${port}/audio/${id}?session=${sa}`);
    await until("ready a", () => a.got.some((f) => f.type === "ready"));
    const b = await open(`ws://127.0.0.1:${port}/audio/${id}`, { ...good, "x-figchat-session": sb });
    await until("ready b", () => b.got.some((f) => f.type === "ready"));
    const again = await open(`ws://127.0.0.1:${port}/audio/${id}?session=${sa}`);
    await until("ready again", () => again.got.some((f) => f.type === "ready"));
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => a.got.some((f) => f.type === "audio.end"));
    expect(speech.calls.map((c) => c.session)).toEqual([`${sa},${sb}`]);
    expect(lines.find((l) => l.startsWith("tts open"))).toMatch(new RegExp(` session=${sa},${sb}$`));
    expect(lines.find((l) => l.startsWith("tts done"))).toMatch(new RegExp(` session=${sa},${sb}$`));
    expect(lines.filter((l) => l.startsWith("audio: connect")).map((l) => l.split(" session=")[1])).toEqual([sa, sb, sa]);
  });

  it("opens speech without the header when no listener has a session", async () => {
    const { fake, speech, port } = await rig();
    const a = await open(`ws://127.0.0.1:${port}/audio/${id}`);
    await until("ready", () => a.got.some((f) => f.type === "ready"));
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => a.got.some((f) => f.type === "audio.end"));
    expect(speech.calls.map((c) => c.session)).toEqual([undefined]);
  });

  it("passes the session to speech on dictation, re-transcription and replay, and logs each request with it", async () => {
    const { speech, port, lines } = await rig();
    const h = { "x-figchat-session": sa };
    expect(await http(port, "POST", `/stt?aria=gluck/${id}`, { ...h, "content-type": "audio/webm" }, webm)).toBe(200);
    speech.keyed[`gluck/${id}:3/in`] = "202611-0123456789abcdef";
    expect(await http(port, "POST", `/stt/key/${encodeURIComponent(`gluck/${id}:3/in`)}`, h)).toBe(200);
    expect(await http(port, "GET", `/audio/key/gluck/${id}:1/out`, h)).toBe(200);
    expect(speech.clips.map((c) => c.session)).toEqual([sa, sa]);
    expect(speech.lookups).toEqual([sa]);
    expect(speech.replays.map((r) => r.session)).toEqual([sa]);
    await until("three request lines", () => lines.filter((l) => l.startsWith("http ")).length === 3);
    for (const l of lines.filter((x) => x.startsWith("http "))) expect(l).toMatch(new RegExp(`^http (POST|GET) /\\S+ 200 \\d+ ms session=${sa}$`));
  });

  it("sends no session header to speech for a request without one", async () => {
    const { speech, port, lines } = await rig();
    expect(await http(port, "POST", `/stt?aria=gluck/${id}&session=${sa}`, { "content-type": "audio/webm" }, webm)).toBe(200);
    expect(speech.clips.map((c) => c.session)).toEqual([undefined]);
    await until("request line", () => lines.some((l) => l.startsWith("http POST /stt 200")));
    expect(lines.find((l) => l.startsWith("http POST /stt"))).toMatch(/ session=-$/);
  });

  it("passes the session of a dictation stream to speech as a header, not the query, and on its log line", async () => {
    const { speech, port, lines } = await rig();
    const c = await open(`ws://127.0.0.1:${port}/stt/stream?aria=${encodeURIComponent(`gluck/${id}`)}&session=${sa}`);
    await until("speech dialed", () => speech.streams.length === 1);
    c.ws.send(JSON.stringify({ type: "cancel" }));
    await until("stream line", () => lines.some((l) => l.startsWith("stt stream:")));
    expect(speech.streams[0]?.session).toBe(sa);
    expect(speech.streams[0]?.url).not.toContain("session");
    expect(lines.find((l) => l.startsWith("stt stream:"))).toMatch(new RegExp(` session=${sa}$`));
  });
});
