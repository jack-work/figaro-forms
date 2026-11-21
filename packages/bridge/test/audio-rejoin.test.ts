import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const other = "fedcba9876543210fedcba9876543210";
const secret = "s".repeat(40);
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const prose = (n: number, markdown: string) => ({
  id: n,
  set: { type: "prose", role: "output", markdown },
});

function open(port: number, aria = id) {
  return new Promise<{ ws: WebSocket; got: Record<string, unknown>[] }>(
    (ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${aria}`, {
        headers,
      });
      const got: Record<string, unknown>[] = [];
      ws.on("message", (d, b) => !b && got.push(JSON.parse(d.toString())));
      ws.once("open", () => ok({ ws, got }));
      cleanups.push(() => ws.terminate());
    },
  );
}

describe("an audio listener that comes back mid-turn", () => {
  it("hears only what comes after it joins, and stores no partial reply under the turn's key", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const lines: string[] = [];
    const gw = await startGateway({
      listen: { port: 0 },
      edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
      door: () => fake.dial,
      speech: speechOverSocket(speech.path),
      speechSocket: speech.path,
      store: "gluck",
      log: (l) => lines.push(l),
    });
    cleanups.push(() => gw.close());
    const port = (gw.server.address() as { port: number }).port;
    fake.addAria(other);
    const keep = await open(port, other);
    await tick(100);
    fake.openTurn(id, 1, "q");
    fake.update(id, 1, [prose(0, "One. Two. ")]);
    const a = await open(port);
    await tick(200);
    fake.update(id, 1, [
      { id: 0, patch: { markdown: { at: 10, del: 0, ins: "Three. Four. " } } },
    ]);
    await tick(200);
    a.ws.close();
    await tick(10);
    const b = await open(port);
    await tick(200);
    fake.update(id, 1, [
      { id: 0, patch: { markdown: { at: 23, del: 0, ins: "Five. Six. " } } },
    ]);
    fake.seal(id, 1);
    fake.done(id);
    await tick(400);
    expect(
      speech.calls.map((c) => c.frames.map((f) => f.text).join("")),
    ).toEqual(["Three. Four. ", "Five. Six. "]);
    expect(
      speech.calls.map((c) =>
        new URL(c.url, "http://s").searchParams.get("key"),
      ),
    ).toEqual([null, null]);
    const start = b.got.find((f) => f.type === "audio.start");
    const end = b.got.find((f) => f.type === "audio.end");
    expect(start).toMatchObject({ turn: 1, partial: true, chars: 34 });
    expect(end).toMatchObject({ turn: 1, partial: true });
    expect(end).not.toHaveProperty("audio_id");
    expect(a.got.some((f) => f.type === "audio.chunk")).toBe(true);
    expect(keep.got.some((f) => f.type === "ready")).toBe(true);
  });
});
