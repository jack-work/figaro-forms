import { describe, expect, it } from "vitest";
import { spliceBytes, utf8Length } from "../../src/aria/utf8.js";

describe("byte-offset splices, as livedoc.Apply does them", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const go = (s: string, at: number, del: number, ins: string): string => {
    const b = enc.encode(s);
    const a = Math.min(Math.max(at, 0), b.length);
    const e = Math.min(Math.max(a + del, a), b.length);
    return dec.decode(b.slice(0, a)) + ins + dec.decode(b.slice(e));
  };

  it("appends at the byte length of text with accents, CJK and astral characters", () => {
    for (const s of ["", "abc", "señor", "日本語", "a😀b", "😀😀", "ñ日😀x"]) {
      expect(spliceBytes(s, utf8Length(s), 0, "!"), s).toBe(go(s, utf8Length(s), 0, "!"));
    }
  });

  it("replaces and deletes on rune boundaries", () => {
    const s = "señor 日本語 😀 end";
    for (const [at, del] of [[0, 2], [2, 2], [4, 1], [7, 3], [7, 6], [17, 4], [0, 100], [6, 0]] as const) {
      expect(spliceBytes(s, at, del, "·"), `${at},${del}`).toBe(go(s, at, del, "·"));
    }
  });

  it("clamps out-of-range offsets", () => {
    expect(spliceBytes("abc", 99, 5, "x")).toBe("abcx");
    expect(spliceBytes("abc", -4, 1, "x")).toBe("xbc");
  });
});
