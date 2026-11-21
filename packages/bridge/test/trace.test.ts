import { createServer, request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { stt } from "../src/stt.js";
import { noTracer, otlpBody, otlpExporter, parseTraceparent, recordingTracer, type FinishedSpan, type Tracer } from "../src/trace.js";
import { startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const good = { "x-figaro-edge": secret, "remote-user": "gluck" };
const sa = "Ab3_x-9ZqQ1w2E4r";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const pageSpan = "00f067aa0ba902b7";
const tp = `00-${traceId}-${pageSpan}-01`;
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

async function rig(tracer: Tracer): Promise<{ fake: FakeAria; speech: FakeSpeech; port: number }> {
  const fake = new FakeAria();
  fake.addAria(id);
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => fake.dial,
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    ...stt({ socket: speech.path, store: "gluck" }),
    tracer,
    log: () => {},
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, speech, port: typeof addr === "object" && addr ? addr.port : 0 };
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

function post(port: number, path: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", method: "POST", path, headers: { ...good, ...headers } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(body);
  });
}

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("clip")]);

function recorder(): { tracer: Tracer; spans: FinishedSpan[] } {
  const spans: FinishedSpan[] = [];
  return { tracer: recordingTracer((s) => spans.push(s)), spans };
}

const quaParams = (fake: FakeAria): Record<string, unknown> | undefined => fake.calls.find((c) => c.method === "figaro.qua")?.params as Record<string, unknown> | undefined;

describe("traces through the gateway", () => {
  it("spans a door call under the page's trace and hands figaro its own span as the parent", async () => {
    const { tracer, spans } = recorder();
    const { fake, port } = await rig(tracer);
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    const { ws, got } = await open(`ws://127.0.0.1:${port}/door?session=${sa}`);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, text: "private words", traceparent: tp } }));
    await until("answer", () => got.some((f) => f.id === 1));
    await until("span", () => spans.length === 1);
    const sp = spans[0]!;
    expect(sp).toMatchObject({ name: "door figaro.qua", traceId, parentSpanId: pageSpan, error: undefined });
    expect(sp.attributes).toEqual({ "rpc.method": "figaro.qua", "figaro.aria": id, "figchat.session": sa });
    expect(JSON.stringify(sp.attributes) + sp.name).not.toContain("private words");
    expect(quaParams(fake)?.traceparent).toBe(`00-${traceId}-${sp.spanId}-01`);
  });

  it("refuses a traceparent that is not W3C, naming it, and passes the page's own through when not tracing", async () => {
    const { fake, port } = await rig(noTracer);
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    const { ws, got } = await open(`ws://127.0.0.1:${port}/door`);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, text: "x", traceparent: "00-nothex-00f067aa0ba902b7-01" } }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.qua", params: { figaro_id: id, text: "x", traceparent: tp } }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.fork", params: { figaro_id: id, traceparent: tp } }));
    await until("three answers", () => [1, 2, 3].every((n) => got.some((f) => f.id === n)));
    expect(JSON.stringify(got.find((f) => f.id === 1))).toContain("traceparent must be a W3C traceparent");
    expect(JSON.stringify(got.find((f) => f.id === 3))).toContain("may not carry traceparent");
    expect(fake.calls.filter((c) => c.method === "figaro.qua").map((c) => c.params.traceparent)).toEqual([tp]);
  });

  it("starts a trace for a qua without one when tracing, and none when not", async () => {
    for (const traced of [true, false]) {
      const { tracer, spans } = recorder();
      const { fake, port } = await rig(traced ? tracer : noTracer);
      fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
      const { ws, got } = await open(`ws://127.0.0.1:${port}/door`);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, text: "x" } }));
      await until("answer", () => got.some((f) => f.id === 1));
      const sent = quaParams(fake)?.traceparent;
      if (traced) {
        await until("span", () => spans.length === 1);
        expect(spans[0]!.parentSpanId).toBeUndefined();
        expect(sent).toBe(`00-${spans[0]!.traceId}-${spans[0]!.spanId}-01`);
      } else expect(sent).toBeUndefined();
    }
  });

  it("speaks a turn under the trace of the qua that started it, and tells speech", async () => {
    const { tracer, spans } = recorder();
    const { fake, speech, port } = await rig(tracer);
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    const audio = await open(`ws://127.0.0.1:${port}/audio/${id}?session=${sa}`);
    await until("ready", () => audio.got.some((f) => f.type === "ready"));
    const door = await open(`ws://127.0.0.1:${port}/door?session=${sa}`);
    door.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, text: "x", traceparent: tp } }));
    await until("answer", () => door.got.some((f) => f.id === 1));
    fake.openTurn(id, 1, "x");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => audio.got.some((f) => f.type === "audio.end"));
    await until("tts span", () => spans.some((s) => s.name === "tts"));
    const qua = spans.find((s) => s.name === "door figaro.qua")!;
    const tts = spans.find((s) => s.name === "tts")!;
    expect(tts).toMatchObject({ traceId, parentSpanId: qua.spanId });
    expect(tts.attributes).toMatchObject({ "figaro.aria": id, "tts.turn": 1, "figchat.session": sa });
    expect(speech.calls[0]?.traceparent).toBe(`00-${traceId}-${tts.spanId}-01`);
  });

  it("spans an HTTP request under the page's trace and passes its span to speech; drops a malformed traceparent", async () => {
    const { tracer, spans } = recorder();
    const { speech, port } = await rig(tracer);
    expect(await post(port, `/stt?aria=gluck/${id}`, { "content-type": "audio/webm", traceparent: tp, "x-figchat-session": sa }, webm)).toBe(200);
    expect(await post(port, `/stt?aria=gluck/${id}`, { "content-type": "audio/webm", traceparent: "junk" }, webm)).toBe(200);
    await until("two spans", () => spans.filter((s) => s.name === "http POST /stt").length === 2);
    const [first, second] = spans.filter((s) => s.name === "http POST /stt");
    expect(first).toMatchObject({ traceId, parentSpanId: pageSpan });
    expect(first!.attributes).toMatchObject({ "figchat.session": sa, "http.response.status_code": 200 });
    expect(speech.clips[0]?.traceparent).toBe(`00-${traceId}-${first!.spanId}-01`);
    expect(second!.parentSpanId).toBeUndefined();
    expect(speech.clips[1]?.traceparent).toBe(`00-${second!.traceId}-${second!.spanId}-01`);
  });

  it("passes no traceparent to speech without tracing unless the page sent a valid one", async () => {
    const { speech, port } = await rig(noTracer);
    expect(await post(port, `/stt?aria=gluck/${id}`, { "content-type": "audio/webm", traceparent: "junk" }, webm)).toBe(200);
    expect(await post(port, `/stt?aria=gluck/${id}`, { "content-type": "audio/webm", traceparent: tp }, webm)).toBe(200);
    expect(speech.clips.map((c) => c.traceparent)).toEqual([undefined, tp]);
  });
});

describe("OTLP export", () => {
  it("parses only real traceparents", () => {
    expect(parseTraceparent(tp)).toEqual({ traceId, spanId: pageSpan });
    for (const bad of ["", "junk", `01-${traceId}-${pageSpan}-01`, `00-${"0".repeat(32)}-${pageSpan}-01`, `00-${traceId}-${"0".repeat(16)}-01`, tp.toUpperCase()]) expect(parseTraceparent(bad)).toBeUndefined();
  });

  it("writes OTLP/HTTP JSON with typed attributes and an error status", () => {
    const body = JSON.parse(
      otlpBody("figaro-gateway", [
        { name: "door figaro.qua", traceId, spanId: "1111111111111111", parentSpanId: pageSpan, startNs: 1n, endNs: 2n, attributes: { s: "x", n: 3, b: true }, error: "door closed" },
      ]),
    ) as { resourceSpans: { resource: unknown; scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    expect(body.resourceSpans[0]!.resource).toEqual({ attributes: [{ key: "service.name", value: { stringValue: "figaro-gateway" } }] });
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]).toMatchObject({
      traceId,
      parentSpanId: pageSpan,
      startTimeUnixNano: "1",
      attributes: [
        { key: "s", value: { stringValue: "x" } },
        { key: "n", value: { intValue: "3" } },
        { key: "b", value: { boolValue: true } },
      ],
      status: { code: 2, message: "door closed" },
    });
  });

  it("posts batches to the collector, and logs an unreachable one once a minute", async () => {
    const bodies: string[] = [];
    const paths: string[] = [];
    const collector = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        bodies.push(b);
        paths.push(req.url ?? "");
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((ok) => collector.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise<void>((ok) => collector.close(() => ok())));
    const addr = collector.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const lines: string[] = [];
    const ex = otlpExporter({ endpoint: `http://127.0.0.1:${port}`, service: "figaro-gateway", log: (l) => lines.push(l), flushMs: 60_000 });
    ex.tracer.start("one", undefined).end();
    ex.tracer.start("two", tp).end();
    await ex.close();
    expect(paths).toEqual(["/v1/traces"]);
    expect(bodies[0]).toContain('"name":"one"');
    expect(bodies[0]).toContain('"name":"two"');
    expect(lines).toEqual([]);

    const dead = otlpExporter({ endpoint: "http://127.0.0.1:1", service: "figaro-gateway", log: (l) => lines.push(l), flushMs: 60_000 });
    dead.tracer.start("lost", undefined).end();
    await dead.flush();
    dead.tracer.start("lost again", undefined).end();
    await dead.close();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^traces: collector unreachable .*batch dropped/);
  });

  it("refuses an endpoint that is not http(s)", () => {
    expect(() => otlpExporter({ endpoint: "ftp://x", service: "s", log: () => {} })).toThrow("not an http(s) URL");
  });
});
