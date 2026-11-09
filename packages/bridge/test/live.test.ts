import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FormsClient, webSocketDial } from "../../figaro-forms/src/index.js";
import { startBridge } from "../src/bridge.js";

const runDir = process.env.FIGARO_FORMS_LIVE_RUNTIME;
const formId = process.env.FIGARO_FORMS_LIVE_FORM ?? "";
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe.skipIf(!runDir || !formId)("live: the bridge on a dev daemon's CLI socket", () => {
  it("through the bridge on the CLI socket, read-only refuses before the daemon sees it", async () => {
    const br = await startBridge({ socket: join(runDir as string, "angelus.sock") });
    cleanups.push(() => br.close());
    const c = new FormsClient({ dial: webSocketDial({ url: br.doorUrl }), client: "live-br" });
    cleanups.push(() => c.close());
    const f = c.form(formId);
    await f.ready();
    expect(f.get("title")).toBe("demo");
    const res = await f.set("title", "nope");
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.refusal.reason).toContain("read-only bridge");
  });
});
