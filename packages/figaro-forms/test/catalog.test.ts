import { describe, expect, it } from "vitest";
import { commandBounds, commandDocs, pagerCommand, shellCommand } from "../src/commands.js";
import { pagerWebCommand, shellWebCommand, webCommandDocs } from "../src/catalog.js";

describe("web catalog", () => {
  it("projects the full catalog, in order, losing only what the composer does not read", () => {
    expect(webCommandDocs.map((c) => c.name)).toEqual(commandDocs.map((c) => c.name));
    for (const [i, slim] of webCommandDocs.entries()) {
      const full = commandDocs[i]!;
      const { min, max } = commandBounds(full);
      expect(slim, full.name).toEqual({
        name: full.name,
        ...(full.aliases && { aliases: full.aliases }),
        ...(full.pagerAliases && { pagerAliases: full.pagerAliases }),
        help: full.help,
        ...(full.usage && { usage: full.usage }),
        min,
        max,
        ...(full.hidden && { hidden: true }),
        ...(full.pagerOnly && { pagerOnly: true }),
        ...(full.complete && { complete: full.complete }),
        pager: full.pager,
        ...(full.refusal && { refusal: full.refusal }),
        ...(full.switches && { switches: true }),
      });
    }
  });

  it("resolves words as the full catalog does", () => {
    for (const c of commandDocs) {
      for (const word of [c.name, ...(c.aliases ?? []), ...(c.pagerAliases ?? [])]) {
        expect(shellWebCommand(word)?.name, word).toBe(shellCommand(word)?.name);
        expect(pagerWebCommand(word)?.name, word).toBe(pagerCommand(word)?.name);
      }
    }
  });
});
