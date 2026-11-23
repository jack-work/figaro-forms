import { readFileSync } from "node:fs";
import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import { ariaRefusal } from "../../src/aria/errors.js";
import { queueAtom } from "../../src/aria/jotai.js";
import { foldQueue, queueActions, queueActionsOf, queueMark, queueRef } from "../../src/aria/queue.js";
import type { Json, JsonObject } from "../../src/json.js";
import { RpcError } from "../../src/rpc.js";
import { FakeAria, settle } from "./fake-aria.js";

interface Wire {
  readonly method: string;
  readonly params: Record<string, Json>;
}

interface Tape {
  readonly form: { readonly snapshot: JsonObject; readonly version: number; readonly incarnation: number };
  readonly deltas: readonly Record<string, unknown>[];
  readonly calls: { readonly [name: string]: { readonly out: Wire; readonly in: { readonly result: Json } } };
}

const tape = JSON.parse(readFileSync(new URL("./samples/pager-queue.json", import.meta.url), "utf8")) as Tape;

const aria = "q1";

function world() {
  const fake = new FakeAria();
  fake.addAria(aria);
  fake.formReplace(queueRef(aria), structuredClone(tape.form.snapshot), tape.form.version, tape.form.incarnation);
  const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5, retryMinMs: 5, retryMaxMs: 10 });
  return { fake, client, store: createStore() };
}

const ids = (rows: readonly { readonly id: number }[]): number[] => rows.map((r) => r.id);

describe("foldQueue on what the daemon published", () => {
  const view = foldQueue(tape.form.snapshot);

  it("reads the epoch and shows the waiting messages in the order the form names", () => {
    expect(view.epoch).toBe("12a74936692e7ab9");
    expect(ids(view.rows)).toEqual([2, 3, 4]);
    expect(view.rows.map((r) => r.state)).toEqual(["queued", "queued", "queued"]);
    expect(view.rows[2]?.text).toBe("fourth: two lines\nsecond line of the fourth");
  });

  it("keeps a message that has left the line apart from the rows", () => {
    expect(ids(view.departed)).toEqual([1]);
    expect(view.departed[0]).toMatchObject({ state: "committed", turn: 1, text: "first question, in flight" });
  });

  it("lists rows the order does not name after it, by id, as the pager does", () => {
    const root = { epoch: "e", order: [4, 2], items: { "2": { state: "queued" }, "3": { state: "committing" }, "4": { state: "queued" }, "9": { state: "queued" } } };
    expect(ids(foldQueue(root).rows)).toEqual([4, 2, 3, 9]);
  });

  it("skips what is not a message and never repeats an id", () => {
    const root = { order: [2, 2, 7], items: { "2": { state: "queued" }, nope: { state: "queued" }, "5": "x" } };
    expect(ids(foldQueue(root).rows)).toEqual([2]);
    expect(foldQueue({}).epoch).toBe("");
  });

  it("marks a committing message with the pager's arrow and a waiting one with its dot", () => {
    const [waiting, committing] = foldQueue({ items: { "1": { state: "queued" }, "2": { state: "committing" } } }).rows;
    expect([queueMark(waiting as never), queueMark(committing as never)]).toEqual(["·", "→"]);
  });
});

describe("queueAtom against the frames a pager session recorded", () => {
  it("seeds from the form and follows every recorded delta", async () => {
    const { fake, client, store } = world();
    const atom = queueAtom(client, aria);
    expect(queueAtom(client, aria)).toBe(atom);
    const off = store.sub(atom, () => {});
    await settle();
    expect(store.get(atom)).toMatchObject({ aria, ready: true, epoch: "12a74936692e7ab9" });
    expect(ids(store.get(atom).rows)).toEqual([2, 3, 4]);

    const seen: { rows: number[]; departed: number[] }[] = [];
    for (const d of tape.deltas) {
      fake.deltaFrame(structuredClone(d));
      await settle();
      const q = store.get(atom);
      seen.push({ rows: ids(q.rows), departed: ids(q.departed) });
    }
    expect(seen).toEqual([
      { rows: [2, 4], departed: [1, 3] },
      { rows: [2, 4, 5], departed: [1, 3] },
      { rows: [2, 4, 5], departed: [1, 3] },
      { rows: [2], departed: [1, 3, 4, 5] },
      { rows: [2], departed: [1, 3, 4, 5] },
      { rows: [], departed: [1, 2, 3, 4, 5] },
      { rows: [], departed: [1, 2, 3, 4, 5] },
    ]);
    off();
    client.close();
  });

  it("shows a dropped message as departed and an edit in place", async () => {
    const { fake, client, store } = world();
    const atom = queueAtom(client, aria);
    const off = store.sub(atom, () => {});
    await settle();
    for (const d of tape.deltas.slice(0, 3)) fake.deltaFrame(structuredClone(d));
    await settle();
    const q = store.get(atom);
    expect(q.departed.find((r) => r.id === 3)?.state).toBe("dropped");
    expect(q.rows.find((r) => r.id === 2)?.text).toBe("second, edited from the CLI");
    off();
    client.close();
  });

  it("shows what an interrupt folded: the survivor holds the text, the others point at it", async () => {
    const { fake, client, store } = world();
    const atom = queueAtom(client, aria);
    const off = store.sub(atom, () => {});
    await settle();
    for (const d of tape.deltas.slice(0, 4)) fake.deltaFrame(structuredClone(d));
    await settle();
    const q = store.get(atom);
    expect(q.rows[0]).toMatchObject({ id: 2, merged: [4, 5] });
    expect(q.rows[0]?.text).toContain("fifth: sent from outside while the pit is open");
    expect(q.departed.filter((r) => r.state === "merged").map((r) => [r.id, r.into])).toEqual([
      [4, 2],
      [5, 2],
    ]);
    off();
    client.close();
  });

  it("keeps a committing message on screen after the order drops it", async () => {
    const { fake, client, store } = world();
    const atom = queueAtom(client, aria);
    const off = store.sub(atom, () => {});
    await settle();
    for (const d of tape.deltas.slice(0, 5)) fake.deltaFrame(structuredClone(d));
    await settle();
    const q = store.get(atom);
    expect(q.rows.map((r) => [r.id, r.state])).toEqual([[2, "committing"]]);
    off();
    client.close();
  });

  it("re-reads the queue form when the daemon restarts it", async () => {
    const { fake, client, store } = world();
    const atom = queueAtom(client, aria);
    const off = store.sub(atom, () => {});
    await settle();
    const reads = fake.formCalls(aria, "queue");
    fake.formReplace(queueRef(aria), { epoch: "fresh", len: 0, items: {} }, 1, tape.form.incarnation + 1e6);
    fake.deltaFrame({ schema: 2, aria_id: aria, intrinsic: "queue", version: 1, incarnation: tape.form.incarnation + 1e6, patch: {}, at: 0 });
    await settle();
    expect(fake.formCalls(aria, "queue")).toBe(reads + 1);
    expect(store.get(atom)).toMatchObject({ epoch: "fresh", rows: [] });
    off();
    client.close();
  });
});

describe("queue actions send the calls the pager sends", () => {
  const sent = (fake: FakeAria, method: string): Wire[] => fake.calls.filter((c) => c.method === method);
  const wire = (w: Wire): Wire => ({ method: w.method, params: w.params });

  it("drop is figaro.queue.delete with the epoch it read and the one id, as x does", async () => {
    const { fake, client, store } = world();
    fake.answers.set("figaro.queue.delete", (tape.calls.delete as { in: { result: Json } }).in.result);
    const off = store.sub(queueAtom(client, aria), () => {});
    await settle();
    const res = await queueActionsOf(client, aria).drop(3);
    expect(sent(fake, "figaro.queue.delete").map(wire)).toEqual([wire((tape.calls.delete as { out: Wire }).out)]);
    expect(res.results).toEqual([{ id: 3, outcome: "deleted" }]);
    off();
    client.close();
  });

  it("edit is figaro.queue.update with the epoch, the id and the new text, as queue edit does", async () => {
    const { fake, client, store } = world();
    fake.answers.set("figaro.queue.update", (tape.calls.update as { in: { result: Json } }).in.result);
    const off = store.sub(queueAtom(client, aria), () => {});
    await settle();
    const res = await queueActionsOf(client, aria).edit(2, "second, edited from the CLI");
    expect(sent(fake, "figaro.queue.update").map(wire)).toEqual([wire((tape.calls.update as { out: Wire }).out)]);
    expect(res.result).toEqual({ id: 2, outcome: "updated" });
    off();
    client.close();
  });

  it("hangUp is figaro.interrupt keeping the queue, as H does, and returns the folded queue", async () => {
    const { fake, client, store } = world();
    fake.answers.set("figaro.interrupt", (tape.calls.interrupt as { in: { result: Json } }).in.result);
    const off = store.sub(queueAtom(client, aria), () => {});
    await settle();
    const res = await queueActionsOf(client, aria).hangUp();
    expect(sent(fake, "figaro.interrupt").map(wire)).toEqual([wire((tape.calls.interrupt as { out: Wire }).out)]);
    expect(res).toMatchObject({ ok: true, stopped: true, epoch: "12a74936692e7ab9" });
    off();
    client.close();
  });

  it("leaves the epoch out when none was read, so the daemon answers stale as it does the pager", async () => {
    const { fake, client } = world();
    await queueActions(client, aria, () => "").drop(2);
    expect(sent(fake, "figaro.queue.delete").map((c) => c.params)).toEqual([{ figaro_id: aria, ids: [2] }]);
    client.close();
  });

  it("passes a per-id rejection through untouched", async () => {
    const { fake, client } = world();
    const rejected = { id: 1, outcome: "rejected", reason: "committed", detail: "already part of the conversation; it cannot be unasked", into: 1 };
    fake.answers.set("figaro.queue.delete", { epoch: "12a74936692e7ab9", results: [rejected] });
    const res = await queueActions(client, aria, () => "12a74936692e7ab9").drop(1);
    expect(res.results).toEqual([rejected]);
    client.close();
  });
});

describe("the gateway door", () => {
  it("surfaces its refusal of a queue call as a denial, not a silent no-op", async () => {
    const { fake, client } = world();
    for (const m of ["figaro.queue.delete", "figaro.queue.update"]) fake.refuseMethod.set(m, { code: -32020, message: `gateway: ${m} is not allowed` });
    const actions = queueActions(client, aria, () => "e");
    const drop = await actions.drop(2).catch((e: unknown) => e);
    expect(drop).toBeInstanceOf(RpcError);
    expect(ariaRefusal(drop)).toMatchObject({ kind: "denied", message: "gateway: figaro.queue.delete is not allowed" });
    const edit = await actions.edit(2, "x").catch((e: unknown) => e);
    expect(ariaRefusal(edit)).toMatchObject({ kind: "denied", message: "gateway: figaro.queue.update is not allowed" });
    client.close();
  });
});
