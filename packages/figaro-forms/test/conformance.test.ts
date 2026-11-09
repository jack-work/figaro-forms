import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonical, type Json, type JsonObject } from "../src/json.js";
import { apply, applyRoot, inverse, isIdentity, tryMerge, type Patch } from "../src/patch.js";

const load = <T>(name: string): T[] =>
  JSON.parse(readFileSync(new URL(`${process.env.FORMS_VECTORS ?? "./vectors"}/${name}`, import.meta.url), "utf8")) as T[];

const wire = (v: unknown): string => canonical(JSON.parse(JSON.stringify(v)) as Json);

describe("patch semantics match figaro's Go api/form", () => {
  it("applies a patch to a form root as Snapshot.Apply does", () => {
    for (const c of load<{ base: JsonObject; patch: Patch; result: JsonObject }>("apply-root.json")) {
      expect(canonical(applyRoot(c.patch, c.base)), JSON.stringify(c)).toBe(canonical(c.result));
    }
  });

  it("applies a patch to any value as Patch.Apply does", () => {
    for (const c of load<{ base: Json; patch: Patch; result: Json }>("apply-value.json")) {
      expect(canonical(apply(c.patch, c.base)), JSON.stringify(c)).toBe(canonical(c.result));
    }
  });

  it("inverts a patch as Patch.Inverse does", () => {
    for (const c of load<{ patch: Patch; inverse: Patch }>("inverse.json")) {
      expect(wire(inverse(c.patch)), JSON.stringify(c.patch)).toBe(wire(c.inverse));
    }
  });

  it("merges two patches as TryMerge does, or refuses where it refuses", () => {
    for (const c of load<{ base: JsonObject; p: Patch; q: Patch; merged: Patch | null }>("trymerge.json")) {
      const got = tryMerge(c.p, c.q);
      if (c.merged === null) {
        expect(got, JSON.stringify(c)).toBeUndefined();
        continue;
      }
      expect(got).toBeDefined();
      expect(canonical(applyRoot(got as Patch, c.base)), JSON.stringify(c)).toBe(
        canonical(applyRoot(c.merged, c.base)),
      );
    }
  });

  it("calls a patch identity exactly when IsIdentity does", () => {
    for (const c of load<{ patch: Patch; identity: boolean }>("identity.json")) {
      expect(isIdentity(c.patch), JSON.stringify(c.patch)).toBe(c.identity);
    }
  });
});
