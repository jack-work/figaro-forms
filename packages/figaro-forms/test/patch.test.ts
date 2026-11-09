import { describe, expect, it } from "vitest";
import { touchedKeys } from "../src/patch.js";

describe("touchedKeys", () => {
  it("names every path a patch can reach, whichever shape the daemon picks", () => {
    expect(touchedKeys({ scalar: { Before: null, After: {} }, object: { Set: { notes: 1 } } })).toEqual([[], ["notes"]]);
    expect(touchedKeys({ object: { Update: { a: { list: { Create: [] }, object: { Delete: { b: 1 } } } } } })).toEqual([["a"], ["a", "b"]]);
  });
});
