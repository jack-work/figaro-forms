import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foldReview } from "../../src/aria/review.js";
import type { JsonObject } from "../../src/json.js";

const real = JSON.parse(readFileSync(new URL("./samples/review-form.json", import.meta.url), "utf8")) as JsonObject;

describe("foldReview on a snapshot of a real role form", () => {
  const review = foldReview(real);

  it("reads the scalars the notifier wrote", () => {
    expect(review.repo).toBe("jack-scratch");
    expect(review.cursor).toBe("2026-11-10T09:44:41Z");
    expect(review.open).toBe(2);
    expect(review.unread).toBe(0);
  });

  it("reports the scalar as written even where it disagrees with the thread keys", () => {
    expect(review.threads.filter((t) => !t.resolved)).toHaveLength(9);
    expect(review.open).not.toBe(review.threads.filter((t) => !t.resolved).length);
  });

  it("folds every thread key into a thread, in file and line order", () => {
    expect(review.threads).toHaveLength(9);
    const places = review.threads.map((t) => [t.file, t.line, t.id]);
    expect(places).toEqual([...places].sort((a, b) => (a[0] as string).localeCompare(b[0] as string) || (a[1] as number) - (b[1] as number) || (a[2] as string).localeCompare(b[2] as string)));
  });

  it("attaches each comment to its thread, oldest first, and keeps the count the notifier wrote", () => {
    const t = review.threads.find((x) => x.id === "efa3eb75f10a");
    expect(t?.comments.map((c) => c.id)).toEqual(["59f8b4df7cde", "58aa4b2caee4"]);
    expect(t?.comments.map((c) => c.kind)).toEqual(["thread", "comment"]);
    expect(t?.comments[0]?.by).toBe("admin ⟩ admin");
    expect(t?.n).toBeGreaterThanOrEqual(t?.comments.length ?? 0);
    const attached = review.threads.reduce((n, x) => n + x.comments.length, 0);
    expect(attached).toBe(Object.keys(real).filter((k) => k.startsWith("comment_")).length);
  });

  it("ignores keys that are not review keys", () => {
    expect(foldReview({ comments: { a: { at: "x" } }, thread_: { n: 1 }, comment_x: "no" }).threads).toEqual([]);
  });

  it("makes a thread of a comment whose thread key is missing", () => {
    const r = foldReview({ comment_c1: { thread: "t9", kind: "thread", by: "a", at: "2026-01-01T00:00:00Z", body: "hi", repo: "r", file: "f", line: 3, quote: "" } });
    expect(r.threads).toMatchObject([{ id: "t9", n: 1, file: "f", line: 3, resolved: false }]);
  });
});
