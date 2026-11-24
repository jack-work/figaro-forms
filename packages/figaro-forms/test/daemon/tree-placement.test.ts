import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/index.js";
import { treeFeedOf } from "../../src/aria/tree.js";
import { startDaemon, type Daemon } from "./daemon.js";

const bin = process.env.FIGARO_BIN;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!bin)("the web tree against a disposable figaro daemon (FIGARO_BIN)", () => {
  let daemon: Daemon;
  let client: AriaClient;

  beforeAll(async () => {
    daemon = await startDaemon(bin as string);
    client = new AriaClient({ dial: daemon.dial("gluck"), retryMinMs: 50, retryMaxMs: 200 });
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await daemon?.stop();
  }, 60_000);

  it("draws an aria where figaro place put it, and back at the top once the placement is unset", async () => {
    const parent = daemon.newAria("parent");
    const child = daemon.newAria("child");
    const feed = treeFeedOf(client);
    const off = feed.subscribe(() => {});
    const until = async (what: string, ok: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !ok(); i++) await sleep(50);
      expect(ok(), what).toBe(true);
    };
    const drawn = (): { under: string | undefined; top: boolean } => ({ under: feed.get().nodes.get(child)?.parent, top: feed.get().roots.includes(child) });
    await until("child at the top", () => drawn().top);

    daemon.figaro("place", child, "--under", parent);
    await until("child under parent", () => drawn().under === parent);
    expect(drawn().top).toBe(false);
    expect(feed.get().nodes.get(parent)?.children).toContain(child);

    daemon.figaro("form", "unset", "--id", "@topology", child);
    await until("child back at the top", () => drawn().top);
    off();
  });
});
