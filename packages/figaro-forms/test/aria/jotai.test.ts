import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import { ariaAtom, ariaConnectionAtom, ariaFrameAtom, ariaListAtom, ariaPhaseAtom, ariaRosterAtom } from "../../src/aria/jotai.js";
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
    const frame = ariaFrameAtom(client, "a1");
    let changes = 0;
    const offSnap = store.sub(snap, () => changes++);
    const offPhase = store.sub(phase, () => {});
    const offFrame = store.sub(frame, () => {});
    await settle();
    expect(store.get(phase)).toBe("live");
    fake.openTurn("a1", 1, "hi");
    fake.update("a1", 1, [{ id: 0, set: { type: "tool", name: "bash", status: "running" } }]);
    await settle();
    expect(store.get(snap).view.open?.inquiry).toBe("hi");
    expect(store.get(frame)?.nodes[0]).toMatchObject({ node: { type: "tool", name: "bash" } });
    expect(changes).toBeGreaterThan(0);
    offSnap();
    offPhase();
    offFrame();
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

  it("report the connection as it opens, drops and reopens", async () => {
    const fake = new FakeAria();
    const client = new AriaClient({ dial: fake.dial, retryMinMs: 5, retryMaxMs: 5 });
    const store = createStore();
    const conn = ariaConnectionAtom(client);
    expect(ariaConnectionAtom(client)).toBe(conn);
    const seen: string[] = [];
    const off = store.sub(conn, () => seen.push(store.get(conn)));
    await settle();
    expect(store.get(conn)).toBe("open");
    fake.drop();
    await tick(2);
    expect(store.get(conn)).toBe("waiting");
    await tick(40);
    expect(store.get(conn)).toBe("open");
    expect(seen).toEqual(["open", "waiting", "connecting", "open"]);
    off();
    client.close();
  });

  it("reads open when the socket opened after the first read and before the mount", async () => {
    const fake = new FakeAria();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = new AriaClient({ dial: async (events) => (await gate, fake.dial(events)) });
    const opened = new Promise<void>((resolve) => {
      const off = client.connection.onState((s) => s === "open" && (off(), resolve()));
    });
    const store = createStore();
    const conn = ariaConnectionAtom(client);
    expect(store.get(conn)).toBe("connecting");
    release();
    await opened;
    const off = store.sub(conn, () => {});
    expect(store.get(conn)).toBe("open");
    off();
    client.close();
  });

  describe("roster", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, state: "idle" }));

    it("loads a page on mount and appends the next on more", async () => {
      const fake = new FakeAria();
      fake.rows = rows(5);
      const client = new AriaClient({ dial: fake.dial });
      const store = createStore();
      const roster = ariaRosterAtom(client, { limit: 2 });
      expect(ariaRosterAtom(client, { limit: 2 })).toBe(roster);
      expect(ariaRosterAtom(client, { limit: 3 })).not.toBe(roster);
      expect(store.get(roster)).toMatchObject({ rows: [], loading: true });
      const off = store.sub(roster, () => {});
      await settle();
      expect(store.get(roster)).toMatchObject({ loading: false, next: "a2", refused: 0, error: undefined });
      expect(store.get(roster).rows.map((r) => r.id)).toEqual(["a1", "a2"]);
      await store.set(roster, "more");
      expect(store.get(roster).rows.map((r) => r.id)).toEqual(["a1", "a2", "a3", "a4"]);
      await store.set(roster, "more");
      expect(store.get(roster).rows.map((r) => r.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
      expect(store.get(roster).next).toBeUndefined();
      const before = fake.calls.filter((c) => c.method === "figaro.list").length;
      await store.set(roster, "more");
      expect(fake.calls.filter((c) => c.method === "figaro.list")).toHaveLength(before);
      off();
      client.close();
    });

    it("ask for one page at a time when more is pressed twice", async () => {
      const fake = new FakeAria();
      fake.rows = rows(6);
      const client = new AriaClient({ dial: fake.dial });
      const store = createStore();
      const roster = ariaRosterAtom(client, { limit: 2 });
      const off = store.sub(roster, () => {});
      await settle();
      await Promise.all([store.set(roster, "more"), store.set(roster, "more")]);
      expect(store.get(roster).rows.map((r) => r.id)).toEqual(["a1", "a2", "a3", "a4"]);
      off();
      client.close();
    });

    it("replace the rows on refresh and say what policy hid", async () => {
      const fake = new FakeAria();
      fake.rows = rows(3);
      fake.listRefused = 2;
      const client = new AriaClient({ dial: fake.dial });
      const store = createStore();
      const roster = ariaRosterAtom(client, { limit: 2 });
      const off = store.sub(roster, () => {});
      await settle();
      await store.set(roster, "more");
      expect(store.get(roster)).toMatchObject({ refused: 2, refusedWhy: "policy" });
      fake.rows = [{ id: "z1", state: "idle" }];
      fake.listRefused = 0;
      await store.set(roster, "refresh");
      expect(store.get(roster).rows.map((r) => r.id)).toEqual(["z1"]);
      expect(store.get(roster)).toMatchObject({ refused: 0, refusedWhy: undefined, next: undefined });
      off();
      client.close();
    });

    it("keep the rows and carry the error when a call fails", async () => {
      const fake = new FakeAria();
      fake.rows = rows(2);
      const client = new AriaClient({ dial: fake.dial });
      const store = createStore();
      const roster = ariaRosterAtom(client);
      const off = store.sub(roster, () => {});
      await settle();
      expect(store.get(roster).rows).toHaveLength(2);
      const list = client.list.bind(client);
      client.list = () => Promise.reject(new Error("no route"));
      await store.set(roster, "refresh");
      expect(store.get(roster)).toMatchObject({ loading: false });
      expect(store.get(roster).rows).toHaveLength(2);
      expect(String(store.get(roster).error)).toContain("no route");
      client.list = list;
      await store.set(roster, "refresh");
      expect(store.get(roster).error).toBeUndefined();
      off();
      client.close();
    });

    it("refetch when the connection reopens", async () => {
      const fake = new FakeAria();
      fake.rows = rows(1);
      const client = new AriaClient({ dial: fake.dial, retryMinMs: 5, retryMaxMs: 5 });
      const store = createStore();
      const roster = ariaRosterAtom(client, { limit: 2 });
      const off = store.sub(roster, () => {});
      await settle();
      expect(store.get(roster).rows).toHaveLength(1);
      fake.rows = rows(2);
      fake.drop();
      await tick(40);
      expect(store.get(roster).rows).toHaveLength(2);
      off();
      client.close();
    });

    it("drop a refresh that a later one overtook", async () => {
      const fake = new FakeAria();
      fake.rows = rows(1);
      const client = new AriaClient({ dial: fake.dial });
      const store = createStore();
      const roster = ariaRosterAtom(client);
      const off = store.sub(roster, () => {});
      await settle();
      const slow = client.list.bind(client);
      let release: () => void = () => {};
      client.list = async (o) => {
        const got = await slow(o);
        await new Promise<void>((r) => (release = r));
        return got;
      };
      const first = store.set(roster, "refresh");
      await settle();
      fake.rows = rows(3);
      client.list = slow;
      await store.set(roster, "refresh");
      release();
      await first;
      expect(store.get(roster).rows).toHaveLength(3);
      off();
      client.close();
    });
  });
});
