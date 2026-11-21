import WebSocket from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../../figaro-forms/test/aria/fake-aria.js";
import { startGateway } from "../../src/gateway.js";
import { speechOverSocket } from "../../src/speech.js";
import { startFakeSpeech } from "../fake-speech.js";

const figaros = Number(process.env.LOAD_FIGAROS ?? 2_000);
const turns = Number(process.env.LOAD_TURNS ?? 10_000);
const deltas = Number(process.env.LOAD_DELTAS ?? 200);
const pages = Number(process.env.LOAD_PAGES ?? 10);
const long = "f".repeat(32);
const secret = "s".repeat(40);
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;

class Page {
  readonly got: { at: number; size: number; j: { id?: number; method?: string } }[] = [];
  private n = 0;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d: Buffer) => this.got.push({ at: performance.now(), size: d.length, j: JSON.parse(d.toString()) as { id?: number; method?: string } }));
  }
  static open(port: number): Promise<Page> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers, perMessageDeflate: process.env.LOAD_DEFLATE !== "0", maxPayload: 256 << 20 });
      const p = new Page(ws);
      ws.once("open", () => ok(p));
      ws.once("error", fail);
      cleanups.push(() => ws.terminate());
    });
  }
  async call(method: string, params: Record<string, unknown>): Promise<{ ms: number; bytes: number }> {
    const id = ++this.n;
    const t = performance.now();
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    while (!this.got.some((g) => g.j.id === id && g.j.method === undefined)) await tick(1);
    const g = this.got.find((x) => x.j.id === id && x.j.method === undefined)!;
    return { ms: g.at - t, bytes: g.size };
  }
}

describe(`load: ${figaros} figaros, a ${turns}-turn aria, ${pages} pages, ${deltas} deltas a turn`, () => {
  it("paints and streams through /door; reports latency, bytes and memory", async () => {
    const fake = new FakeAria();
    fake.pageNodes = 200;
    for (let i = 0; i < figaros; i++) fake.rows.push({ id: i.toString(16).padStart(32, "0"), mantra: `mantra ${i}`, state: "dormant", message_count: i % 300 } as never);
    fake.addAria(long);
    for (let t = 1; t <= turns; t++) fake.finishedTurn(long, t, `question ${t}`, [{ type: "prose", role: "output", markdown: `answer ${t} `.repeat(20) } as never]);
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const gw = await startGateway({ listen: { port: 0 }, edge: { secret, admin: "gluck", peers: ["127.0.0.1"] }, door: () => fake.dial, speech: speechOverSocket(speech.path), speechSocket: speech.path, store: "gluck", log: () => {}, maxFrameBytes: 256 << 20 });
    cleanups.push(() => gw.close());
    const addr = gw.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const before = process.memoryUsage().rss;
    const t0 = performance.now();
    const all = await Promise.all(Array.from({ length: pages }, () => Page.open(port)));
    const lat: Record<string, number[]> = { list: [], roster: [], tail: [], follow: [] };
    const bytes: Record<string, number> = {};
    await Promise.all(
      all.map(async (p) => {
        for (const [k, m, params] of [["list", "figaro.list", {}], ["roster", "figaro.list", { limit: 8 }], ["tail", "figaro.read", { figaro_id: long, backward: true }], ["follow", "figaro.follow", { figaro_id: long }]] as const) {
          const r = await p.call(m, params);
          lat[k]!.push(r.ms);
          bytes[k] = r.bytes;
        }
      }),
    );
    const paint = performance.now() - t0;
    fake.openTurn(long, turns + 1, "stream");
    const s0 = performance.now();
    for (let d = 0; d < deltas; d++) fake.update(long, turns + 1, [{ id: 0, ...(d === 0 ? { set: { type: "prose", role: "output", markdown: "" } } : {}), patch: { markdown: { at: d * 5, del: 0, ins: "word " } } }]);
    fake.seal(long, turns + 1);
    await Promise.all(all.map(async (p) => {
      while (!p.got.some((g) => g.j.method === "figaro.aria" && JSON.stringify(g.j).includes('"sealed":true'))) await tick(2);
    }));
    const stream = performance.now() - s0;
    const after = process.memoryUsage().rss;
    const lines = [
      `pages ${pages}, paint all in ${paint.toFixed(0)} ms, stream of ${deltas} deltas to all in ${stream.toFixed(0)} ms`,
      ...Object.entries(lat).map(([k, xs]) => `${k}: p50 ${pct(xs, 0.5).toFixed(1)} ms, p95 ${pct(xs, 0.95).toFixed(1)} ms, reply ${bytes[k]} B`),
      `process rss ${mb(before)} -> ${mb(after)} (fake door and gateway in one process)`,
    ];
    console.log(lines.join("\n"));
    expect(lat.list!.length).toBe(pages);
  });
});
