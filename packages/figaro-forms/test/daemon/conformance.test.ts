import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AriaClient, ariaRefusal, type AriaEvent, type AriaStream } from "../../src/aria/index.js";
import { startDaemon, type Daemon } from "./daemon.js";

const bin = process.env.FIGARO_BIN;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const quiet = (es: readonly AriaEvent[]): AriaEvent[] => es.filter((e) => e.kind !== "metrics");

describe.skipIf(!bin)("conformance against a disposable figaro daemon (FIGARO_BIN)", () => {
  let daemon: Daemon;
  const clients: AriaClient[] = [];

  const connect = (user = "gluck"): AriaClient => {
    const c = new AriaClient({ dial: daemon.dial(user), retryMinMs: 50, retryMaxMs: 200 });
    clients.push(c);
    return c;
  };

  const attend = async (c: AriaClient, id: string, o?: Parameters<AriaClient["attach"]>[1]): Promise<{ s: AriaStream; events: AriaEvent[] }> => {
    const s = c.attach(id, o);
    const events: AriaEvent[] = [];
    s.subscribe((e) => events.push(e));
    await s.ready();
    return { s, events };
  };

  beforeAll(async () => {
    daemon = await startDaemon(bin as string);
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await daemon?.stop();
  }, 60_000);

  it("catches up a finished turn the daemon holds, then follows a prompt sent through the door", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const { s, events } = await attend(c, id);
    expect(quiet(events).map((e) => e.type)).toEqual(["input", "prose.settled", "turn.end"]);
    expect(quiet(events)[0]).toMatchObject({ type: "input", turn: 1, text: "seed" });
    expect(quiet(events)[1]).toMatchObject({ text: "Buongiorno, signore. Largo al factotum. " });
    expect(quiet(events)[2]).toMatchObject({ replayed: true });

    const sent = await s.prompt("say hi");
    expect(sent.ok).toBe(true);
    await until("the second turn to end", () => events.some((e) => e.type === "turn.end" && e.turn === 2));
    const turn2 = quiet(events).filter((e) => "turn" in e && e.turn === 2);
    expect(turn2[0]).toMatchObject({ type: "input", text: "say hi" });
    expect(turn2.some((e) => e.type === "prose.delta")).toBe(true);
    expect(turn2.filter((e) => e.type === "prose.settled")).toMatchObject([{ text: "Buongiorno, signore. Largo al factotum. " }]);
    expect(turn2.at(-1)).toMatchObject({ type: "turn.end", reason: "stop", idle: true, replayed: false });
    const grown = turn2.filter((e) => e.type === "prose.delta").map((e) => (e as { text: string }).text);
    for (let i = 1; i < grown.length; i++) expect((grown[i] as string).startsWith(grown[i - 1] as string)).toBe(true);
  });

  it("reports a tool call as start, updates and end, with its arguments and output", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const { s, events } = await attend(c, id);
    await s.prompt("[tool] run it");
    await until("the tool turn to end", () => events.some((e) => e.type === "turn.end" && e.turn === 2));
    const tools = quiet(events).filter((e) => e.kind === "tool");
    expect(tools[0]).toMatchObject({ type: "tool.start", tool: { name: "bash", status: "running" } });
    const end = tools.at(-1);
    expect(end).toMatchObject({ type: "tool.end", failed: false, result: "tool-ran-ok", tool: { name: "bash", status: "ok", args: { command: "echo tool-ran-ok" } } });
    expect(tools.filter((e) => e.type === "tool.end")).toHaveLength(1);
    const settled = quiet(events).filter((e) => e.type === "prose.settled" && e.turn === 2) as unknown as { text: string }[];
    expect(settled.map((e) => e.text)).toEqual(["Let me look. ", "The tool said tool-ran-ok. Done."]);
  });

  it("shows a message sent mid-turn as a steering node", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const { s, events } = await attend(c, id);
    await s.prompt("[slowtool] go");
    await until("the tool to start", () => events.some((e) => e.type === "tool.start"));
    await s.prompt("also consider this");
    await until("the turn to end", () => events.some((e) => e.type === "turn.end" && e.turn === 2));
    const steer = quiet(events).filter((e) => e.kind === "steering");
    expect(steer.map((e) => e.type)).toEqual(["steering.delta", "steering.settled"]);
    expect(steer[1]).toMatchObject({ text: "also consider this", turn: 2 });
  }, 30_000);

  it("ends a refused turn with turn.error carrying the provider's words", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const { s, events } = await attend(c, id);
    await s.prompt("[boom] now");
    await until("the error", () => events.some((e) => e.type === "turn.error"));
    const failed = events.find((e) => e.type === "turn.error") as unknown as { reason: string; turn: number; idle: boolean };
    expect(failed.turn).toBe(2);
    expect(failed.reason).toContain("the fake model refused on purpose");
    expect(failed.idle).toBe(true);
  });

  it("resumes across a dropped connection mid-reply with no gap and no duplicate", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const { s, events } = await attend(c, id);
    await s.prompt("[slow] stream for a while");
    await until("some prose", () => events.some((e) => e.type === "prose.delta" && e.turn === 2));
    c.connection.reconnectNow();
    await until("the turn to end", () => events.some((e) => e.type === "turn.end" && e.turn === 2), 30_000);
    const settled = quiet(events).filter((e) => e.type === "prose.settled" && e.turn === 2);
    expect(settled).toHaveLength(1);
    expect((settled[0] as unknown as { text: string }).text).toBe("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen. ");
    expect(quiet(events).filter((e) => e.type === "input" && e.turn === 2)).toHaveLength(1);
    expect(quiet(events).filter((e) => e.type === "turn.end" && e.turn === 2)).toHaveLength(1);
    const last = quiet(events).filter((e) => e.type === "prose.delta").at(-1) as unknown as { text: string };
    expect(last.text).toBe((settled[0] as unknown as { text: string }).text);
  }, 40_000);

  it("resumes in a second client from the cursor of the first, and hears only what is new", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const a = connect();
    const first = await attend(a, id);
    await first.s.prompt("say hi");
    await until("turn 2", () => first.events.some((e) => e.type === "turn.end" && e.turn === 2));
    const cursor = first.events.at(-1)?.cursor as string;
    expect(cursor).toBe(first.s.cursor);

    const b = connect();
    const second = await attend(b, id, { cursor });
    expect(quiet(second.events)).toEqual([]);
    await first.s.prompt("[tool] again");
    await until("turn 3 on both", () => [first.events, second.events].every((es) => es.some((e) => e.type === "turn.end" && e.turn === 3)));
    const key = (e: AriaEvent): string => `${e.type}/${"turn" in e ? e.turn : ""}/${"node" in e ? e.node : "tool" in e ? e.tool.node : ""}`;
    const settledA = quiet(first.events).filter((e) => "turn" in e && e.turn === 3 && /settled|end|input/.test(e.type)).map(key);
    const settledB = quiet(second.events).filter((e) => /settled|end|input/.test(e.type)).map(key);
    expect(settledB).toEqual(settledA);
    expect(second.events.some((e) => "turn" in e && e.turn < 3)).toBe(false);
  }, 40_000);

  it("interrupts a running turn", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const { s, events } = await attend(c, id);
    await s.prompt("[slow] stream for a while");
    await until("some prose", () => events.some((e) => e.type === "prose.delta" && e.turn === 2));
    const r = await s.interrupt();
    expect(r.ok).toBe(true);
    await until("the turn to end", () => events.some((e) => (e.type === "turn.end" || e.type === "turn.error") && e.turn === 2));
    const settled = quiet(events).filter((e) => e.type === "prose.settled" && e.turn === 2);
    expect(settled.length).toBeLessThanOrEqual(1);
  }, 30_000);

  it("lists figaros, forks one, and attends the fork", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const c = connect();
    const list = await c.list();
    expect(list.rows.map((r) => r.id)).toContain(id);
    const forked = await c.fork(id);
    expect(forked.alternative).not.toBe(id);
    const { events } = await attend(c, forked.alternative);
    expect(quiet(events).some((e) => e.type === "input" && e.turn === 1)).toBe(true);
  });

  it("lets a read-only principal attend, and refuses it a prompt, an interrupt and a fork in the daemon's words", async () => {
    const id = daemon.newAria("seed");
    await sleep(800);
    const v = connect("viewer");
    const { events } = await attend(v, id);
    expect(quiet(events).map((e) => e.type)).toEqual(["input", "prose.settled", "turn.end"]);
    for (const attempt of [() => v.prompt(id, "nope"), () => v.interrupt(id), () => v.fork(id)]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(ariaRefusal(err)).toMatchObject({ kind: "denied", code: -32020 });
    }
  });

  it("shows an aria that does not exist as gone", async () => {
    const c = connect();
    const s = c.attach("00000000000000000000000000000000");
    await expect(s.ready()).rejects.toMatchObject({ refusal: { kind: "not_found" } });
    expect(s.state).toBe("gone");
  });
});
