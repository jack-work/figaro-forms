import { describe, expect, it } from "vitest";
import { FormsClient } from "../src/client.js";
import { FakeDoor, settle } from "./fake-door.js";
import type { Replica } from "../src/replica.js";

function setup(seed: Record<string, unknown> = { title: "demo", a: { b: 1, c: 2 }, z: { y: 1 } }) {
  const door = new FakeDoor();
  door.add("@f1", seed as never);
  const client = new FormsClient({ dial: door.dial, client: "t1", retryMinMs: 1, retryMaxMs: 5, replica: { confirmTimeoutMs: 50 } });
  return { door, client };
}

function counter(r: Replica, path: string) {
  const c = { n: 0 };
  r.subscribe(path, () => c.n++);
  return c;
}

describe("FormsClient against a fake door", () => {
  it("follows before it reads, so no delta between the two is lost", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    const methods = door.conns[0]?.received.map((x) => x.method);
    expect(methods?.indexOf("figaro.follow")).toBeLessThan(methods?.indexOf("figaro.form") ?? -1);
    expect(f.root).toEqual({ title: "demo", a: { b: 1, c: 2 }, z: { y: 1 } });
    expect(f.status.phase).toBe("ready");
    client.close();
  });

  it("notifies only the subscribers whose path a remote delta touches", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    const root = counter(f, "");
    const a = counter(f, "a");
    const ab = counter(f, "a.b");
    const ac = counter(f, "a.c");
    const z = counter(f, "z");
    const zBefore = f.get("z");
    door.write("@f1", { object: { Update: { a: { object: { Update: { b: { scalar: { Before: 1, After: 5 } } } } } } } });
    await settle();
    expect(f.get("a.b")).toBe(5);
    expect([root.n, a.n, ab.n, ac.n, z.n]).toEqual([1, 1, 1, 0, 0]);
    expect(f.get("z")).toBe(zBefore);
    client.close();
  });

  it("replaces a whole subtree when one patch deletes then sets the same key", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    const ab = counter(f, "a.b");
    const z = counter(f, "z");
    door.write("@f1", { object: { Delete: { a: { b: 1, c: 2 } }, Set: { a: { q: true } } } });
    await settle();
    expect(f.get("a")).toEqual({ q: true });
    expect(ab.n).toBe(1);
    expect(z.n).toBe(0);
    client.close();
  });

  it("shows an edit at once and settles it when its own delta arrives", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    door.holdReplies = true;
    const done = f.set("title", "edited");
    expect(f.get("title")).toBe("edited");
    expect(f.status.pending).toBe(1);
    await settle();
    expect(f.status.pending).toBe(0);
    door.release();
    await expect(done).resolves.toEqual({ ok: true, version: 2 });
    expect(f.confirmed).toMatchObject({ title: "edited" });
    client.close();
  });

  it("rolls an edit back when the daemon refuses it, and says why", async () => {
    const { door, client } = setup();
    door.refuse = () => "remove \"nope\": no such key";
    const f = client.form("@f1");
    await f.ready();
    const title = counter(f, "title");
    const res = await f.set("title", "nope");
    expect(res.ok).toBe(false);
    expect(f.get("title")).toBe("demo");
    expect(title.n).toBe(2);
    expect(f.status.refusal?.reason).toContain("no such key");
    client.close();
  });

  it("refuses a denied key locally without sending anything", async () => {
    const { door, client } = setup();
    door.forms.get("@f1")!.access = { mode: "write", deny: [{ key: "system", kind: "system-managed", reason: "the daemon owns system.*", except: ["system.mood"] }] };
    const f = client.form("@f1");
    await f.ready();
    const sent = door.conns[0]!.received.length;
    const res = await f.set("system.model", "x");
    expect(res).toEqual({ ok: false, refusal: { key: "system.model", kind: "system-managed", reason: "the daemon owns system.*" } });
    expect(door.conns[0]!.received.length).toBe(sent);
    expect(f.get("system")).toBeUndefined();
    expect((await f.set("system.mood", "calm")).ok).toBe(true);
    client.close();
  });

  it("re-reads on a version gap and lands on the daemon's state", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    door.skipVersion("@f1", { object: { Set: { missed: 1 } } });
    door.write("@f1", { object: { Set: { seen: 2 } } });
    await settle();
    expect(f.root).toMatchObject({ missed: 1, seen: 2 });
    expect(f.status.version).toBe(3);
    client.close();
  });

  it("re-reads when the form is reincarnated", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    door.reincarnate("@f1", { fresh: true });
    door.write("@f1", { object: { Set: { more: 1 } } });
    await settle();
    expect(f.root).toEqual({ fresh: true, more: 1 });
    expect(f.status.incarnation).toBe(2);
    client.close();
  });

  it("survives a dropped connection mid-edit without applying the edit twice", async () => {
    const { door, client } = setup({ n: 0 });
    const f = client.form("@f1");
    await f.ready();
    door.holdReplies = true;
    const done = f.edit({ object: { Update: { n: { scalar: { Before: 0, After: 1 } } } } });
    await settle();
    door.drop();
    door.holdReplies = false;
    await settle(60);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(door.forms.get("@f1")!.version).toBe(2);
    expect(f.root).toEqual({ n: 1 });
    expect(f.status.pending).toBe(0);
    expect(door.dials).toBeGreaterThan(1);
    client.close();
  });

  it("retries a set the daemon calls unavailable", async () => {
    const { door, client } = setup();
    door.unavailable = 2;
    const f = client.form("@f1");
    await f.ready();
    await expect(f.set("title", "again")).resolves.toMatchObject({ ok: true });
    expect(door.forms.get("@f1")!.value).toMatchObject({ title: "again" });
    client.close();
  });

  it("stops tracking on a delta schema it cannot read", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    door.pushRaw("@f1", { schema: 3, aria_id: "@f1", version: 2, patch: {} });
    await settle();
    expect(f.status.phase).toBe("incompatible");
    client.close();
  });

  it("marks a killed form gone and keeps its last state", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    door.kill("@f1");
    await settle();
    expect(f.status.phase).toBe("gone");
    expect(f.get("title")).toBe("demo");
    client.close();
  });

  it("reconnects at once on door.lapsed and follows again", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    door.lapse();
    await settle(30);
    expect(door.dials).toBe(2);
    door.write("@f1", { object: { Set: { after: 1 } } });
    await settle();
    expect(f.get("after")).toBe(1);
    client.close();
  });

  it("routes an intrinsic delta to the intrinsic form only", async () => {
    const { door, client } = setup();
    const state = client.form("@f1");
    const runtime = client.form("@f1/runtime");
    await state.ready();
    await settle();
    door.pushRaw("@f1", { schema: 2, aria_id: "@f1", intrinsic: "runtime", version: 2, incarnation: 1, patch: { object: { Set: { busy: true } } } });
    await settle();
    expect(state.get("busy")).toBeUndefined();
    expect(runtime.status.phase).toBe("ready");
    client.close();
  });

  it("coalesces edits inside the debounce window into one set", async () => {
    const door = new FakeDoor();
    door.add("@f1", { a: 0, b: 0 });
    const client = new FormsClient({ dial: door.dial, client: "t1", replica: { debounceMs: 20 } });
    const f = client.form("@f1");
    await f.ready();
    const one = f.set("a", 1);
    const two = f.set("b", 2);
    const three = f.set("a", 3);
    expect(f.root).toEqual({ a: 3, b: 2 });
    await Promise.all([one, two, three]);
    const sets = door.conns[0]!.received.filter((x) => x.method === "figaro.set");
    expect(sets).toHaveLength(1);
    expect(door.forms.get("@f1")!.value).toEqual({ a: 3, b: 2 });
    client.close();
  });

  it("keeps the identity of every subtree a reload did not change", async () => {
    const { door, client } = setup();
    const f = client.form("@f1");
    await f.ready();
    const z = f.get("z");
    const a = f.get("a");
    door.skipVersion("@f1", { object: { Update: { a: { object: { Set: { d: 4 } } } } } });
    door.write("@f1", { object: { Set: { t: 1 } } });
    await settle();
    expect(f.get("z")).toBe(z);
    expect(f.get("a")).not.toBe(a);
    expect(f.get("a.d")).toBe(4);
    client.close();
  });

  it("creates an unbound form and edits it", async () => {
    const { client } = setup();
    const id = await client.create({ object: { Set: { hello: "world" } } });
    const f = client.form(id);
    await f.ready();
    expect(f.root).toEqual({ hello: "world" });
    await f.set("nested.deep.key", 1);
    expect(f.confirmed).toEqual({ hello: "world", nested: { deep: { key: 1 } } });
    await f.unset("nested.deep.key");
    expect(f.confirmed).toEqual({ hello: "world", nested: { deep: {} } });
    client.close();
  });

  it("continues the sequence of a client id the daemon has already seen", async () => {
    const { door, client } = setup();
    const first = client.form("@f1");
    await first.ready();
    await first.set("title", "one");
    await first.set("title", "two");
    client.close();
    const again = new FormsClient({ dial: door.dial, client: "t1" });
    const f = again.form("@f1");
    const early = f.set("title", "before ready");
    await f.ready();
    await expect(early).resolves.toMatchObject({ ok: true });
    await expect(f.set("title", "three")).resolves.toMatchObject({ ok: true });
    expect(door.forms.get("@f1")!.value).toMatchObject({ title: "three" });
    expect(door.forms.get("@f1")!.version).toBe(5);
    again.close();
  });

  it("fails a form the daemon does not have, without retrying forever", async () => {
    const { client } = setup();
    const f = client.form("@nope");
    await settle(40);
    expect(f.status.phase).toBe("failed");
    expect(f.status.error).toContain("no such form");
    client.close();
  });
});
