import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import { ariaAtom, ariaEventAtom, ariaListAtom, ariaPhaseAtom } from "../../src/aria/jotai.js";
import { FakeAria, settle, tick } from "./fake-aria.js";

describe("aria atoms", () => {
  it("follow one aria while mounted, and let go after", async () => {
    const fake = new FakeAria();
    fake.addAria("a1");
    const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5 });
    const store = createStore();
    const snap = ariaAtom(client, "a1");
    expect(ariaAtom(client, "a1")).toBe(snap);
    const phase = ariaPhaseAtom(client, "a1");
    const tool = ariaEventAtom(client, "a1", "tool");
    let changes = 0;
    const offSnap = store.sub(snap, () => changes++);
    const offPhase = store.sub(phase, () => {});
    const offTool = store.sub(tool, () => {});
    await settle();
    expect(store.get(phase)).toBe("live");
    fake.openTurn("a1", 1, "hi");
    fake.update("a1", 1, [{ id: 0, set: { type: "tool", name: "bash", status: "running" } }]);
    await settle();
    expect(store.get(snap).turns[0]?.input?.text).toBe("hi");
    expect(store.get(tool)).toMatchObject({ type: "tool.start", tool: { name: "bash" } });
    expect(changes).toBeGreaterThan(0);
    offSnap();
    offPhase();
    offTool();
    await tick(40);
    expect(fake.calls.filter((c) => c.method === "figaro.unfollow")).toHaveLength(1);
    client.close();
  });

  it("list through an atom that refreshes when written", async () => {
    const fake = new FakeAria();
    fake.rows = [{ id: "a1", state: "idle" }];
    const client = new AriaClient({ dial: fake.dial });
    const store = createStore();
    const list = ariaListAtom(client);
    expect((await store.get(list)).rows).toHaveLength(1);
    fake.rows = [{ id: "a1", state: "idle" }, { id: "a2", state: "idle" }];
    store.set(list);
    expect((await store.get(list)).rows).toHaveLength(2);
    client.close();
  });
});
