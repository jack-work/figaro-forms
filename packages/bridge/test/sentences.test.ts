import { describe, expect, it } from "vitest";
import { takeSentences } from "../src/sentences.js";

describe("takeSentences", () => {
  it("holds a sentence until its terminator is followed by space", () => {
    expect(takeSentences("Hello there", false)).toEqual({ ready: "", rest: "Hello there" });
    expect(takeSentences("Hello there.", false)).toEqual({ ready: "", rest: "Hello there." });
    expect(takeSentences("Hello there. And", false)).toEqual({ ready: "Hello there. ", rest: "And" });
  });

  it("does not cut inside a number or a dotted token", () => {
    expect(takeSentences("Pi is 3.14 roughly", false).ready).toBe("");
    expect(takeSentences("see a.b.c now", false).ready).toBe("");
  });

  it("cuts at a newline, and at the last space of a very long run", () => {
    expect(takeSentences("# Title\nbody", false)).toEqual({ ready: "# Title\n", rest: "body" });
    const long = "word ".repeat(50);
    const s = takeSentences(long, false);
    expect(s.ready.length).toBeGreaterThan(0);
    expect(s.ready + s.rest).toBe(long);
  });

  it("releases everything when final", () => {
    expect(takeSentences("tail without stop", true)).toEqual({ ready: "tail without stop", rest: "" });
  });
});
