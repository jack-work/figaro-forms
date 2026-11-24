import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import { ariaFactsAtom, boundFormAtom, recentAtom, treeAtom } from "../../src/aria/jotai.js";
import { boundFormWriterOf } from "../../src/aria/bound-form.js";
import { foldRecent } from "../../src/aria/recent.js";
import { parseRoleAddresses } from "../../src/aria/tree.js";
import { FakeAria, settle, tick } from "./fake-aria.js";

function world() {
  const fake = new FakeAria();
  fake.addForm("@troupe", { n1: { self: true, form: "@arias" } });
  fake.addForm("@arias", {
    arias: {
      root: { id: "r1", state: "idle", mantra: "the trunk", active_at: 30, role: '@boss "two words"' },
      lone: { id: "l1", state: "dormant", active_at: 10 },
    },
  });
  fake.addForm("@recent", {
    old: { id: "o1", title: "old one", state: "idle", active_at: 10 },
    mid: { id: "m1", title: "mid one", state: "idle", active_at: 20 },
    top: { id: "t1", title: "top one", state: "active", active_at: 30 },
  });
  fake.addAria("r1");
  const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5, retryMinMs: 5, retryMaxMs: 10 });
  return { fake, client, store: createStore() };
}

describe("treeAtom", () => {
  it("folds @troupe and @arias into nodes, roots and roles", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    expect(treeAtom(client)).toBe(tree);
    const off = store.sub(tree, () => {});
    await settle();
    const t = store.get(tree);
    expect(t.ready).toBe(true);
    expect(t.roots).toEqual(["r1", "l1"]);
    expect(t.nodes.get("r1")).toMatchObject({ mantra: "the trunk", state: "idle", status: "live", daemon: "n1", roles: ["@boss", "two words"], handle: "root", children: [] });
    expect(t.daemons).toMatchObject([{ id: "n1", self: true, form: "@arias", phase: "ready" }]);
    off();
    await tick(40);
    expect(fake.calls.filter((c) => c.method === "figaro.unfollow").map((c) => c.params.figaro_id).sort()).toEqual(["@arias", "@troupe"]);
    client.close();
  });

  it("shows a fork under its parent as it happens", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    fake.formSet("@arias", ["arias", "root", "forks", "kid"], { id: "k1", state: "idle", parent: "r1", active_at: 40 });
    await settle();
    const t = store.get(tree);
    expect(t.nodes.get("r1")?.children).toEqual(["k1"]);
    expect(t.nodes.get("k1")).toMatchObject({ parent: "r1", handle: "kid" });
    expect(t.roots).toEqual(["r1", "l1"]);
    off();
    client.close();
  });

  it("re-reads @arias when it comes back as a new incarnation", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const reads = fake.formCalls("@arias");
    fake.formReincarnate("@arias", {
      arias: {
        root: { id: "r1", state: "idle", active_at: 30, forks: { kid: { id: "k1", state: "idle", parent: "r1", active_at: 40 } } },
        lone: { id: "l1", state: "dormant", active_at: 10 },
      },
    });
    await settle();
    expect(fake.formCalls("@arias")).toBe(reads + 1);
    const t = store.get(tree);
    expect(t.ready).toBe(true);
    expect(t.nodes.get("r1")?.children).toEqual(["k1"]);
    off();
    client.close();
  });

  it("refuses a schema 1 delta instead of reloading: the daemon speaks schema 2", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const reads = fake.formCalls("@arias");
    fake.formReincarnate("@arias", { arias: {} }, 1);
    await settle();
    expect(fake.formCalls("@arias")).toBe(reads);
    expect(store.get(tree).daemons[0]?.phase).toBe("incompatible");
    off();
    client.close();
  });

  it("trusts nesting for the parent when the row carries no parent key", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    fake.formSet("@arias", ["arias", "root", "forks", "kid"], { id: "k1", state: "idle" });
    await settle();
    expect(store.get(tree).nodes.get("k1")?.parent).toBe("r1");
    off();
    client.close();
  });

  it("draws an aria under the role form it is placed under, and the role row names its holder", async () => {
    const { fake, client, store } = world();
    fake.addForm("@arias", {
      arias: {
        "@eng-role": {
          id: "@er1",
          kind: "form",
          state: "form",
          name: "Engineer",
          target: "e1",
          active_at: 50,
          forks: { holder: { id: "e1", state: "idle", mantra: "Engineer", active_at: 50, parent: "@er1" } },
        },
      },
    });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const t = store.get(tree);
    expect(t.roots).toEqual(["@er1"]);
    expect(t.nodes.get("@er1")).toMatchObject({ kind: "role", roleName: "Engineer", target: "e1", children: ["e1"], handle: "@eng-role" });
    expect(t.nodes.get("e1")).toMatchObject({ kind: "aria", parent: "@er1" });
    off();
    client.close();
  });

  it("hides a row past its reap time like figaro list does, unless it is active or bound, and keeps its children", async () => {
    const { fake, client, store } = world();
    const past = Date.now() - 1000;
    fake.addForm("@arias", {
      arias: {
        gone: { id: "g1", state: "dormant", retired_at: 5, reaps_at: past, active_at: 5, forks: { kid: { id: "k1", state: "idle", active_at: 6 } } },
        busy: { id: "b1", state: "active", reaps_at: past, active_at: 4 },
        held: { id: "h1", state: "idle", bound: true, reaps_at: past, active_at: 3 },
      },
    });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const t = store.get(tree);
    expect(t.nodes.has("g1")).toBe(false);
    expect(t.reaped.has("g1")).toBe(false);
    expect(t.roots).toEqual(["k1", "b1", "h1"]);
    expect(t.nodes.get("k1")?.parent).toBeUndefined();
    off();
    client.close();
  });

  it("hides a row when its reap time arrives while the tree is open", async () => {
    const { fake, client, store } = world();
    fake.addForm("@arias", { arias: { soon: { id: "s1", state: "dormant", reaps_at: Date.now() + 80, active_at: 5 } } });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    expect(store.get(tree).nodes.has("s1")).toBe(true);
    for (let i = 0; i < 200 && store.get(tree).nodes.has("s1"); i++) await tick(10);
    const t = store.get(tree);
    expect(t.nodes.has("s1")).toBe(false);
    expect(t.reaped.has("s1")).toBe(false);
    off();
    client.close();
  });

  it("puts the daemon you are talking to first", async () => {
    const { fake, client, store } = world();
    fake.addForm("@troupe", { n1: { self: false, form: "n1/@arias" }, n9: { self: true, form: "@arias" } });
    fake.addForm("n1/@arias", { arias: { far: { id: "f1", state: "idle", active_at: 99 } } });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const t = store.get(tree);
    expect(t.daemons.map((d) => d.id)).toEqual(["n9", "n1"]);
    expect(t.roots).toEqual(["r1", "l1", "f1"]);
    off();
    client.close();
  });

  it("drops a daemon that leaves the troupe without calling its arias reaped", async () => {
    const { fake, client, store } = world();
    fake.addForm("n2/@arias", { arias: { far: { id: "f1", state: "idle", active_at: 1 } } });
    fake.formSet("@troupe", ["n2"], { self: false, form: "n2/@arias" });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    expect(store.get(tree).nodes.has("f1")).toBe(true);
    fake.formDelete("@troupe", ["n2"]);
    await settle();
    await tick(40);
    const t = store.get(tree);
    expect(t.nodes.has("f1")).toBe(false);
    expect(t.reaped.size).toBe(0);
    expect(t.daemons.map((d) => d.id)).toEqual(["n1"]);
    expect(fake.calls.some((c) => c.method === "figaro.unfollow" && c.params.figaro_id === "n2/@arias")).toBe(true);
    off();
    client.close();
  });

  it("orders siblings by last activity, newest first", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    fake.formSet("@arias", ["arias", "root", "forks", "a"], { id: "ka", state: "idle", active_at: 5 });
    fake.formSet("@arias", ["arias", "root", "forks", "b"], { id: "kb", state: "idle", active_at: 50 });
    await settle();
    expect(store.get(tree).nodes.get("r1")?.children).toEqual(["kb", "ka"]);
    fake.formSet("@arias", ["arias", "root", "forks", "a", "active_at"], 99);
    await settle();
    expect(store.get(tree).nodes.get("r1")?.children).toEqual(["ka", "kb"]);
    off();
    client.close();
  });

  it("marks a retire and then a reap as they land", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    fake.formSet("@arias", ["arias", "lone", "retired_at"], 123);
    await settle();
    expect(store.get(tree).nodes.get("l1")?.status).toBe("retired");
    fake.formDelete("@arias", ["arias", "lone"]);
    await settle();
    const t = store.get(tree);
    expect(t.nodes.has("l1")).toBe(false);
    expect(t.roots).toEqual(["r1"]);
    expect(t.reaped.get("l1")).toMatchObject({ status: "reaped", id: "l1" });
    off();
    client.close();
  });

  it("treats a row leaving a windowed @arias as gone, not reaped", async () => {
    const { fake, client, store } = world();
    fake.formSet("@arias", ["more"], 7);
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    expect(store.get(tree).more).toBe(7);
    expect(store.get(tree).daemons[0]?.more).toBe(7);
    expect(store.get(tree).nodes.has("l1")).toBe(true);
    fake.formDelete("@arias", ["arias", "lone"]);
    await settle();
    const t = store.get(tree);
    expect(t.nodes.has("l1")).toBe(false);
    expect(t.reaped.size).toBe(0);
    expect(t.roots).toEqual(["r1"]);
    off();
    client.close();
  });

  it("reaps again once the window closes", async () => {
    const { fake, client, store } = world();
    fake.formSet("@arias", ["more"], 2);
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    fake.formDelete("@arias", ["more"]);
    await settle();
    expect(store.get(tree).more).toBe(0);
    fake.formDelete("@arias", ["arias", "lone"]);
    await settle();
    expect(store.get(tree).reaped.get("l1")).toMatchObject({ status: "reaped" });
    off();
    client.close();
  });

  it("follows a second daemon that joins the troupe", async () => {
    const { fake, client, store } = world();
    fake.addForm("n2/@arias", { arias: { far: { id: "f1", state: "idle", active_at: 1 } } });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    expect(store.get(tree).nodes.has("f1")).toBe(false);
    fake.formSet("@troupe", ["n2"], { self: false, form: "n2/@arias" });
    await settle();
    const t = store.get(tree);
    expect(t.nodes.get("f1")?.daemon).toBe("n2");
    expect(t.daemons.map((d) => d.id)).toEqual(["n1", "n2"]);
    expect(t.roots).toEqual(["r1", "l1", "f1"]);
    off();
    client.close();
  });

  it("refetches on reconnect and forgets what it saw reaped", async () => {
    const { fake, client, store } = world();
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    fake.formDelete("@arias", ["arias", "lone"]);
    await settle();
    expect(store.get(tree).reaped.size).toBe(1);
    const before = fake.formCalls("@troupe") + fake.formCalls("@arias");
    fake.formSet("@arias", ["arias", "root", "mantra"], "changed while away");
    fake.drop();
    await settle(40);
    await tick(40);
    expect(fake.formCalls("@troupe") + fake.formCalls("@arias")).toBeGreaterThan(before);
    const t = store.get(tree);
    expect(t.freshness).toBe("current");
    expect(t.nodes.get("r1")?.mantra).toBe("changed while away");
    expect(t.reaped.size).toBe(0);
    off();
    client.close();
  });

  it("surfaces a refused @troupe as an error", async () => {
    const { fake, client, store } = world();
    fake.refuseForm.set("@troupe", { code: -32020, message: "figaro.form: @troupe is not yours to read" });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const t = store.get(tree);
    expect(t.ready).toBe(false);
    expect(t.error).toContain("not yours to read");
    expect(t.roots).toEqual([]);
    off();
    client.close();
  });

  it("surfaces a refused @arias under a good @troupe", async () => {
    const { fake, client, store } = world();
    fake.refuseForm.set("@arias", { code: -32020, message: "figaro.form: @arias denied" });
    const tree = treeAtom(client);
    const off = store.sub(tree, () => {});
    await settle();
    const t = store.get(tree);
    expect(t.error).toContain("denied");
    expect(t.daemons[0]).toMatchObject({ phase: "failed" });
    off();
    client.close();
  });
});

describe("recentAtom", () => {
  it("surfaces the root more count and keeps rows keyed by id", async () => {
    const { fake, client, store } = world();
    const recent = recentAtom(client);
    const off = store.sub(recent, () => {});
    await settle();
    expect(store.get(recent).more).toBe(0);
    fake.formSet("@recent", ["more"], 12);
    await settle();
    expect(store.get(recent).more).toBe(12);
    expect(store.get(recent).rows.map((r) => r.id)).toEqual(["t1", "m1", "o1"]);
    off();
    client.close();
  });

  it("lists newest first and reorders when a row is used", async () => {
    const { fake, client, store } = world();
    const recent = recentAtom(client);
    const off = store.sub(recent, () => {});
    await settle();
    expect(store.get(recent).rows.map((r) => r.id)).toEqual(["t1", "m1", "o1"]);
    expect(store.get(recent).rows[0]).toMatchObject({ title: "top one", state: "active", name: "top" });
    fake.formSet("@recent", ["old", "active_at"], 99);
    await settle();
    expect(store.get(recent).rows.map((r) => r.id)).toEqual(["o1", "t1", "m1"]);
    off();
    client.close();
  });

  it("breaks ties by id", () => {
    const rows = foldRecent({ b: { id: "b", title: "b", active_at: 5 }, a: { id: "a", title: "a", active_at: 5 }, z: { id: "z", title: "z" } });
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "z"]);
  });

  it("surfaces a refusal and refetches on reconnect", async () => {
    const { fake, client, store } = world();
    const recent = recentAtom(client);
    const off = store.sub(recent, () => {});
    await settle();
    const before = fake.formCalls("@recent");
    fake.formSet("@recent", ["mid", "active_at"], 70);
    fake.drop();
    await settle(40);
    await tick(40);
    expect(fake.formCalls("@recent")).toBeGreaterThan(before);
    expect(store.get(recent).rows[0]?.id).toBe("m1");
    off();
    client.close();
    const denied = world();
    denied.fake.refuseForm.set("@recent", { code: -32020, message: "recent denied" });
    const r2 = recentAtom(denied.client);
    const off2 = denied.store.sub(r2, () => {});
    await settle();
    expect(denied.store.get(r2).error).toContain("recent denied");
    off2();
    denied.client.close();
  });
});

describe("boundFormAtom", () => {
  it("loads the form and folds deltas", async () => {
    const { fake, client, store } = world();
    fake.addForm("r1", { mantra: "first", system: { thinking_effort: "high" } });
    const bound = boundFormAtom(client, "r1");
    expect(boundFormAtom(client, "r1")).toBe(bound);
    const off = store.sub(bound, () => {});
    await settle();
    expect(store.get(bound)).toMatchObject({ ready: true, aria: "r1", root: { mantra: "first", system: { thinking_effort: "high" } } });
    fake.formSet("r1", ["mantra"], "second");
    fake.formDelete("r1", ["system", "thinking_effort"]);
    await settle();
    const s = store.get(bound);
    expect(s.root.mantra).toBe("second");
    expect(s.root.system).toEqual({});
    expect(s.version).toBe(3);
    off();
    client.close();
  });

  it("reports a refused form", async () => {
    const { fake, client, store } = world();
    fake.addForm("r1", {});
    fake.refuseForm.set("r1", { code: -32020, message: "r1 is not yours" });
    const bound = boundFormAtom(client, "r1");
    const off = store.sub(bound, () => {});
    await settle();
    expect(store.get(bound).error).toContain("not yours");
    off();
    client.close();
  });

  it("writes and unsets a key on the bound form through figaro.set, and the atom follows", async () => {
    const { fake, client, store } = world();
    fake.addForm("r1", {});
    const bound = boundFormAtom(client, "r1");
    const off = store.sub(bound, () => {});
    await settle();
    const writer = boundFormWriterOf(client, "r1");
    const set = await writer.set("mantra", "new words");
    expect(set).toMatchObject({ ok: true });
    expect(fake.calls.filter((c) => c.method === "figaro.set" && c.params.figaro_id === "r1")).toHaveLength(1);
    await settle();
    expect(store.get(bound).root).toMatchObject({ mantra: "new words" });
    const unset = await writer.unset("mantra");
    expect(unset).toMatchObject({ ok: true });
    await settle();
    expect(store.get(bound).root).not.toHaveProperty("mantra");
    off();
    client.close();
  });

  it("reports a refused write as a refusal, not a throw", async () => {
    const { fake, client } = world();
    fake.addForm("r1", {});
    fake.refuseSet.set("r1", { code: -32020, message: "system.ttl is daemon/owner-held" });
    const r = await boundFormWriterOf(client, "r1").set("system.ttl", "1h");
    expect(r).toMatchObject({ ok: false, refusal: { kind: "denied" } });
    client.close();
  });
});

describe("ariaFactsAtom", () => {
  const reads = (fake: FakeAria, id: string): number => fake.reads.filter((r) => r.figaro_id === id).length;

  function offRoster() {
    const w = world();
    w.fake.rows = [{ id: "r1", state: "idle", mantra: "the trunk", message_count: 9 }];
    w.fake.addAria("l1");
    for (const n of [1, 2, 3]) w.fake.finishedTurn("l1", n, `q${n}`, []);
    w.fake.formSet("@arias", ["arias", "lone", "mantra"], "far from the first page");
    return w;
  }

  it("gives the mantra and turn count of an aria the roster page never listed", async () => {
    const { client, store } = offRoster();
    const facts = ariaFactsAtom(client, "l1");
    expect(ariaFactsAtom(client, "l1")).toBe(facts);
    const off = store.sub(facts, () => {});
    await settle();
    expect(store.get(facts)).toEqual({ aria: "l1", ready: true, mantra: "far from the first page", turns: 3, error: undefined });
    off();
    client.close();
  });

  it("recounts when the aria's @arias row shows activity, and takes a new mantra without a read", async () => {
    const { fake, client, store } = offRoster();
    const facts = ariaFactsAtom(client, "l1");
    const off = store.sub(facts, () => {});
    await settle();
    fake.finishedTurn("l1", 4, "q4", []);
    fake.formSet("@arias", ["arias", "lone", "active_at"], 50);
    await settle();
    expect(store.get(facts).turns).toBe(4);
    const before = reads(fake, "l1");
    fake.formSet("@arias", ["arias", "lone", "mantra"], "renamed");
    await settle();
    expect(store.get(facts).mantra).toBe("renamed");
    expect(reads(fake, "l1")).toBe(before);
    off();
    client.close();
  });

  it("reports a refused read as an error and keeps the mantra", async () => {
    const { fake, client, store } = offRoster();
    fake.refuseRead.set("l1", { code: -32020, message: "not yours" });
    const facts = ariaFactsAtom(client, "l1");
    const off = store.sub(facts, () => {});
    await settle();
    expect(store.get(facts)).toMatchObject({ ready: false, turns: undefined, error: "not yours", mantra: "far from the first page" });
    off();
    client.close();
  });
});

describe("parseRoleAddresses", () => {
  it("reads bare and quoted addresses", () => {
    expect(parseRoleAddresses(undefined)).toEqual([]);
    expect(parseRoleAddresses("@a @b/c")).toEqual(["@a", "@b/c"]);
    expect(parseRoleAddresses('@a "x y" "q\\"z"')).toEqual(["@a", "x y", 'q"z']);
  });
});
