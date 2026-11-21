import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { pcmFormat } from "../src/speech.js";
import { fakePcmFormat, pcmBytesPerMs, startFakeSpeech, type FakeSpeech, type PaceOptions } from "./fake-speech.js";

let fake: FakeSpeech | undefined;
afterEach(async () => { await fake?.stop(); fake = undefined; });

interface Arrival { at: number; bytes: number }

async function speak(pace: PaceOptions | undefined, ms: number): Promise<{ arrivals: Arrival[]; total: number; ended: number; start: number }> {
  fake = await startFakeSpeech();
  fake.pace = pace;
  fake.pcmPerText = Math.round(ms * pcmBytesPerMs);
  const ws = new WebSocket(`ws+unix://${fake.path}:/speak`);
  const arrivals: Arrival[] = [];
  let ended = 0;
  ws.on("message", (d, binary) => { if (binary) arrivals.push({ at: Date.now(), bytes: (d as Buffer).length }); else ended = Date.now(); });
  await new Promise<void>((ok) => ws.on("open", ok));
  const start = Date.now();
  ws.send(JSON.stringify({ text: "hello" }));
  ws.send(JSON.stringify({ end: true }));
  await new Promise<void>((ok) => ws.on("close", () => ok()));
  return { arrivals, total: arrivals.reduce((a, b) => a + b.bytes, 0), ended, start };
}

describe("paced fake speech", () => {
  it("uses the gateway pcm format", () => {
    expect(fakePcmFormat).toEqual({ rate: pcmFormat.rate, bits: pcmFormat.bits, channels: pcmFormat.channels });
  });

  it("is instant by default", async () => {
    const r = await speak(undefined, 600);
    expect(r.total).toBe(Math.round(600 * pcmBytesPerMs));
    expect(r.ended - r.start).toBeLessThan(200);
  });

  it("delivers pcm at playback rate", async () => {
    const r = await speak({ seed: 1 }, 600);
    expect(r.total).toBe(Math.round(600 * pcmBytesPerMs));
    const span = r.ended - r.start;
    expect(span).toBeGreaterThan(540);
    expect(span).toBeLessThan(800);
    const half = r.arrivals.filter((a) => a.at - r.start < 300).reduce((a, b) => a + b.bytes, 0) / pcmBytesPerMs;
    expect(half).toBeGreaterThan(220);
    expect(half).toBeLessThan(400);
  });

  it("holds the first byte for the slow start", async () => {
    const r = await speak({ seed: 1, slowStartMs: 400 }, 100);
    expect(r.arrivals[0]!.at - r.start).toBeGreaterThanOrEqual(380);
  });

  it("stalls and then resumes without skipping bytes", async () => {
    const r = await speak({ seed: 3, stallProbability: 1, stallMs: [150, 150], sliceMs: 100 }, 300);
    expect(fake!.paced[0]!.stalls.length).toBe(3);
    expect(r.total).toBe(Math.round(300 * pcmBytesPerMs));
    const gaps = r.arrivals.slice(1).map((a, i) => a.at - r.arrivals[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(230);
    expect(fake!.paced[0]!.sends.map((s) => s.offset)).toEqual([0, 100 * pcmBytesPerMs, 200 * pcmBytesPerMs]);
  });

  it("records the time its text source left it with nothing to play", async () => {
    fake = await startFakeSpeech();
    fake.pace = { seed: 1 };
    fake.pcmPerText = Math.round(40 * pcmBytesPerMs);
    const ws = new WebSocket(`ws+unix://${fake.path}:/speak`);
    await new Promise<void>((ok) => ws.on("open", ok));
    ws.send(JSON.stringify({ text: "one" }));
    await new Promise((ok) => setTimeout(ok, 200));
    ws.send(JSON.stringify({ text: "two" }));
    ws.send(JSON.stringify({ end: true }));
    await new Promise<void>((ok) => ws.on("close", () => ok()));
    const starves = fake.paced[0]!.starves;
    expect(starves.length).toBe(1);
    expect(starves[0]!.ms).toBeGreaterThan(100);
  });

  it("repeats a seed", async () => {
    const opts = { seed: 9, stallProbability: 0.5, stallMs: [10, 20] as [number, number], jitterMs: 5, sliceMs: 20 };
    await speak(opts, 400);
    const a = fake!.paced[0]!.stalls.map((s) => [s.offset, s.ms]);
    await fake!.stop();
    await speak(opts, 400);
    expect(fake!.paced[0]!.stalls.map((s) => [s.offset, s.ms])).toEqual(a);
  });

  it("keeps jitter inside its bound", async () => {
    const r = await speak({ seed: 5, jitterMs: 80 }, 400);
    expect(r.total).toBe(Math.round(400 * pcmBytesPerMs));
    for (const s of fake!.paced[0]!.sends) expect(s.at).toBeLessThan((s.offset / pcmBytesPerMs) + 80 + 60);
  });
});
