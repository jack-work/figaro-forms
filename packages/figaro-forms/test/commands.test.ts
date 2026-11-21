import { describe, expect, it } from "vitest";
import { commandBounds, commandDocs, pagerCommand, readsKeyboard, shellCommand, webCommands } from "../src/commands.js";

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

describe("webCommands", () => {
  it("maps every command the catalog carries, and nothing else", () => {
    expect(Object.keys(webCommands).sort()).toEqual(commandDocs.map((c) => c.name).sort());
  });

  it("runs the composer's verbs through the door", () => {
    expect(webCommands.fork).toMatchObject({ on: "door", methods: expect.arrayContaining(["figaro.fork"]) });
    expect(webCommands.new).toMatchObject({ on: "door", methods: expect.arrayContaining(["figaro.create"]) });
    expect(webCommands.set).toMatchObject({ on: "door", methods: ["figaro.set"] });
    expect(webCommands.list).toMatchObject({ on: "door", form: "@troupe" });
  });

  it("says why a command cannot run on the web", () => {
    for (const name of ["kill", "import", "login", "provider", "troupe", "succeed"] as const) {
      const r = webCommands[name];
      const why = r.on === "nowhere" ? r.reason : r.on === "door" ? r.limits : undefined;
      expect(why, name).toMatch(/\w/);
    }
    expect(webCommands.kill).toMatchObject({ on: "nowhere", reason: expect.stringMatching(/delegated door/) });
  });

  it("names the pager's view form for each view the door can read", () => {
    for (const c of commandDocs) {
      const r = webCommands[c.name];
      if (c.pager === "view" && r.on === "door" && c.name !== "state") expect(r.form, c.name).toMatch(/^@/);
    }
  });
});
