import { describe, expect, it } from "vitest";
import { webCommands } from "figaro-forms/commands";
import { gatewayMethods } from "../src/methods.js";

describe("web commands", () => {
  it("call only methods the gateway passes", () => {
    const passed: readonly string[] = gatewayMethods;
    for (const [name, route] of Object.entries(webCommands)) {
      if (route.on !== "door") continue;
      for (const m of route.methods) expect(passed, `${name} calls ${m}`).toContain(m);
    }
  });
});
