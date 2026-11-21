import { describe, expect, it } from "vitest";
import { glyphDocs, glyphs } from "../src/glyphs.js";

const webNeeds = [
  "send",
  "steering",
  "tool.ok",
  "tool.error",
  "tool.running",
  "thinking",
  "delta",
  "fork",
  "head",
  "dead",
  "absent",
  "comment",
  "quote",
  "pit.queue",
  "pit.notifications",
  "pit.command",
  "pit.search",
  "pit.form",
  "pit.models",
  "pit.reaped",
  "pit.troupe",
  "pit.decision",
  "pit.login",
  "pit.queue.mark",
  "pit.notifications.mark",
  "pit.form.mark",
  "state.running",
  "state.here",
  "state.idle",
  "rule",
  "rule.double",
  "gutter",
];

describe("glyphs", () => {
  it("has every name the web renders", () => {
    for (const name of webNeeds) {
      expect(glyphs, name).toHaveProperty([name]);
    }
  });

  it("gives every name a non-empty symbol", () => {
    for (const [name, symbol] of Object.entries(glyphs)) {
      expect(symbol.length, name).toBeGreaterThan(0);
    }
  });

  it("documents exactly the names it exports", () => {
    expect(glyphDocs.map((d) => d.name).sort()).toEqual(Object.keys(glyphs).sort());
    for (const d of glyphDocs) expect(glyphs[d.name as keyof typeof glyphs]).toBe(d.symbol);
  });

  it("keeps the spinner frames in order", () => {
    expect([...glyphs["tool.running"]]).toHaveLength(10);
    expect(glyphs.thinking).toBe(glyphs["tool.running"]);
  });
});
