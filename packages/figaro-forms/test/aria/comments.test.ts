import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import { addComment, commentsByTurn, deleteComment, endBlockOf, foldComments, replyToComment, type CommentEnv } from "../../src/aria/comments.js";
import { parseQuote, type QuoteRange } from "../../src/aria/quote.js";
import { boundFormWriterOf } from "../../src/aria/bound-form.js";
import type { JsonObject } from "../../src/json.js";
import { FakeAria } from "./fake-aria.js";

const pager = JSON.parse(readFileSync(new URL("./samples/pager-comments.json", import.meta.url), "utf8")) as JsonObject;

const at = (token: string): QuoteRange => (parseQuote(token) as { range: QuoteRange }).range;

const sets = (fake: FakeAria): number => fake.calls.filter((c) => c.method === "figaro.set").length;

function envOf(times: number[], ids: number[][]): CommentEnv {
  return { nowMs: () => times.shift() as number, randomBytes: () => Uint8Array.from(ids.shift() as number[]) };
}

function world(seed: JsonObject) {
  const fake = new FakeAria();
  fake.addForm("r1", structuredClone(seed));
  const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5, retryMinMs: 5, retryMaxMs: 10 });
  const root = (): JsonObject => (fake.forms.get("r1") as { value: JsonObject }).value;
  return { fake, client, writer: boundFormWriterOf(client, "r1"), root };
}

describe("foldComments on what the pager wrote", () => {
  const list = foldComments(pager);

  it("reads each comment with its quote, in transcript order", () => {
    expect(list.map((c) => [c.id, c.token])).toEqual([
      ["2py", "<5>!"],
      ["6th", "<5.0:0-4>!"],
    ]);
    expect(list[1]?.at).toEqual(at("<5.0:0-4>!"));
  });

  it("orders a thread by its append keys", () => {
    expect(list[0]?.thread).toEqual([
      { key: "mwsyyoyo", by: "gluck", text: "written by the pager" },
      { key: "mwsyyud9", by: "gluck", text: "a reply from the pager" },
    ]);
  });

  it("carries no turn where the pager wrote none", () => {
    expect(list.map((c) => c.turn)).toEqual([0, 0]);
  });
});

describe("foldComments, the rules the pager applies", () => {
  it("skips a comment whose quote does not parse, and a record that is not an object", () => {
    const root = { comments: { bad: { at: "<0>!", thread: {} }, text: { at: "hello" }, odd: "x", ok: { at: " <3>! ", turn: 2, thread: { a: { text: "t" } } } } };
    expect(foldComments(root).map((c) => [c.id, c.token, c.turn])).toEqual([["ok", "<3>!", 2]]);
  });

  it("orders by start coordinate, then id", () => {
    const root = {
      comments: {
        b: { at: "<9.0:5-8>!", thread: {} },
        a: { at: "<9.0:5-8>!", thread: {} },
        c: { at: "<9.0:1-2>!", thread: {} },
        d: { at: "<4>!", thread: {} },
        e: { at: "<9.1>!", thread: {} },
      },
    };
    expect(foldComments(root).map((c) => c.id)).toEqual(["d", "c", "a", "b", "e"]);
  });

  it("is empty with no comments key", () => {
    expect(foldComments({})).toEqual([]);
    expect(foldComments({ comments: "no" })).toEqual([]);
  });

  it("groups by turn and finds the end block", () => {
    const root = { comments: { a: { at: "<9.0:5-12.2:3>!", turn: 3, thread: {} }, b: { at: "<4>!", turn: 1, thread: {} }, c: { at: "<9.1>!", turn: 3, thread: {} } } };
    const list = foldComments(root);
    expect([...commentsByTurn(list)].map(([turn, cs]) => [turn, cs.map((c) => c.id)])).toEqual([[1, ["b"]], [3, ["a", "c"]]]);
    expect(endBlockOf(at("<9.0:5-12.2:3>!"))).toEqual({ lt: 12, block: 2 });
    expect(endBlockOf(at("<4>!"))).toEqual({ lt: 4, block: 0 });
  });
});

describe("comment writers", () => {
  it("adds a comment in the pager's shape: at, optional turn, one thread entry with by and text", async () => {
    const { client, writer, root } = world({});
    const env = envOf([Date.parse("2026-11-23T00:00:00Z"), Date.parse("2026-11-23T00:00:00Z")], [[0, 1, 2]]);
    const r = await addComment(writer, root(), { at: at("<5.0:0-4>!"), text: "  hello  ", by: "gluck", turn: 1 }, env);
    expect(r).toMatchObject({ ok: true, id: "abc" });
    expect(root()).toEqual({ comments: { abc: { at: "<5.0:0-4>!", turn: 1, thread: { [(r as { key: string }).key]: { by: "gluck", text: "hello" } } } } });
    client.close();
  });

  it("leaves out turn and by when there are none, as the pager does", async () => {
    const { client, writer, root } = world({});
    await addComment(writer, root(), { at: at("<5>!"), text: "x" }, envOf([1000], [[3, 4, 5]]));
    const rec = (root().comments as JsonObject).def as JsonObject;
    expect(Object.keys(rec).sort()).toEqual(["at", "thread"]);
    expect(Object.values(rec.thread as JsonObject)).toEqual([{ text: "x" }]);
    client.close();
  });

  it("writes the key shapes and value types the pager wrote", async () => {
    const { client, writer, root } = world({});
    await addComment(writer, root(), { at: at("<5>!"), text: "x", by: "gluck" });
    const mine = Object.values(root().comments as JsonObject)[0] as JsonObject;
    const theirs = (pager.comments as JsonObject)["2py"] as JsonObject;
    expect(Object.keys(mine).sort()).toEqual(Object.keys(theirs).sort());
    const myEntry = Object.entries(mine.thread as JsonObject)[0] as [string, JsonObject];
    const theirEntry = Object.entries(theirs.thread as JsonObject)[0] as [string, JsonObject];
    expect(myEntry[0]).toMatch(/^[0-9a-z]{8}$/);
    expect(theirEntry[0]).toMatch(/^[0-9a-z]{8}$/);
    expect(myEntry[1]).toEqual({ by: "gluck", text: "x" });
    expect(Object.keys(myEntry[1]).sort()).toEqual(Object.keys(theirEntry[1]).sort());
    expect(Object.keys(root().comments as JsonObject)[0]).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{3}$/);
    client.close();
  });

  it("draws a longer id when the short ones are taken", async () => {
    const { client, writer, root } = world({ comments: { abc: { at: "<1>!", thread: {} } } });
    const bytes: number[][] = Array.from({ length: 64 }, () => [0, 1, 2]);
    const r = await addComment(writer, root(), { at: at("<5>!"), text: "x" }, { nowMs: () => 1, randomBytes: (n) => (n === 3 ? Uint8Array.from(bytes[0] as number[]) : Uint8Array.from([0, 1, 2, 3])) });
    expect(r).toMatchObject({ ok: true, id: "abcd" });
    client.close();
  });

  it("refuses an empty comment without writing", async () => {
    const { fake, client, writer, root } = world({});
    const before = sets(fake);
    expect(await addComment(writer, root(), { at: at("<5>!"), text: "   " })).toEqual({ ok: false, invalid: "comment: nothing to say" });
    expect(sets(fake)).toBe(before);
    client.close();
  });

  it("replies into the pager's thread, after its last key", async () => {
    const { client, writer, root } = world(pager);
    const env = envOf([Date.parse("2026-11-23T00:00:00Z")], []);
    const r = await replyToComment(writer, root(), "2py", "from the web", "gluck", env);
    expect(r).toMatchObject({ ok: true, id: "2py" });
    const folded = foldComments(root()).find((c) => c.id === "2py");
    expect(folded?.thread.map((e) => e.text)).toEqual(["written by the pager", "a reply from the pager", "from the web"]);
    expect(folded?.thread.at(-1)?.by).toBe("gluck");
    client.close();
  });

  it("extends the last key when the clock has not moved past it", async () => {
    const { client, writer, root } = world(pager);
    const r = await replyToComment(writer, root(), "2py", "same instant", undefined, envOf([0], []));
    expect((r as { key: string }).key).toBe("mwsyyud90");
    expect(foldComments(root()).find((c) => c.id === "2py")?.thread.at(-1)).toEqual({ key: "mwsyyud90", by: "", text: "same instant" });
    client.close();
  });

  it("refuses a reply to a comment that is not on the form, and an empty one", async () => {
    const { fake, client, writer, root } = world(pager);
    const before = sets(fake);
    expect(await replyToComment(writer, root(), "zzz", "x")).toEqual({ ok: false, invalid: "comment: no comment #zzz on this aria" });
    expect(await replyToComment(writer, root(), "2py", " ")).toMatchObject({ ok: false, invalid: expect.stringContaining("nothing to say") });
    expect(sets(fake)).toBe(before);
    client.close();
  });

  it("deletes a whole comment and leaves the others", async () => {
    const { client, writer, root } = world(pager);
    expect(await deleteComment(writer, root(), "2py")).toMatchObject({ ok: true, id: "2py" });
    expect(foldComments(root()).map((c) => c.id)).toEqual(["6th"]);
    expect(await deleteComment(writer, root(), "2py")).toMatchObject({ ok: false, invalid: "comment: no comment #2py on this aria" });
    client.close();
  });

  it("round-trips: what the web writes folds back, beside what the pager wrote", async () => {
    const { client, writer, root } = world(pager);
    const added = await addComment(writer, root(), { at: at("<7.0:2-9>!"), text: "web comment", by: "admin", turn: 2 });
    if (!added.ok || !("id" in added)) throw new Error("write failed");
    await replyToComment(writer, root(), added.id, "web reply", "admin");
    const list = foldComments(root());
    expect(list.map((c) => c.token)).toEqual(["<5>!", "<5.0:0-4>!", "<7.0:2-9>!"]);
    const mine = list.find((c) => c.id === added.id);
    expect(mine).toMatchObject({ turn: 2, at: at("<7.0:2-9>!") });
    expect(mine?.thread.map((e) => [e.by, e.text])).toEqual([["admin", "web comment"], ["admin", "web reply"]]);
    client.close();
  });

  it("returns the refusal when the form refuses a write", async () => {
    const { fake, client, writer, root } = world({});
    fake.refuseSet.set("r1", { code: -32020, message: "denied" });
    expect(await addComment(writer, root(), { at: at("<5>!"), text: "x" })).toMatchObject({ ok: false, refusal: { kind: "denied" } });
    client.close();
  });
});
