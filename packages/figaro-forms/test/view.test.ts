import { describe, expect, it } from "vitest";
import { FormsClient } from "../src/client.js";
import { flatten, matchPath, OpenState, resolveAction } from "../src/view/index.js";
import type { FormView } from "../src/wire.js";
import { FakeDoor, settle } from "./fake-door.js";

const arias: FormView = {
  rows: ["arias.*", "**.forks.*"],
  open: ["arias", "**.forks"],
  row_aria: "id",
  mount: "id",
  through: "forks",
  label: "mantra",
  sort: "-active_at",
  mark: { key: "id", key_subject: "aria_id" },
  overlay: { form: "@topology", key: "parent" },
  actions: [
    { key: "Enter", label: "attend", local: "attend" },
    { key: "x", label: "kill", method: "figaro.kill", confirm: true },
  ],
};

const models: FormView = {
  rows: ["*.models.*"],
  open: ["*", "*.models"],
  skip: "hidden",
  label: "name",
  mark: { group_subject: "system.provider", row_subject: "system.model" },
  actions: [{ key: "Enter", label: "use this model", method: "figaro.models.pick", target: "subject", args: { provider: "group", model: "row" } }],
};

describe("matchPath agrees with rpc.MatchPath", () => {
  it("captures the first star as the group only for a pattern with two stars ending in one", () => {
    expect(matchPath(["*.models.*"], ["copilot", "models", "opus"])).toEqual({ group: "copilot" });
    expect(matchPath(["arias.*"], ["arias", "x"])).toEqual({ group: "" });
    expect(matchPath(["**.forks.*"], ["arias", "a", "forks", "b"])).toEqual({ group: "" });
    expect(matchPath(["arias.*"], ["arias"])).toBeUndefined();
  });
});

describe("flatten", () => {
  const form = {
    arias: {
      a1: { id: "a1", mantra: "first", active_at: 10, forks: { f1: { id: "f1", mantra: "fork", active_at: 5 } } },
      a2: { id: "a2", mantra: "second", active_at: 20 },
    },
    note: "hi",
  };

  it("orders rows by the hint, opens what it says, and collapses the through key", () => {
    const rows = flatten(form, { view: arias, subject: { aria_id: "f1" } });
    expect(rows.map((r) => `${r.depth}:${r.key}`)).toEqual(["0:arias", "1:a2", "1:a1", "0:note"]);
    const opened = flatten(form, { view: arias, isOpen: (p) => (p.join(".") === "arias.a1" ? true : undefined), subject: { aria_id: "f1" } });
    expect(opened.map((r) => `${r.depth}:${r.key}`)).toEqual(["0:arias", "1:a2", "1:a1", "2:active_at", "2:id", "2:mantra", "2:f1", "0:note"]);
    const fork = opened.find((r) => r.key === "f1");
    expect(fork?.row).toMatchObject({ aria: "f1", label: "fork", marked: true, mount: "f1" });
  });

  it("takes the overlay's value for the row it names", () => {
    const rows = flatten(form, { view: { ...arias, overlay: { form: "@topology", key: "mantra" } }, overlay: { a2: "from topology" } });
    expect(rows.find((r) => r.key === "a2")?.row?.label).toBe("from topology");
  });

  it("skips hidden rows and marks the subject's model", () => {
    const m = { copilot: { models: { opus: { name: "Opus" }, old: { name: "Old", hidden: true } } } };
    const rows = flatten(m, { view: models, subject: { system: { provider: "copilot", model: "opus" } } });
    expect(rows.map((r) => r.key)).toEqual(["copilot", "models", "opus"]);
    const opus = rows.find((r) => r.key === "opus");
    expect(opus?.row).toMatchObject({ group: "copilot", name: "opus", label: "Opus", marked: true });
    const call = resolveAction(models.actions![0]!, opus!.row!, "aria-1");
    expect(call).toEqual({ kind: "call", method: "figaro.models.pick", params: { figaro_id: "aria-1", provider: "copilot", model: "opus" }, confirm: false, label: "use this model" });
  });

  it("shows only the top level of a form with no view hint until something is opened", () => {
    expect(flatten({ a: { b: 1 }, c: 2 }).map((r) => r.key)).toEqual(["a", "c"]);
  });
});

describe("OpenState", () => {
  it("syncs open paths across instances on one BroadcastChannel and seeds a late joiner", async () => {
    const name = `ff-${Math.random()}`;
    const one = new OpenState({ channel: name });
    one.set(["a", "x.y"], true);
    const two = new OpenState({ channel: name });
    await settle(10);
    expect(two.get(["a", "x.y"])).toBe(true);
    two.set(["b"], false);
    await settle(10);
    expect(one.get(["b"])).toBe(false);
    one.set(["a", "x.y"], null);
    await settle(10);
    expect(two.get(["a", "x.y"])).toBeUndefined();
    one.close();
    two.close();
  });

  it("does not reset when the form version moves", async () => {
    const door = new FakeDoor();
    door.add("@f1", { a: { b: 1 } });
    const client = new FormsClient({ dial: door.dial, client: "v1" });
    const f = client.form("@f1");
    await f.ready();
    const open = new OpenState();
    open.set(["a"], true);
    door.write("@f1", { object: { Delete: { a: { b: 1 } }, Set: { a: { c: 2 } } } });
    await settle();
    expect(flatten(f.root, { isOpen: open.isOpen }).map((r) => r.key)).toEqual(["a", "c"]);
    client.close();
  });
});
