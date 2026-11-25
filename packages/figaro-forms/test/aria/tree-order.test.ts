import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";
import { foldTree } from "../../src/aria/tree.js";

const troupe = { n1: { form: "@arias", self: true } } as JsonObject;

function fold(arias: JsonObject) {
  return foldTree(troupe, new Map([["n1", { root: { arias }, phase: "ready", error: undefined }]]), undefined, 0);
}

describe("the tree's order", () => {
  it("sorts siblings by the daemon's recency, so a role row rises with its holder", () => {
    const t = fold({
      older: { id: "a1", state: "idle", active_at: 100, recency: 100 },
      "@king": { id: "@king", kind: "form", name: "King", target: "k1", active_at: 50, recency: 900, forks: { holder: { id: "k1", state: "idle", active_at: 900, recency: 900 } } },
      newest: { id: "a2", state: "idle", active_at: 500, recency: 500 },
    });
    expect(t.roots).toEqual(["@king", "a2", "a1"]);
  });

  it("falls back to active_at for a daemon that sends no recency", () => {
    const t = fold({ a: { id: "a", state: "idle", active_at: 5 }, b: { id: "b", state: "idle", active_at: 9 } });
    expect(t.roots).toEqual(["b", "a"]);
  });

  it("keeps a node's own active_at", () => {
    const t = fold({ trunk: { id: "t1", state: "idle", active_at: 10, recency: 99 } });
    expect(t.nodes.get("t1")?.activeAt).toBe(10);
  });
});
