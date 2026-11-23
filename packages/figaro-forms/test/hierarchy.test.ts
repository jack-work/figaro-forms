import { describe, expect, it } from "vitest";
import { Connection, RpcError } from "../src/rpc.js";
import { stateOf } from "../src/hierarchy/feed.js";
import { HierarchyFeed, hierarchyHttp, readHierarchy, type HierarchyReply, type HierarchyState } from "../src/hierarchy/index.js";
import { FakeDoor } from "./fake-door.js";

function door(): FakeDoor {
  const d = new FakeDoor();
  d.add("@king", { "role-name": "King", charter: "Governs.", "target-aria": "ak", system: { key: "secret-system" }, handoff: "/private/handoff" });
  d.add("@eng", { "role-name": "Engineer", lifecycle: { status: "active", note: "secret-note" }, "reports-to": "@king", owns: ["figaro"], lanes: { "aria-log": "fleet.lane.figaro.aria-log", bad: 7 } });
  d.add("@spy", { "role-name": "Hidden Seat", charter: "secret-charter" });
  d.add("@spyling", { "role-name": "Below Hidden" });
  d.add("@scratch", { name: "scratch" });
  d.rows = [
    { id: "@king", kind: "form", state: "form", handle: "@mahogany-apple", target_aria: "ak", parent: "" },
    { id: "@eng", kind: "form", state: "form", handle: "@urgent-dynamite", target_aria: "ae", parent: "@king" },
    { id: "@spy", kind: "form", state: "form", target_aria: "as", parent: "@king" },
    { id: "@spyling", kind: "form", state: "form", target_aria: "ae", parent: "@spy" },
    { id: "@scratch", kind: "form", state: "form", parent: "" },
    { id: "ak", kind: "conversation", state: "active", handle: "gimmick", mantra: "King: command" },
    { id: "ae", kind: "conversation", state: "active", handle: "lukewarm", mantra: "Engineer: issues" },
    { id: "as", kind: "conversation", state: "dormant", mantra: "secret-mantra" },
    { id: "w1", kind: "conversation", state: "active", parent: "ak", present: "ae", mantra: "worker" },
    { id: "w2", kind: "conversation", state: "dormant", parent: "w1" },
    { id: "gone", kind: "conversation", state: "dormant", parent: "ae", reaped_at: 5 },
    { id: "hid", kind: "conversation", state: "active", parent: "ae", mantra: "secret-hidden" },
  ];
  return d;
}

function caller(d: FakeDoor): (m: string, p: unknown) => Promise<unknown> {
  const conn = new Connection({ dial: d.dial, retryMinMs: 1, retryMaxMs: 1 });
  return (m, p) => conn.call(m, p);
}

const at = { now: () => 1234 };

describe("readHierarchy: the server decides what the caller sees", () => {
  it("serves the owner one order with only public keys", async () => {
    const d = door();
    const r = await readHierarchy(caller(d), at);
    expect(r.status).toBe("current");
    if (r.status !== "current") return;
    expect(r.orders.map((o) => o.root)).toEqual(["@king"]);
    const o = r.orders[0]!;
    expect(o.forms.map((f) => [f.id, f.parent])).toEqual([
      ["@eng", "@king"],
      ["@king", null],
      ["@spy", "@king"],
      ["@spyling", "@spy"],
    ]);
    expect(o.forms.find((f) => f.id === "@eng")?.state).toEqual({ "role-name": "Engineer", lifecycle: { status: "active" }, "reports-to": "@king", owns: ["figaro"], lanes: { "aria-log": "fleet.lane.figaro.aria-log" } });
    expect(o.topology).toEqual({ w1: "ae", w2: "w1", hid: "ae" });
    expect(o.arias.map((a) => a.id)).toEqual(["ae", "ak", "as", "hid", "w1", "w2"]);
    const text = JSON.stringify(r);
    for (const leak of ["secret-system", "/private/handoff", "secret-note", "target-aria", "gone", "@scratch"]) expect(text).not.toContain(leak);
  });

  it("draws a form under the form it was placed under", async () => {
    const d = door();
    d.add("@backend", { "role-name": "Backend" });
    d.rows.push({ id: "@backend", kind: "form", state: "form", target_aria: "ab", parent: "", present: "@king" });
    d.rows.push({ id: "ab", kind: "conversation", state: "active" });
    const r = await readHierarchy(caller(d), at);
    expect(r.status).toBe("current");
    if (r.status !== "current") return;
    expect(r.orders.map((o) => o.root)).toEqual(["@king"]);
    expect(r.orders[0]!.forms.find((f) => f.id === "@backend")?.parent).toBe("@king");
  });

  it("omits what the daemon hides, and every reference to it", async () => {
    const d = door();
    const hidden = new Set(["@king", "@spy", "@spyling", "ak", "as", "hid"]);
    d.sees = (id) => !hidden.has(id);
    const r = await readHierarchy(caller(d), at);
    expect(r.status).toBe("current");
    if (r.status !== "current") return;
    expect(r.orders.map((o) => o.root)).toEqual(["@eng"]);
    const o = r.orders[0]!;
    expect(o.forms).toEqual([{ id: "@eng", handle: "@urgent-dynamite", parent: null, target_aria: "ae", state: { "role-name": "Engineer", lifecycle: { status: "active" }, owns: ["figaro"], lanes: { "aria-log": "fleet.lane.figaro.aria-log" } } }]);
    expect(o.arias.map((a) => a.id)).toEqual(["ae", "w1", "w2"]);
    const text = JSON.stringify(r);
    for (const leak of hidden) expect(text).not.toContain(`"${leak}"`);
    for (const leak of ["secret-charter", "secret-mantra", "secret-hidden", "Hidden Seat"]) expect(text).not.toContain(leak);
  });

  it("gives a caller who may see nothing no nodes", async () => {
    const d = door();
    d.sees = () => false;
    expect(await readHierarchy(caller(d), at)).toEqual({ status: "empty", observed_at: 1234 });
  });

  it("gives a caller the daemon refuses no nodes", async () => {
    const d = door();
    d.listDenied = "figaro.list: not yours";
    const r = await readHierarchy(caller(d), at);
    expect(r).toEqual({ status: "denied", reason: "figaro.list: not yours" });
    expect(hierarchyHttp(r).code).toBe(403);
  });

  it("refuses a hidden root and a missing root alike", async () => {
    const d = door();
    d.sees = (id) => id !== "@spy";
    const hidden = await readHierarchy(caller(d), { ...at, root: "@spy" });
    const missing = await readHierarchy(caller(d), { ...at, root: "@nope" });
    expect(hidden.status).toBe("denied");
    expect(missing.status).toBe("denied");
    const visible = await readHierarchy(caller(d), { ...at, root: "@eng" });
    expect(visible.status === "current" && visible.orders[0]?.forms.map((f) => f.id)).toEqual(["@eng"]);
  });

  it("drops a listed form the caller may not read, with its subtree", async () => {
    const call = caller(door());
    const deny = (m: string, p: unknown): Promise<unknown> =>
      m === "figaro.form" && (p as { figaro_id: string }).figaro_id === "@spy" ? Promise.reject(new RpcError(-32020, "not yours")) : call(m, p);
    const r = await readHierarchy(deny, at);
    expect(r.status === "current" && r.orders[0]?.forms.map((f) => f.id)).toEqual(["@eng", "@king"]);
    expect(r.status === "current" && r.orders[0]?.arias.map((a) => a.id)).not.toContain("as");
  });

  it("reports an unreachable daemon as unavailable, not empty", async () => {
    const r = await readHierarchy(() => Promise.reject(new Error("socket closed")), at);
    expect(r).toEqual({ status: "unavailable", reason: "socket closed" });
    expect(hierarchyHttp(r).code).toBe(503);
  });
});

function reply(code: number, body: unknown): { status: number; json(): Promise<unknown> } {
  return { status: code, json: async () => body };
}

const current: HierarchyReply = {
  status: "current",
  observed_at: 1,
  orders: [{ root: "@king", forms: [{ id: "@king", parent: null, state: {} }], topology: {}, arias: [] }],
};

describe("HierarchyFeed: a refused refresh withdraws the whole tree", () => {
  it("empties the projection when a refresh is refused", async () => {
    const answers = [reply(200, current), reply(403, { status: "denied", reason: "no" })];
    const feed = new HierarchyFeed({ url: "/hierarchy", fetch: async () => answers.shift()! });
    const seen: HierarchyState[] = [];
    feed.subscribe((s) => seen.push(s));
    expect((await feed.refresh()).orders).toHaveLength(1);
    const after = await feed.refresh();
    expect(after).toEqual({ status: "denied", orders: [], reason: "no" });
    expect(seen.map((s) => [s.status, s.orders.length])).toEqual([
      ["loading", 0],
      ["current", 1],
      ["resyncing", 0],
      ["denied", 0],
    ]);
  });

  it("ignores an older refresh that answers after a refusal", async () => {
    let releaseOld!: () => void;
    const old = new Promise<void>((ok) => (releaseOld = ok));
    let n = 0;
    const feed = new HierarchyFeed({
      url: "/hierarchy",
      fetch: async () => {
        if (n++ === 0) {
          await old;
          return reply(200, current);
        }
        return reply(401, { status: "signedout", reason: "session ended" });
      },
    });
    const first = feed.refresh();
    await feed.refresh();
    releaseOld();
    await first;
    expect(feed.state).toEqual({ status: "signedout", orders: [], reason: "session ended" });
  });

  it("treats transport failure and malformed replies as unavailable with no nodes", async () => {
    const broken = new HierarchyFeed({ url: "/h", fetch: () => Promise.reject(new Error("offline")) });
    expect(await broken.refresh()).toEqual({ status: "unavailable", orders: [], reason: "offline" });
    expect(stateOf(200, { status: "current", observed_at: 1, orders: [{ root: "@x", forms: [], topology: {}, arias: [] }] }).status).toBe("unavailable");
    expect(stateOf(200, { status: "current", observed_at: 1, orders: [] }).status).toBe("unavailable");
    expect(stateOf(200, { status: "empty", observed_at: 2 })).toEqual({ status: "empty", orders: [], observedAt: 2 });
    expect(stateOf(500, current).orders).toEqual([]);
    expect(stateOf(403, current)).toEqual({ status: "denied", orders: [] });
  });

  it("withdraws on demand and stays closed", async () => {
    const feed = new HierarchyFeed({ url: "/h", fetch: async () => reply(200, current) });
    await feed.refresh();
    feed.withdraw();
    expect(feed.state).toEqual({ status: "signedout", orders: [] });
    feed.close();
    expect((await feed.refresh()).status).toBe("closed");
  });
});
