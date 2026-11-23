import { afterEach, describe, expect, it } from "vitest";
import { AriaClient } from "figaro-forms/aria";
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

  it("gives a listener that joins after the audio started its own audio.start before its first chunk", async () => {
    const { fake, hub, tap } = await rig();
    fake.openTurn(id, 1, "hi");
    fake.update(id, 1, [prose(0, "One. Two. ")]);
    await until("first audio", () => tap.of("audio.chunk").length > 0);
    const late = new Tap();
    await hub.join(id, late);
    fake.update(id, 1, [more(0, 10, "Three. Four. Five")]);
    fake.seal(id, 1);
    fake.done(id);
    await until("both end", () => tap.of("audio.end").length > 0 && late.of("audio.end").length > 0);
    expect(tap.of("audio.start")).toHaveLength(1);
    expect(late.of("audio.start")).toHaveLength(1);
    const types = late.types();
    expect(types[0]).toBe("audio.start");
    expect(types.at(-1)).toBe("audio.end");
    const start = late.of("audio.start")[0]!;
    const first = late.of("audio.chunk")[0]!;
    expect(start).toMatchObject({ turn: 1, node: first.node, chars: first.chars });
    expect(first.offset).toBe(0);
    expect(late.of("audio.chunk").length).toBeLessThan(tap.of("audio.chunk").length);
  });

  it("keeps no finished turns in the follower's transcript however many turns it speaks", async () => {
    let client: AriaClient | undefined;
    const fake = new FakeAria();
    fake.addAria(id);
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const hub = new AudioHub({
      connect: () => (client = new AriaClient({ dial: fake.dial, retryMinMs: 5, releaseGraceMs: 0 })),
      speech: speechOverSocket(speech.path),
      store: "gluck",
    });
    cleanups.push(() => hub.close());
    const tap = new Tap();
    await hub.join(id, tap);
    const long = "A sentence that takes some room. ".repeat(200);
    for (let t = 1; t <= 40; t++) {
      fake.openTurn(id, t, "q");
      fake.update(id, t, [prose(0, long)]);
      fake.seal(id, t);
      fake.done(id);
      await until(`turn ${t} ends`, () => tap.of("audio.end").length === t);
    }
    expect(client!.peek(id).transcript.count()).toBeLessThanOrEqual(1);
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

describe("say: replaying a finished turn to one listener", () => {
  const finished = (fake: FakeAria, turn: number, ...texts: string[]): void => {
    fake.finishedTurn(id, turn, "q", texts.map((markdown) => ({ type: "prose", role: "output", markdown }) as never));
  };
  const withKeyCheck = async (keyed: (key: string) => boolean = () => false): Promise<{ fake: FakeAria; speech: FakeSpeech; hub: AudioHub; tap: Tap; other: Tap }> => {
    const fake = new FakeAria();
    fake.addAria(id);
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    const hub = new AudioHub({
      connect: () => new AriaClient({ dial: fake.dial, retryMinMs: 5, releaseGraceMs: 0 }),
      speech: speechOverSocket(speech.path),
      store: "gluck",
      stored: async (key) => keyed(key),
    });
    cleanups.push(() => hub.close());
    const tap = new Tap();
    const other = new Tap();
    await hub.join(id, tap);
    await hub.join(id, other);
    return { fake, speech, hub, tap, other };
  };

  it("streams start, chunks and end to the asker only, under the live key", async () => {
    const { fake, speech, hub, tap, other } = await withKeyCheck();
    finished(fake, 3, "Hello there. How are you?", "Second node.");
    await hub.say(id, tap, 3);
    await until("end", () => tap.of("audio.end").length > 0);
    expect(tap.of("audio.start")[0]).toMatchObject({ turn: 3, key: audioKey("gluck", id, 3), say: true, format: "pcm" });
    expect(tap.of("audio.chunk").length).toBeGreaterThan(0);
    expect(tap.of("audio.end")[0]).toEqual({ type: "audio.end", turn: 3, key: audioKey("gluck", id, 3), audio_id: "a-1" });
    expect(other.frames).toEqual([]);
    expect(speech.calls[0]?.url).toContain("key=gluck%2F0123456789abcdef0123456789abcdef%3A3%2Fout");
    expect(speech.calls[0]?.frames).toEqual([{ text: "Hello there. " }, { text: "How are you?" }, { text: "\n\n" }, { text: "Second node." }, { end: true }]);
  });

  it("answers audio.stored without synthesis when speech holds the key", async () => {
    const key = audioKey("gluck", id, 2);
    const { fake, speech, hub, tap } = await withKeyCheck((k) => k === key);
    finished(fake, 2, "Already spoken.");
    await hub.say(id, tap, 2);
    expect(tap.frames).toEqual([{ type: "audio.stored", turn: 2, key }]);
    expect(speech.calls).toEqual([]);
  });

  it("refuses bad turns, open turns and silent turns", async () => {
    const { fake, speech, hub, tap } = await withKeyCheck();
    fake.openTurn(id, 1, "running");
    fake.update(id, 1, [prose(0, "Still talking.")]);
    fake.finishedTurn(id, 2, "q", [{ type: "thinking", markdown: "hmm" } as never]);
    const asked: unknown[] = [0, -1, 1.5, "1", null, 99, 1, 2];
    for (const t of asked) await hub.say(id, tap, t);
    expect(tap.frames.map((f) => (Buffer.isBuffer(f) ? "pcm" : `${String(f.code)}:${String(f.turn)}`))).toEqual(["bad-turn:0", "bad-turn:-1", "bad-turn:1.5", "bad-turn:1", "bad-turn:null", "bad-turn:99", "open:1", "silent:2"]);
    expect(speech.calls).toEqual([]);
  });

  it("refuses a second say on the same listener while one runs, but not on another", async () => {
    const { fake, speech, hub, tap, other } = await withKeyCheck();
    speech.holdUrl = "%3A4%2F";
    finished(fake, 4, "Held open.");
    finished(fake, 5, "Free.");
    await hub.say(id, tap, 4);
    await until("speech opened", () => speech.calls.length === 1);
    await hub.say(id, tap, 5);
    expect(tap.of("error")).toEqual([{ type: "error", turn: 5, code: "busy", text: expect.any(String) }]);
    await hub.say(id, other, 5);
    await until("other end", () => other.of("audio.end").length > 0);
    expect(tap.of("audio.end")).toEqual([]);
  });

  it("reports a synthesis failure as speech to the asker", async () => {
    const { fake, speech, hub, tap, other } = await withKeyCheck();
    finished(fake, 1, "Doomed.");
    await speech.stop();
    await hub.say(id, tap, 1);
    await until("error", () => tap.of("error").length > 0);
    expect(tap.of("error")[0]).toMatchObject({ turn: 1, code: "speech" });
    expect(other.frames).toEqual([]);
    await hub.say(id, tap, 1);
    await until("second error", () => tap.of("error").length > 1);
  });

  it("stops speech on cancel, and when the hub closes", async () => {
    const { fake, speech, hub, tap } = await withKeyCheck();
    speech.holdUrl = "gluck";
    finished(fake, 1, "One.");
    finished(fake, 2, "Two.");
    await hub.say(id, tap, 1);
    await until("opened", () => speech.calls.length === 1);
    hub.cancel(id, "client", tap);
    await until("closed", () => speech.calls[0]?.closed === true);
    expect(tap.of("audio.end")).toEqual([]);
    await hub.say(id, tap, 2);
    await until("second opened", () => speech.calls.length === 2);
    hub.close();
    await until("hub closed", () => speech.calls[1]?.closed === true);
  });

  it("stops speech when the asking listener leaves", async () => {
    const fake = new FakeAria();
    fake.addAria(id);
    const speech = await startFakeSpeech();
    cleanups.push(() => speech.stop());
    speech.holdUrl = "gluck";
    const hub = new AudioHub({ connect: () => new AriaClient({ dial: fake.dial, retryMinMs: 5, releaseGraceMs: 0 }), speech: speechOverSocket(speech.path), store: "gluck" });
    cleanups.push(() => hub.close());
    const stay = new Tap();
    const asker = new Tap();
    await hub.join(id, stay);
    const leave = await hub.join(id, asker);
    fake.finishedTurn(id, 1, "q", [{ type: "prose", role: "output", markdown: "Words." } as never]);
    await hub.say(id, asker, 1);
    await until("opened", () => speech.calls.length === 1);
    leave();
    await until("closed", () => speech.calls[0]?.closed === true);
    expect(stay.frames).toEqual([]);
  });

  it("keeps live audio flowing for a new turn while a say runs", async () => {
    const { fake, speech, hub, tap, other } = await withKeyCheck();
    speech.holdUrl = "%3A1%2F";
    finished(fake, 1, "Old words.");
    await hub.say(id, tap, 1);
    await until("say opened", () => speech.calls.length === 1);
    fake.openTurn(id, 2, "next");
    fake.update(id, 2, [prose(0, "Live words. More")]);
    fake.seal(id, 2);
    fake.done(id);
    await until("live end", () => other.of("audio.end").length > 0);
    expect(other.of("audio.start")[0]).toMatchObject({ turn: 2 });
    expect(other.of("audio.start")[0]).not.toHaveProperty("say");
    expect(speech.calls[0]?.closed).toBe(false);
    expect(tap.of("audio.start").map((f) => [f.turn, f.say === true])).toEqual([[1, true], [2, false]]);
  });
});
