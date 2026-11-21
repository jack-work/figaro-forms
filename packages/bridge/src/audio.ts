import type { Anchor, AppliedFrame, AriaClient, AriaStream, Node, TurnEnd } from "figaro-forms/aria";
import { pcmFormat, type SpeechDial, type SpeechSession } from "./speech.js";
import { takeSentences } from "./sentences.js";
import { redact, sessionField, sessionList } from "./door.js";

export interface AudioListener {
  readonly session?: string;
  json(frame: Record<string, unknown>): void;
  binary(pcm: Buffer): void;
}

export interface AudioHubOptions {
  readonly connect: () => AriaClient;
  readonly speech: SpeechDial;
  readonly store: string;
  readonly voiceOf?: (aria: string) => Promise<string | undefined>;
  readonly stored?: (key: string, session: string) => Promise<boolean>;
  readonly log?: (line: string) => void;
}

export type CancelReason = "interrupt" | "new-turn" | "client" | "reaped" | "left";

export const ariaIdPattern = /^[0-9a-f]{32}$/;

export function audioKey(store: string, aria: string, turn: number): string {
  return `${store}/${aria}:${turn}/out`;
}

interface Active {
  readonly only: AudioListener | undefined;
  readonly turn: number;
  readonly key: string;
  readonly texts: Map<number, number>;
  readonly written: string[];
  readonly voice: Promise<string | undefined>;
  node: number;
  buf: string;
  fedNode: number;
  fedChars: number;
  speech: SpeechSession | undefined;
  starting: boolean;
  ended: boolean;
  retried: boolean;
  started: boolean;
  offset: number;
  chunks: number;
  carry: Buffer;
  dead: boolean;
}

const interruptedReason = /^(interrupt|cancel|abort)/i;

interface Say {
  cancelled: boolean;
  active: Active | undefined;
}

interface Replayed {
  readonly sealed: boolean;
  readonly nodes: Map<number, Node>;
}

const spoken = (n: Node): boolean => n.type === "prose" && n.role === "output";

class Follower {
  readonly listeners = new Set<AudioListener>();
  private active: Active | undefined;
  private stream: AriaStream | undefined;
  private offs: (() => void)[] = [];
  private finished = 0;
  private readonly says = new Map<AudioListener, Say>();

  constructor(
    readonly aria: string,
    private readonly hub: AudioHub,
  ) {}

  async attach(client: AriaClient): Promise<void> {
    const stream = client.retain(this.aria);
    this.stream = stream;
    this.offs = [stream.onFrame((a) => this.onFrame(a)), stream.onTurnEnd((e) => this.onTurnEnd(e))];
    try {
      await stream.ready();
    } catch (e) {
      this.detach(client);
      throw e;
    }
  }

  detach(client: AriaClient): void {
    for (const off of this.offs.splice(0)) off();
    this.cancel("reaped", false);
    for (const l of [...this.says.keys()]) this.cancelSay(l, "reaped", false);
    client.release(this.aria);
  }

  cancel(why: CancelReason, tell = true): void {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    this.finished = Math.max(this.finished, a.turn);
    this.halt(a, why, tell);
  }

  private halt(a: Active, why: CancelReason, tell: boolean): void {
    a.dead = true;
    a.speech?.cancel();
    this.log(`${a.only ? "say" : "turn"} cancelled aria=${this.aria} turn=${a.turn} why=${why} chunks=${a.chunks} bytes=${a.offset}`, this.heard(a));
    if (tell && (a.started || a.written.length > 0 || a.buf !== "")) this.tell(a, { type: "audio.cancel", turn: a.turn, key: a.key, why });
  }

  cancelSay(listener: AudioListener, why: CancelReason, tell = true): void {
    const s = this.says.get(listener);
    if (!s) return;
    this.says.delete(listener);
    s.cancelled = true;
    if (s.active) this.halt(s.active, why, tell);
  }

  async say(client: AriaClient, listener: AudioListener, turn: unknown): Promise<void> {
    const refuse = (code: string, text: string, why?: string): void => {
      this.log(`say refused aria=${this.aria} turn=${String(turn)} code=${code}${why ? " " + redact(why) : ""}`, [listener]);
      listener.json({ type: "error", turn, code, text });
    };
    if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 1) return refuse("bad-turn", "turn must be a positive integer");
    if (this.says.has(listener)) return refuse("busy", "a say is already running on this socket");
    const s: Say = { cancelled: false, active: undefined };
    this.says.set(listener, s);
    const drop = (): void => {
      if (this.says.get(listener) === s) this.says.delete(listener);
    };
    let replayed: Replayed | undefined;
    try {
      replayed = await this.replay(client, turn);
    } catch (e) {
      drop();
      if (!s.cancelled) refuse("door", "could not read the turn", e instanceof Error ? e.message : String(e));
      return;
    }
    if (s.cancelled) return;
    if (!replayed) {
      drop();
      return refuse("bad-turn", `no turn ${turn}`);
    }
    if (!replayed.sealed) {
      drop();
      return refuse("open", `turn ${turn} is still running`);
    }
    const key = audioKey(this.hub.options.store, this.aria, turn);
    const have = await (this.hub.options.stored?.(key, sessionField(this.sessions([listener]))) ?? Promise.resolve(false)).catch(() => false);
    if (s.cancelled) return;
    if (have) {
      drop();
      this.log(`say stored aria=${this.aria} turn=${turn}`, [listener]);
      listener.json({ type: "audio.stored", turn, key });
      return;
    }
    const a = this.begin(turn, listener);
    s.active = a;
    for (const [id, n] of replayed.nodes) if (spoken(n)) this.prose(a, id, n.markdown ?? "");
    this.finish(a);
    if (a.written.length === 0) {
      drop();
      return refuse("silent", `turn ${turn} has no output prose`);
    }
  }

  private async replay(client: AriaClient, turn: number): Promise<Replayed | undefined> {
    const nodes = new Map<number, Node>();
    let found = false;
    let sealed = true;
    let at: Anchor = { turn, node: 0 };
    for (;;) {
      const page = await client.read(this.aria, { at });
      for (const part of page.parts) {
        if (part.turn !== turn) continue;
        found = true;
        sealed = sealed && part.sealed;
        (part.nodes ?? []).forEach((n, i) => nodes.set(part.from + i, n));
      }
      if (!page.next || page.next.turn !== turn) break;
      at = page.next;
    }
    return found ? { sealed, nodes } : undefined;
  }

  private tell(a: Active, frame: Record<string, unknown>): void {
    if (a.only) a.only.json(frame);
    else this.send(frame);
  }

  private settle(a: Active): void {
    if (a.only) {
      if (this.says.get(a.only)?.active === a) this.says.delete(a.only);
    } else if (this.active === a) this.active = undefined;
  }

  private log(line: string, from?: Iterable<AudioListener>): void {
    this.hub.options.log?.(`${line} session=${sessionField(this.sessions(from))}`);
  }

  private sessions(from?: Iterable<AudioListener>): string[] {
    return sessionList([...(from ?? this.listeners)].map((l) => l.session));
  }

  private heard(a: Active): AudioListener[] {
    return a.only ? [a.only] : [...this.listeners];
  }

  private cursor(): number {
    return this.stream?.cursor ?? 0;
  }

  private send(frame: Record<string, unknown>): void {
    for (const l of this.listeners) l.json(frame);
  }

  private onFrame(frame: AppliedFrame): void {
    if (frame.source === "push") {
      const next = frame.open?.turn;
      if (next !== undefined && this.active && next > this.active.turn) this.cancel("new-turn");
      for (const c of frame.nodes) if (spoken(c.node)) this.hear(c.turn, c.id, c.node.markdown ?? "");
      return;
    }
    this.rejoin(frame);
  }

  private onTurnEnd(e: TurnEnd): void {
    const a = this.active;
    if (!a || a.turn !== e.turn || e.replayed || !e.done) return;
    if (interruptedReason.test(e.done.reason)) this.cancel("interrupt");
    else this.finish(a);
  }

  private hear(turn: number, id: number, text: string): void {
    let a = this.active;
    if (a && turn < a.turn) return;
    if (!a || a.turn !== turn) {
      if (turn <= this.finished) return;
      this.cancel("new-turn");
      a = this.begin(turn);
    }
    if (a.ended) return;
    this.prose(a, id, text);
  }

  private rejoin(frame: AppliedFrame): void {
    const open = frame.open;
    const held = [...frame.closed, ...(open ? [open] : [])];
    let a = this.active;
    if (open && open.turn !== a?.turn && open.turn > this.finished) {
      this.cancel("new-turn");
      a = this.begin(open.turn);
      for (const m of held) {
        if (m.turn !== open.turn) continue;
        m.nodes.forEach((n, i) => {
          if (spoken(n)) (a as Active).texts.set(m.from + i, (n.markdown ?? "").length);
        });
      }
      return;
    }
    if (!a || a.ended) return;
    for (const m of held) {
      if (m.turn !== a.turn) continue;
      m.nodes.forEach((n, i) => {
        if (spoken(n)) this.prose(a as Active, m.from + i, n.markdown ?? "");
      });
    }
    if (frame.sealed.includes(a.turn)) this.finish(a);
  }

  private begin(turn: number, only?: AudioListener): Active {
    const voice = (this.hub.options.voiceOf?.(this.aria) ?? Promise.resolve(undefined)).catch(() => undefined);
    const a: Active = {
      only,
      turn,
      key: audioKey(this.hub.options.store, this.aria, turn),
      texts: new Map(),
      written: [],
      voice,
      node: -1,
      buf: "",
      fedNode: 0,
      fedChars: 0,
      speech: undefined,
      starting: false,
      ended: false,
      retried: false,
      started: false,
      offset: 0,
      chunks: 0,
      carry: Buffer.alloc(0),
      dead: false,
    };
    if (!only) this.active = a;
    this.log(`${only ? "say" : "turn"} seen aria=${this.aria} turn=${turn}`, only ? [only] : undefined);
    return a;
  }

  private prose(a: Active, node: number, text: string): void {
    if (node < a.node) return;
    if (node > a.node) {
      if (a.node >= 0) {
        this.feed(a, a.buf, a.node, a.texts.get(a.node) ?? 0);
        this.feed(a, "\n\n", a.node, a.texts.get(a.node) ?? 0);
        a.buf = "";
      }
      a.node = node;
    }
    const heard = a.texts.get(node) ?? 0;
    if (text.length > heard) {
      a.buf += text.slice(heard);
      a.texts.set(node, text.length);
    }
    const { ready, rest } = takeSentences(a.buf, false);
    if (ready !== "") {
      a.buf = rest;
      this.feed(a, ready, node, (a.texts.get(node) ?? 0) - rest.length);
    }
  }

  private finish(a: Active): void {
    if (a.buf !== "") this.feed(a, a.buf, a.node, a.texts.get(a.node) ?? 0);
    a.buf = "";
    a.ended = true;
    if (!a.only) this.finished = Math.max(this.finished, a.turn);
    if (a.speech) a.speech.end();
    else if (!a.starting) this.settle(a);
  }

  private feed(a: Active, text: string, node: number, chars: number): void {
    if (text === "" || a.dead) return;
    a.fedNode = node;
    a.fedChars = chars;
    a.written.push(text);
    if (a.speech) a.speech.write(text);
    else this.startSpeech(a);
  }

  private startSpeech(a: Active): void {
    if (a.starting) return;
    a.starting = true;
    void a.voice.then((voice) => {
      if (a.dead) return;
      this.openSpeech(a, voice);
    });
  }

  private speechFailed(a: Active, text: string): void {
    this.settle(a);
    a.dead = true;
    this.log(`${a.only ? "say failed code=speech" : "tts error"} aria=${this.aria} turn=${a.turn} chunks=${a.chunks} text=${redact(text)}`, this.heard(a));
    this.tell(a, { type: "error", turn: a.turn, code: "speech", text });
  }

  private openSpeech(a: Active, voice: string | undefined): void {
    let heard = false;
    this.log(`tts open aria=${this.aria} turn=${a.turn} key=${a.key}${voice ? " voice=" + voice : ""}`, this.heard(a));
    let session: SpeechSession;
    try {
      session = this.openSession(a, voice, () => (heard = true), () => heard);
    } catch (e) {
      this.speechFailed(a, e instanceof Error ? e.message : String(e));
      return;
    }
    a.speech = session;
    for (const t of a.written) session.write(t);
    if (a.ended) session.end();
  }

  private openSession(a: Active, voice: string | undefined, hear: () => void, wasHeard: () => boolean): SpeechSession {
    return this.hub.options.speech(
      { key: a.key, ...(voice ? { voice } : {}), sessions: this.sessions(this.heard(a)) },
      {
        audio: (pcm) => {
          if (a.dead) return;
          hear();
          this.audio(a, pcm);
        },
        done: (audioId) => {
          if (a.dead) return;
          this.settle(a);
          this.log(`${a.only ? "say" : "tts done"} aria=${this.aria} turn=${a.turn} chunks=${a.chunks} bytes=${a.offset}${audioId !== undefined ? " audio_id=" + audioId : ""}`, this.heard(a));
          this.tell(a, { type: "audio.end", turn: a.turn, key: a.key, ...(audioId !== undefined ? { audio_id: audioId } : {}) });
        },
        error: (text) => {
          if (a.dead) return;
          if (voice && !wasHeard() && !a.retried) {
            a.retried = true;
            this.log(`tts retry without voice aria=${this.aria} turn=${a.turn} text=${redact(text)}`, this.heard(a));
            this.openSpeech(a, undefined);
            return;
          }
          this.speechFailed(a, text);
        },
      },
    );
  }

  private audio(a: Active, chunk: Buffer): void {
    const pcm = Buffer.concat([a.carry, chunk]);
    const even = pcm.length - (pcm.length % 2);
    a.carry = pcm.subarray(even);
    if (even === 0) return;
    const out = pcm.subarray(0, even);
    if (!a.started) {
      a.started = true;
      this.tell(a, { type: "audio.start", turn: a.turn, key: a.key, ...(a.only ? { say: true } : {}), ...pcmFormat, node: a.fedNode, chars: a.fedChars, cursor: this.cursor() });
    }
    const header = { type: "audio.chunk", turn: a.turn, node: a.fedNode, chars: a.fedChars, cursor: this.cursor(), offset: a.offset, bytes: out.length };
    a.offset += out.length;
    a.chunks += 1;
    for (const l of a.only ? [a.only] : this.listeners) {
      l.json(header);
      l.binary(out);
    }
  }
}

export class AudioHub {
  private client: AriaClient | undefined;
  private readonly followers = new Map<string, Follower>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(readonly options: AudioHubOptions) {}

  async join(aria: string, listener: AudioListener): Promise<() => void> {
    let f = this.followers.get(aria);
    if (!f) {
      f = new Follower(aria, this);
      this.followers.set(aria, f);
      const client = (this.client ??= this.options.connect());
      const attached = f.attach(client).catch((e: unknown) => {
        this.followers.delete(aria);
        this.release();
        throw e;
      });
      this.pending.set(aria, attached);
    }
    f.listeners.add(listener);
    const follower = f;
    try {
      await this.pending.get(aria);
    } catch (e) {
      follower.listeners.delete(listener);
      throw e;
    }
    return () => {
      follower.cancelSay(listener, "left", false);
      follower.listeners.delete(listener);
      if (follower.listeners.size > 0 || this.followers.get(aria) !== follower) return;
      this.followers.delete(aria);
      this.pending.delete(aria);
      if (this.client) follower.detach(this.client);
      this.release();
    };
  }

  cancel(aria: string, why: CancelReason, listener?: AudioListener): void {
    const f = this.followers.get(aria);
    f?.cancel(why);
    if (listener) f?.cancelSay(listener, why);
  }

  async say(aria: string, listener: AudioListener, turn: unknown): Promise<void> {
    const f = this.followers.get(aria);
    if (!f || !this.client) return;
    await f.say(this.client, listener, turn);
  }

  close(): void {
    for (const f of this.followers.values()) if (this.client) f.detach(this.client);
    this.followers.clear();
    this.client?.close();
    this.client = undefined;
  }

  private release(): void {
    if (this.followers.size > 0) return;
    this.client?.close();
    this.client = undefined;
  }
}
