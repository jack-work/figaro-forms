import { describe, expect, it } from "vitest";
import { commandBounds, commandDocs, hangupQueue, pagerCommand, readsKeyboard, shellCommand, webCommands } from "../src/commands.js";

describe("commands", () => {
  it("resolves a pager word the way the pager does", () => {
    expect(pagerCommand("ls")?.name).toBe("list");
    expect(pagerCommand("s")?.name).toBe("send");
    expect(pagerCommand("history")?.name).toBe("history");
    expect(shellCommand("history")?.name).toBe("show");
    expect(shellCommand("notifications")).toBeUndefined();
    expect(pagerCommand("form")?.name).toBe("state");
  });

  it("gives a refused verb its reason", () => {
    for (const c of commandDocs) expect(c.pager === "refused", c.name).toBe(c.refusal !== undefined);
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
  it("says why a command cannot run on the web", () => {
    for (const name of ["kill", "import", "login", "provider", "troupe", "succeed"] as const) {
      const r = webCommands[name];
      const why = r.on === "nowhere" ? r.reason : r.on === "door" ? r.limits : undefined;
      expect(why, name).toMatch(/\w/);
    }
  });

  it("names the pager's view form for each view the door can read", () => {
    for (const c of commandDocs) {
      const r = webCommands[c.name];
      if (c.pager === "view" && r.on === "door" && c.name !== "state") expect(r.form, c.name).toMatch(/^@/);
    }
  });

  it("clears the queue only when the command asks: cut, or hup -d", () => {
    expect(hangupQueue("hup", [])).toBe("keep");
    expect(hangupQueue("hup", ["@aria", "-j"])).toBe("keep");
    expect(hangupQueue("hup", ["--", "-d"])).toBe("keep");
    expect(hangupQueue("hup", ["-d"])).toBe("clear");
    expect(hangupQueue("hup", ["-jd", "@aria"])).toBe("clear");
    expect(hangupQueue("hup", ["@aria", "--drop-queued-messages"])).toBe("clear");
    expect(hangupQueue("cut", [])).toBe("clear");
  });
});
