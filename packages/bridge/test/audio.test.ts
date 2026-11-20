import { afterEach, describe, expect, it } from "vitest";
import { AriaClient } from "../../figaro-forms/src/aria/index.js";
import { FakeAria, settle, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { AudioHub, audioKey, type AudioListener } from "../src/audio.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const prose = (n: number, markdown: string): { id: number; set: Record<string, string> } => ({ id: n, set: { type: "prose", role: "output", markdown } });
const more = (n: number, at: number, ins: string): { id: number; patch: Record<string, { at: number; del: number; ins: string }> } => ({ id: n, patch: { markdown: { at, del: 0, ins } } });

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

class Tap implements AudioListener {
  readonly frames: (Record<string, unknown> | Buffer)[] = [];
  json(f: Record<string, unknown>): void {
    this.frames.push(f);
  }
  binary(b: Buffer): void {
    this.frames.push(b);
  }
  types(): string[] {
    return this.frames.map((f) => (Buffer.isBuffer(f) ? "pcm" : String(f.type)));
  }
  of(type: string): Record<string, unknown>[] {
    return this.frames.filter((f): f is Record<string, unknown> => !Buffer.isBuffer(f) && f.type === type);
  }
}

async function rig(o: { voiceOf?: (aria: string) => Promise<string | undefined> } = {}): Promise<{ fake: FakeAria; speech: FakeSpeech; hub: AudioHub; tap: Tap }> {
  const fake = new FakeAria();
  fake.addAria(id);
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const hub = new AudioHub({
    connect: () => new AriaClient({ dial: fake.dial, retryMinMs: 5, releaseGraceMs: 0 }),
    speech: speechOverSocket(speech.path),
    store: "gluck",
    ...(o.voiceOf ? { voiceOf: o.voiceOf } : {}),
  });
  cleanups.push(() => hub.close());
  const tap = new Tap();
  await hub.join(id, tap);
  return { fake, speech, hub, tap };
}

describe("audio hub", () => {
  it("sends the first sentence to speech and the first audio frame out before the turn ends", async () => {
    const { fake, speech, tap } = await rig();
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Hello there. How are")]);
    await until("first audio", () => tap.of("audio.chunk").length > 0);
    expect(tap.types()).not.toContain("audio.end");
    expect(speech.calls[0]?.frames).toEqual([{ text: "Hello there. " }]);
    expect(speech.calls[0]?.url).toContain("key=gluck%2F0123456789abcdef0123456789abcdef%3A1%2Fout");
    expect(speech.calls[0]?.url).toContain("format=pcm");

    fake.update(id, 1, [more(0, 20, " you today?")]);
    fake.closeRound(id, 1);
    fake.seal(id, 1);
    fake.done(id);
    await until("audio end", () => tap.of("audio.end").length > 0);
    expect(speech.calls[0]?.frames).toEqual([{ text: "Hello there. " }, { text: "How are you today?" }, { end: true }]);
    expect(tap.of("audio.start")[0]).toMatchObject({ turn: 1, key: audioKey("gluck", id, 1), format: "pcm", rate: 24000, bits: 16, channels: 1, cursor: 0, node: 0, chars: 13 });
    expect(tap.of("audio.end")[0]).toEqual({ type: "audio.end", turn: 1, key: audioKey("gluck", id, 1), audio_id: "a-1" });
  });

  it("tags every pcm run with turn, node, cursor and a running byte offset, header then bytes", async () => {
    const { fake, tap } = await rig();
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "One. Two. Three")]);
    await until("audio", () => tap.of("audio.chunk").length > 0);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => tap.of("audio.end").length > 0);
    const chunks = tap.of("audio.chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    let offset = 0;
    for (const c of chunks) {
      expect(c).toMatchObject({ turn: 1, node: 0, offset });
      expect(typeof c.cursor).toBe("number");
      expect(typeof c.chars).toBe("number");
      offset += c.bytes as number;
    }
    for (let i = 0; i < tap.frames.length; i++) {
      const f = tap.frames[i];
      if (!Buffer.isBuffer(f) && f?.type === "audio.chunk") {
        const next = tap.frames[i + 1];
        expect(Buffer.isBuffer(next) && next.length === f.bytes).toBe(true);
      }
    }
  });

  it("speaks prose only: thinking, tools and steering never reach speech", async () => {
    const { fake, speech, tap } = await rig();
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [{ id: 0, set: { type: "thinking", markdown: "Secret musing. More. " } }]);
    fake.update(id, 1, [{ id: 1, set: { type: "tool", name: "bash", status: "running" } }]);
    fake.update(id, 1, [prose(2, "Spoken.")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => tap.of("audio.end").length > 0);
    expect(speech.calls[0]?.frames).toEqual([{ text: "Spoken." }, { end: true }]);
  });

  it("cancels pending audio when a new turn starts, and on an interrupt", async () => {
    const { fake, speech, hub, tap } = await rig();
    fake.openTurn(id, 1, "a");
    fake.update(id, 1, [prose(0, "Long answer. Still going")]);
    await until("audio", () => tap.of("audio.chunk").length > 0);
    fake.openTurn(id, 2, "b");
    await until("cancel", () => tap.of("audio.cancel").length > 0);
    expect(tap.of("audio.cancel")[0]).toMatchObject({ turn: 1, why: "new-turn" });
    await until("socket closed", () => speech.calls[0]?.closed === true);
    expect(tap.of("audio.end")).toEqual([]);

    fake.update(id, 2, [prose(0, "Second one. More")]);
    await until("second audio", () => speech.calls.length === 2 && tap.of("audio.start").length === 2);
    hub.cancel(id, "interrupt");
    expect(tap.of("audio.cancel")[1]).toMatchObject({ turn: 2, why: "interrupt" });
    await until("second closed", () => speech.calls[1]?.closed === true);
  });

  it("does not speak history, and speaks a turn already running only from the join point on", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    fake.finishedTurn(id, 1, "old", [{ type: "prose", role: "output", markdown: "Old reply." } as never]);
    fake.openTurn(id, 2, "running");
    fake.update(id, 2, [prose(0, "Midway. text")]);
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const hub = new AudioHub({ connect: () => new AriaClient({ dial: fake.dial }), speech: speechOverSocket(speech.path), store: "gluck" });
    cleanups.push(() => hub.close());
    const tap = new Tap();
    await hub.join(id, tap);
    await settle(30);
    await tick(30);
    expect(speech.calls).toEqual([]);
    expect(tap.frames).toEqual([]);
    fake.update(id, 2, [more(0, 12, " goes on. And on")]);
    fake.seal(id, 2);
    fake.done(id);
    await until("end", () => tap.of("audio.end").length > 0);
    expect(speech.calls).toHaveLength(1);
    expect(speech.calls[0]?.frames).toEqual([{ text: " goes on. " }, { text: "And on" }, { end: true }]);
    expect(tap.of("audio.start")[0]).toMatchObject({ turn: 2, key: audioKey("gluck", id, 2), node: 0 });
    expect(tap.of("audio.start")[0]?.chars as number).toBeGreaterThanOrEqual(22);
    expect(tap.of("audio.end")[0]).toMatchObject({ turn: 2, key: audioKey("gluck", id, 2) });
  });

  it("speaks what a running turn added while the stream was offline, from the re-read, and nothing twice", async () => {
    const { fake, speech, tap } = await rig();
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "First part. Second")]);
    await until("first audio", () => speech.calls[0]?.frames.length === 1);
    fake.drop();
    fake.update(id, 1, [more(0, 18, " part. Third part. ")], { drop: true });
    await until("the re-read to speak", () => (speech.calls[0]?.frames.length ?? 0) >= 2);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => tap.of("audio.end").length > 0);
    const said = (speech.calls[0]?.frames ?? []).map((f) => (typeof f.text === "string" ? f.text : "|")).join("");
    expect(said).toBe("First part. Second part. Third part. |");
    expect(speech.calls).toHaveLength(1);
  });

  it("speaks only output prose: a steering node and an input-role prose node are left alone", async () => {
    const { fake, speech, tap } = await rig();
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [{ id: 0, set: { type: "steering", role: "input", markdown: "Also this. " } }, { id: 1, set: { type: "prose", role: "input", markdown: "Not mine. " } }, prose(2, "Mine.")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => tap.of("audio.end").length > 0);
    expect(speech.calls[0]?.frames).toEqual([{ text: "Mine." }, { end: true }]);
  });

  it("shares one speech session per reply across listeners", async () => {
    const { fake, speech, hub, tap } = await rig();
    const second = new Tap();
    await hub.join(id, second);
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Same words. Again")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("both end", () => tap.of("audio.end").length > 0 && second.of("audio.end").length > 0);
    expect(speech.calls).toHaveLength(1);
    expect(second.types()).toEqual(tap.types());
  });

  it("asks speech for the aria's voice and retries without it when the voice is refused", async () => {
    const { fake, speech, tap } = await rig({ voiceOf: async () => "en-GB-RyanNeural" });
    speech.rejectVoice = true;
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Voiced. Maybe")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("end", () => tap.of("audio.end").length > 0);
    expect(speech.calls).toHaveLength(1);
    expect(speech.calls[0]?.url).not.toContain("voice=");
    expect(speech.calls[0]?.frames).toEqual([{ text: "Voiced. " }, { text: "Maybe" }, { end: true }]);
  });

  it("reports a speech failure as an error frame and no audio.end", async () => {
    const { fake, speech, tap } = await rig();
    speech.pcmPerText = 0;
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "Doomed. Text")]);
    await until("call", () => speech.calls.length === 1);
    await until("frame", () => speech.calls[0]!.frames.length > 0);
    speech.calls[0]!.socket.send(JSON.stringify({ error: "quota" }));
    await until("error", () => tap.of("error").length > 0);
    expect(tap.of("error")[0]).toEqual({ type: "error", turn: 1, code: "speech", text: "quota" });
    expect(tap.of("audio.end")).toEqual([]);
  });
});
