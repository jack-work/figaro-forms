import { describe, expect, it } from "vitest";
import { formatCursor, parseCursor, anchorOfCursor, compareCursors } from "../../src/aria/cursor.js";
import { diffText, spliceBytes, utf8Length } from "../../src/aria/utf8.js";

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

  it("diffs text into one splice that does not cut a surrogate pair", () => {
    expect(diffText("abc", "abc")).toBeUndefined();
    expect(diffText("abc", "abcd")).toEqual({ at: 3, del: 0, ins: "d" });
    expect(diffText("a😀", "a😁")).toEqual({ at: 1, del: 2, ins: "😁" });
    const s = diffText("hello world", "help world");
    expect(s && "hello world".slice(0, s.at) + s.ins + "hello world".slice(s.at + s.del)).toBe("help world");
  });
});

describe("cursors", () => {
  it("round-trip and refuse garbage", () => {
    expect(formatCursor({ turn: 12, pos: 3 })).toBe("12.3");
    expect(parseCursor("12.3")).toEqual({ turn: 12, pos: 3 });
    for (const bad of ["", "12", "a.b", "1.2.3", "-1.0", "1.-2", "99999999999999999999.0"]) expect(parseCursor(bad), bad).toBeUndefined();
  });

  it("resumes a read at the first node not yet settled", () => {
    expect(anchorOfCursor("5.0")).toEqual({ turn: 5, node: 0 });
    expect(anchorOfCursor("5.1")).toEqual({ turn: 5, node: 0 });
    expect(anchorOfCursor("5.4")).toEqual({ turn: 5, node: 3 });
    expect(anchorOfCursor("nope")).toBeUndefined();
  });

  it("orders by turn, then position", () => {
    expect(compareCursors("2.9", "3.0")).toBeLessThan(0);
    expect(compareCursors("3.2", "3.1")).toBeGreaterThan(0);
    expect(compareCursors("3.2", "3.2")).toBe(0);
  });
});
