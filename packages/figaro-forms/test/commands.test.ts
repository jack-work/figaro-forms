import { describe, expect, it } from "vitest";
import { commandBounds, commandDocs, pagerCommand, readsKeyboard, shellCommand } from "../src/commands.js";

describe("commands", () => {
  it("carries the verbs the web composer runs", () => {
    for (const word of ["fork", "new", "set", "ls", "listen", "send", "state", "kill", "notifications"]) {
      expect(pagerCommand(word), word).toBeDefined();
    }
  });

  it("resolves a pager word the way the pager does", () => {
    expect(pagerCommand("ls")?.name).toBe("list");
    expect(pagerCommand("s")?.name).toBe("send");
    expect(pagerCommand("history")?.name).toBe("history");
    expect(shellCommand("history")?.name).toBe("show");
    expect(shellCommand("notifications")).toBeUndefined();
    expect(pagerCommand("form")?.name).toBe("state");
  });

  it("says which verbs move the view to another aria", () => {
    const switching = commandDocs.filter((c) => c.switches).map((c) => c.name).sort();
    expect(switching).toEqual(["attend", "fork", "listen", "new"]);
  });

  it("gives a refused verb its reason", () => {
    for (const c of commandDocs) expect(c.pager === "refused", c.name).toBe(c.refusal !== undefined);
    expect(pagerCommand("import")?.refusal).toMatch(/standard input/);
  });

  it("counts positionals as the router does", () => {
    expect(commandBounds(shellCommand("set")!)).toEqual({ min: 2, max: 2 });
    expect(commandBounds(shellCommand("unset")!)).toEqual({ min: 1, max: 0 });
    expect(commandBounds(shellCommand("show")!)).toEqual({ min: 0, max: 1 });
  });

  it("marks the subverbs that read the keyboard", () => {
    expect(readsKeyboard(shellCommand("provider")!, "login")).toBe(true);
    expect(readsKeyboard(shellCommand("provider")!, "ls")).toBe(false);
  });
});
