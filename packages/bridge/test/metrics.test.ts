import { createServer } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { Faults } from "../src/faults.js";
import { startGateway } from "../src/gateway.js";
import { bounds, otlpMetrics, Recorder, type Attrs, type Metrics } from "../src/metrics.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const sa = "Ab3_x-9ZqQ1w2E4r";
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

class Seen implements Metrics {
  readonly points: { name: string; value: number; attrs: Attrs; type: "ms" | "count" }[] = [];
  ms(name: string, value: number, attrs: Attrs): void {
    this.points.push({ name, value, attrs, type: "ms" });
  }
  count(name: string, attrs: Attrs, n = 1): void {
    this.points.push({ name, value: n, attrs, type: "count" });
  }
  named(n: string): { value: number; attrs: Attrs }[] {
    return this.points.filter((p) => p.name === n);
  }
}

function open(url: string): Promise<{ ws: WebSocket; text: string[] }> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers });
    const text: string[] = [];
    ws.on("message", (d: Buffer, binary) => !binary && text.push(d.toString()));
    ws.once("open", () => ok({ ws, text }));
    ws.once("error", fail);
    cleanups.push(() => ws.terminate());
  });
}

describe("gateway metrics", () => {
  it("measures dials, first frame, first token, first audio byte, handovers, reconnects and refusals, by session", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const seen = new Seen();
    const faults = new Faults();
    const gw = await startGateway({
      listen: { port: 0 },
      edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
      upstream: () => fake.dial,
      speech: speechOverSocket(speech.path),
      speechSocket: speech.path,
      store: "gluck",
      log: () => {},
      metrics: seen,
      faults,
    });
    cleanups.push(() => gw.close());
    const addr = gw.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const audio = await open(`ws://127.0.0.1:${port}/audio/${id}?session=${sa}`);
    await until("ready", () => audio.text.some((t) => t.includes('"ready"')));
    const page = await open(`ws://127.0.0.1:${port}/rpc?session=${sa}`);
    page.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.follow", params: { figaro_id: id } }));
    page.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.qua", params: { figaro_id: id, text: "hi" } }));
    page.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "figaro.kill", params: {} }));
    await until("three answers", () => page.text.length >= 3);
    await tick(30);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. Rest")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("audio end", () => audio.text.some((t) => t.includes('"audio.end"')));
    faults.apply({ op: "upstream.bearer", ms: 60_000 });
    faults.apply({ op: "upstream.lapse", notice: true, session: sa });
    await until("a handover", () => seen.named("figchat.gateway.handover_ms").length === 1);
    page.ws.close();
    await tick(50);
    await open(`ws://127.0.0.1:${port}/rpc?session=${sa}`);
    await until("reconnect", () => seen.named("figchat.gateway.reconnects").length === 1);

    const dials = seen.named("figchat.gateway.upstream.dial_ms").map((p) => p.attrs.kind).sort();
    expect(dials).toEqual(["audio", "handover", "page", "page"]);
    expect(seen.named("figchat.gateway.upstream.first_frame_ms")[0]!.attrs).toEqual({ "figchat.session": sa });
    const tok = seen.named("figchat.gateway.turn.first_token_ms");
    expect(tok).toHaveLength(1);
    expect(tok[0]!.attrs).toEqual({ "figchat.session": sa, "figaro.aria": id });
    expect(seen.named("figchat.gateway.audio.first_byte_ms")[0]!.attrs).toEqual({ "figchat.session": sa, "figaro.aria": id });
    expect(seen.named("figchat.gateway.handover_ms")[0]!.attrs).toEqual({ "figchat.session": sa, kind: "lapse_notice", outcome: "ok" });
    expect(seen.named("figchat.gateway.reconnects")[0]!.attrs).toEqual({ "figchat.session": sa, kind: "page" });
    expect(seen.named("figchat.gateway.errors").map((p) => p.attrs.kind)).toEqual(["refused"]);
    for (const p of seen.points) for (const k of Object.keys(p.attrs)) expect(["figchat.session", "figaro.aria", "kind", "outcome"]).toContain(k);
  }, 15_000);

  it("aggregates delta histograms and sums per name and attributes, and posts OTLP JSON to /v1/metrics", async () => {
    const r = new Recorder();
    r.ms("figchat.gateway.upstream.dial_ms", 3, { kind: "page" });
    r.ms("figchat.gateway.upstream.dial_ms", 300, { kind: "page" });
    r.ms("figchat.gateway.upstream.dial_ms", 40_000, { kind: "audio" });
    r.count("figchat.gateway.errors", { kind: "refused" });
    r.count("figchat.gateway.errors", { kind: "refused" }, 2);
    const body = JSON.parse(r.drain("figaro-gateway", 2_000_000)!) as { resourceMetrics: { scopeMetrics: { metrics: Record<string, unknown>[] }[] }[] };
    const ms = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    expect(ms.map((m) => m.name)).toEqual(["figchat.gateway.upstream.dial_ms", "figchat.gateway.upstream.dial_ms", "figchat.gateway.errors"]);
    const page = (ms[0] as { histogram: { aggregationTemporality: number; dataPoints: { count: string; sum: number; bucketCounts: string[]; explicitBounds: number[] }[] } }).histogram;
    expect(page.aggregationTemporality).toBe(1);
    expect(page.dataPoints[0]).toMatchObject({ count: "2", sum: 303, explicitBounds: bounds });
    expect(page.dataPoints[0]!.bucketCounts[0]).toBe("1");
    expect(page.dataPoints[0]!.bucketCounts[6]).toBe("1");
    expect((ms[1] as { histogram: { dataPoints: { bucketCounts: string[] }[] } }).histogram.dataPoints[0]!.bucketCounts[bounds.length]).toBe("1");
    expect((ms[2] as { sum: { isMonotonic: boolean; dataPoints: { asInt: string }[] } }).sum).toMatchObject({ isMonotonic: true, dataPoints: [{ asInt: "3" }] });
    expect(r.drain("figaro-gateway")).toBeUndefined();

    const posts: { path: string; body: string }[] = [];
    const collector = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        posts.push({ path: req.url ?? "", body: b });
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((ok) => collector.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise<void>((ok) => collector.close(() => ok())));
    const addr = collector.address();
    const ex = otlpMetrics({ endpoint: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, service: "figaro-gateway", log: () => {}, everyMs: 60_000 });
    ex.metrics.ms("figchat.gateway.handover_ms", 250, { kind: "deadline" });
    await ex.close();
    expect(posts.map((p) => p.path)).toEqual(["/v1/metrics"]);
    expect(posts[0]!.body).toContain('"figchat.gateway.handover_ms"');
    expect(posts[0]!.body).toContain('"service.name","value":{"stringValue":"figaro-gateway"}');
  });
});
