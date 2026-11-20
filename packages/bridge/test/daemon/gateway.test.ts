import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startDaemon, type Daemon } from "../../../figaro-forms/test/daemon/daemon.js";
import { startGateway, type Gateway } from "../../src/gateway.js";
import { speechOverSocket } from "../../src/speech.js";
import { startFakeSpeech, type FakeSpeech } from "../fake-speech.js";

const bin = process.env.FIGARO_BIN;
const secret = "s".repeat(40);
const good = { "x-figaro-edge": secret, "remote-user": "gluck" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!bin)("gateway against a disposable figaro daemon (FIGARO_BIN)", () => {
  let daemon: Daemon;
  let speech: FakeSpeech;
  let gw: Gateway;
  let port = 0;

  beforeAll(async () => {
    daemon = await startDaemon(bin as string);
    speech = await startFakeSpeech();
    gw = await startGateway({
      listen: { port: 0 },
      edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
      door: (user) => daemon.dial(user),
      speech: speechOverSocket(speech.path),
      speechSocket: speech.path,
      store: "gluck",
    });
    const a = gw.server.address();
    port = typeof a === "object" && a ? a.port : 0;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await speech?.stop();
    await daemon?.stop();
  }, 60_000);

  it("speaks a tool turn's prose, in order, while the turn runs, prompted through /door", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const audio = new WebSocket(`ws://127.0.0.1:${port}/audio/${id}`, { headers: good });
    const frames: (Record<string, unknown> | Buffer)[] = [];
    audio.on("message", (d, binary) => frames.push(binary ? (d as Buffer) : (JSON.parse(d.toString()) as Record<string, unknown>)));
    await until("ready", () => frames.some((f) => !Buffer.isBuffer(f) && f.type === "ready"));

    const door = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers: good });
    const replies: Record<string, unknown>[] = [];
    door.on("message", (d) => replies.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise<void>((ok) => door.once("open", () => ok()));
    door.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "angelus.hello", params: { version: 1 } }));
    await until("hello", () => replies.some((r) => r.id === 1));
    door.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "figaro.qua", params: { figaro_id: id, text: "[tool] run it" } }));
    await until("qua", () => replies.some((r) => r.id === 2));
    expect(replies.find((r) => r.id === 2)).toHaveProperty("result");

    await until("audio.end", () => frames.some((f) => !Buffer.isBuffer(f) && f.type === "audio.end"));
    const said = (speech.calls[0]?.frames ?? []).map((f) => (typeof f.text === "string" ? f.text : "end")).join("");
    expect(said).toBe("Let me look. \n\nThe tool said tool-ran-ok. Done.end");
    const start = frames.find((f) => !Buffer.isBuffer(f) && f.type === "audio.start") as Record<string, unknown>;
    expect(start).toMatchObject({ turn: 2, key: `gluck/${id}:2/out` });
    audio.close();
    door.close();
  });

  it("joined mid-turn, speaks from the join point on and not the words already said", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    daemon.figaro("send", "--id", id, "-f", "--", "[slow] go on");
    await sleep(2200);
    const audio = new WebSocket(`ws://127.0.0.1:${port}/audio/${id}`, { headers: good });
    const frames: (Record<string, unknown> | Buffer)[] = [];
    audio.on("message", (d, binary) => frames.push(binary ? (d as Buffer) : (JSON.parse(d.toString()) as Record<string, unknown>)));
    await until("ready", () => frames.some((f) => !Buffer.isBuffer(f) && f.type === "ready"));
    const before = speech.calls.length;
    await until("audio.end", () => frames.some((f) => !Buffer.isBuffer(f) && f.type === "audio.end"), 30_000);
    const said = (speech.calls[before]?.frames ?? []).map((f) => (typeof f.text === "string" ? f.text : "")).join("");
    expect(said.length).toBeGreaterThan(0);
    expect(said.startsWith("one two")).toBe(false);
    expect(said.endsWith("sixteen. ")).toBe(true);
    const end = frames.find((f) => !Buffer.isBuffer(f) && f.type === "audio.end") as Record<string, unknown>;
    expect(end).toMatchObject({ turn: 2, key: `gluck/${id}:2/out` });
    audio.close();
  }, 60_000);
});
