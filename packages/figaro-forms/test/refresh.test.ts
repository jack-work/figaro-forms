import { afterEach, describe, expect, it, vi } from "vitest";
import { FormsClient } from "../src/client.js";
import { Replica, type FormTransport } from "../src/replica.js";
import { RpcError, type Dial, type SocketEvents } from "../src/rpc.js";
import type { FormDelta, FormResponse, SetRequest, SetResponse } from "../src/wire.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Deferred<T> = ReturnType<typeof deferred<T>>;

function replica() {
  const loads: Deferred<FormResponse>[] = [];
  const writes: { request: Omit<SetRequest, "figaro_id">; answer: Deferred<SetResponse> }[] = [];
  const transport: FormTransport = {
    load: () => {
      const d = deferred<FormResponse>();
      loads.push(d);
      return d.promise;
    },
    set: (request) => {
      const answer = deferred<SetResponse>();
      writes.push({ request, answer });
      return answer.promise;
    },
  };
  const r = new Replica("refresh-test", transport);
  return { r, loads, writes };
}

const seed = (version: number, name: string): FormResponse => ({
  snapshot: { name },
  version,
  incarnation: 0,
  access: { mode: "read" },
  view: { rows: ["*"] },
});

const delta = (version: number, name: string): FormDelta => ({
  schema: 2,
  version,
  incarnation: 0,
  patch: { object: { Set: { name } } },
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});

async function loaded(r: Replica, loads: Deferred<FormResponse>[], response: FormResponse) {
  r.reload();
  loads.at(-1)!.resolve(response);
  await r.ready();
}

describe("authorized replica refresh", () => {
  it("accepts a lower caller-projection version only after a new connection generation", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    await loaded(r, loads, seed(100, "old projection"));
    r.reload();
    loads.at(-1)!.resolve(seed(2, "same-generation regression"));
    await Promise.resolve();
    expect(r.root).toEqual({ name: "old projection" });
    expect(r.status.version).toBe(100);
    expect(r.status.freshness).toBe("resyncing");
    r.stale();
    expect(r.status.freshness).toBe("stale");
    expect(r.status.access).toBeUndefined();
    r.beginGeneration(3);
    expect(r.status.freshness).toBe("resyncing");
    await loaded(r, loads, seed(2, "new projection"));
    expect(r.root).toEqual({ name: "new projection" });
    expect(r.status).toMatchObject({ version: 2, generation: 3, freshness: "current" });
  });

  it("does not treat ready() as a once-ever readiness signal across reconnect", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    await loaded(r, loads, seed(20, "old"));
    r.stale();
    const ready = vi.fn();
    const waiting = r.ready().then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    r.beginGeneration(3);
    r.reload();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    loads.at(-1)!.resolve(seed(1, "new"));
    await waiting;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("ignores a successful old-generation read completed after the new seed", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    r.reload();
    const old = loads.at(-1)!;
    r.stale();
    r.beginGeneration(3);
    await loaded(r, loads, seed(1, "authorized now"));
    old.resolve(seed(999, "old authority"));
    await Promise.resolve();
    expect(r.root).toEqual({ name: "authorized now" });
    expect(r.status.version).toBe(1);
  });

  it("ignores old-generation failures, deltas and seed replies while the new read is pending", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    await loaded(r, loads, seed(50, "old"));
    r.reload();
    const old = loads.at(-1)!;
    r.stale();
    r.beginGeneration(3);
    r.reload();
    const current = loads.at(-1)!;
    old.reject(new RpcError(-32020, "old denial"));
    r.delta(delta(51, "old push"), 1);
    r.failed(new RpcError(-32020, "old follow denial"), 1);
    await Promise.resolve();
    expect(r.status).toMatchObject({ freshness: "resyncing", error: undefined });
    current.resolve(seed(1, "new"));
    await r.ready();
    expect(r.root).toEqual({ name: "new" });
  });

  it("replays a current-generation delta received before its seed reply", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    await loaded(r, loads, seed(70, "old"));
    r.stale();
    r.beginGeneration(3);
    r.reload();
    r.delta(delta(2, "after snapshot"), 3);
    loads.at(-1)!.resolve(seed(1, "snapshot"));
    await r.ready();
    expect(r.root).toEqual({ name: "after snapshot" });
    expect(r.status.version).toBe(2);
  });

  it("clears displayed data and access on read denial, and rejects readiness", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    await loaded(r, loads, seed(90, "private"));
    const displayed: unknown[] = [];
    r.subscribe([], () => displayed.push({ value: r.root, access: r.status.access, freshness: r.status.freshness }));
    r.stale();
    r.beginGeneration(3);
    r.reload();
    const ready = expect(r.ready()).rejects.toThrow("read denied");
    loads.at(-1)!.reject(new RpcError(-32020, "read denied"));
    await ready;
    expect(r.root).toEqual({});
    expect(r.confirmed).toEqual({});
    expect(r.status).toMatchObject({ phase: "failed", freshness: "stale", version: 0, access: undefined, view: undefined });
    expect(displayed.at(-1)).toEqual({ value: {}, access: undefined, freshness: "stale" });
    await expect(r.ready()).rejects.toThrow("read denied");
    r.delta(delta(91, "late secret"), 3);
    expect(r.root).toEqual({});
  });

  it("never promotes a delta-only response into the first authorized seed", async () => {
    vi.useFakeTimers();
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    r.reload();
    loads.at(-1)!.resolve({ delta: true, version: 2, patches: [{ version: 2, patch: delta(2, "partial").patch }] });
    await Promise.resolve();
    expect(r.status.freshness).toBe("resyncing");
    expect(r.root).toEqual({});
    await vi.advanceTimersByTimeAsync(50);
    loads.at(-1)!.resolve(seed(2, "complete"));
    await r.ready();
    expect(r.root).toEqual({ name: "complete" });
  });

  it("cannot repopulate a closed or denied replica from a delayed read", async () => {
    const { r, loads } = replica();
    r.beginGeneration(1);
    r.reload();
    const pending = loads.at(-1)!;
    r.failed(new RpcError(-32020, "follow denied"), 1);
    pending.resolve(seed(200, "late secret"));
    await Promise.resolve();
    expect(r.root).toEqual({});
    expect(r.status.phase).toBe("failed");
    r.beginGeneration(3);
    r.reload();
    const closePending = loads.at(-1)!;
    r.close();
    closePending.resolve(seed(201, "after close"));
    await Promise.resolve();
    expect(r.root).toEqual({});
  });

  it("cancels prior-generation recovery timers instead of reloading the new projection", async () => {
    vi.useFakeTimers();
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    r.reload();
    loads.at(-1)!.reject(new Error("transport lost"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    r.stale();
    r.beginGeneration(3);
    await loaded(r, loads, seed(1, "new"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(loads).toHaveLength(2);
    expect(r.status.freshness).toBe("current");
  });

  it("takes another full seed rather than publishing after its delta buffer overflows", async () => {
    const { r, loads } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    r.reload();
    for (let v = 2; v <= 1026; v++) r.delta(delta(v, `value ${v}`), 1);
    loads[0]!.resolve(seed(1, "too old"));
    await Promise.resolve();
    expect(r.status.freshness).toBe("resyncing");
    expect(r.root).toEqual({});
    expect(loads).toHaveLength(2);
    loads[1]!.resolve(seed(1026, "current"));
    await r.ready();
    expect(r.root).toEqual({ name: "current" });
  });

  it("does not let an old set response clear a new generation's pending write", async () => {
    const { r, loads, writes } = replica();
    cleanup.push(() => r.close());
    r.beginGeneration(1);
    await loaded(r, loads, { snapshot: {}, version: 1, origin: "me", access: { mode: "write" } });
    const edit = r.set("note", "pending");
    const old = writes.at(-1)!;
    r.stale();
    r.beginGeneration(3);
    await loaded(r, loads, { snapshot: {}, version: 1, origin: "me", access: { mode: "write" } });
    old.answer.resolve({ ok: true, outcome: "unchanged", version: 1 });
    await Promise.resolve();
    expect(r.status.pending).toBe(1);
    expect(writes).toHaveLength(2);
    r.delta({ ...delta(2, "unused"), origin: "me", seq: 1, patch: { object: { Set: { note: "pending" } } } }, 3);
    writes.at(-1)!.answer.resolve({ ok: true, outcome: "applied", version: 2 });
    await expect(edit).resolves.toEqual({ ok: true, version: 2 });
  });
});

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
  answered?: boolean;
}

class Door {
  readonly sockets: { events: SocketEvents; requests: Request[] }[] = [];
  readonly dial: Dial = async (events) => {
    const socket = { events, requests: [] as Request[] };
    this.sockets.push(socket);
    return {
      send: (frame) => socket.requests.push(JSON.parse(frame) as Request),
      close: () => {},
    };
  };

  answer(index: number, method: string, response: { result?: unknown; error?: { code: number; message: string } }) {
    const socket = this.sockets[index]!;
    const request = socket.requests.find((r) => r.method === method && !r.answered);
    expect(request, `missing ${method} on socket ${index}`).toBeDefined();
    request!.answered = true;
    socket.events.message(JSON.stringify({ jsonrpc: "2.0", id: request!.id, ...response }));
  }

  async open(index: number) {
    await vi.advanceTimersByTimeAsync(0);
    this.answer(index, "angelus.hello", { result: { version: 1, capabilities: ["follow.channels", "unfollow"], node: "n", principal: { kind: "user", id: "test" } } });
    await vi.advanceTimersByTimeAsync(0);
  }

  async follow(index: number) {
    this.answer(index, "figaro.follow", { result: { ok: true, figaro_id: "@topology" } });
    await vi.advanceTimersByTimeAsync(0);
  }
}

function client() {
  vi.useFakeTimers();
  const door = new Door();
  const c = new FormsClient({ dial: door.dial, retryMinMs: 10, retryMaxMs: 10 });
  cleanup.push(() => c.close());
  return { c, door };
}

describe("FormsClient refresh generations over JSON-RPC", () => {
  it("keeps open transport separate from a current projection, then accepts a lower seed", async () => {
    const { c, door } = client();
    const form = c.form("@topology");
    await door.open(0);
    await door.follow(0);
    door.answer(0, "figaro.form", { result: seed(100, "old") });
    await form.ready();
    const oldSocket = door.sockets[0]!;
    oldSocket.events.closed("daemon restarted");
    expect(form.status.freshness).toBe("stale");
    expect(c.hello).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    await door.open(1);
    expect(c.state).toBe("open");
    expect(form.status.freshness).toBe("resyncing");
    await door.follow(1);
    oldSocket.events.message(JSON.stringify({ jsonrpc: "2.0", method: "form.delta", params: { ...delta(101, "old push"), aria_id: "@topology" } }));
    door.answer(1, "figaro.form", { result: seed(1, "new") });
    await form.ready();
    expect(form.root).toEqual({ name: "new" });
    expect(form.status).toMatchObject({ freshness: "current", version: 1 });
    expect(door.sockets[1]!.requests.map((r) => r.method)).toEqual(["angelus.hello", "figaro.follow", "figaro.form"]);
  });

  it("fails closed when re-follow is denied, without requesting or retaining the old form", async () => {
    const { c, door } = client();
    const form = c.form("@topology");
    await door.open(0);
    await door.follow(0);
    door.answer(0, "figaro.form", { result: seed(100, "private") });
    await form.ready();
    door.sockets[0]!.events.closed("groups changed");
    await vi.advanceTimersByTimeAsync(20);
    await door.open(1);
    const ready = expect(form.ready()).rejects.toThrow("listen denied");
    door.answer(1, "figaro.follow", { error: { code: -32020, message: "listen denied" } });
    await ready;
    expect(form.root).toEqual({});
    expect(form.status.access).toBeUndefined();
    expect(door.sockets[1]!.requests.some((r) => r.method === "figaro.form")).toBe(false);
  });

  it("clears prior role authority on a denied read after follow succeeds", async () => {
    const { c, door } = client();
    const form = c.form("@topology");
    await door.open(0);
    await door.follow(0);
    door.answer(0, "figaro.form", { result: seed(100, "private") });
    await form.ready();
    door.sockets[0]!.events.closed("re-auth");
    await vi.advanceTimersByTimeAsync(20);
    await door.open(1);
    await door.follow(1);
    const ready = expect(form.ready()).rejects.toThrow("read denied");
    door.answer(1, "figaro.form", { error: { code: -32020, message: "read denied" } });
    await ready;
    expect(form.root).toEqual({});
    expect(form.confirmed).toEqual({});
    expect(form.status).toMatchObject({ freshness: "stale", access: undefined, view: undefined });
  });

  it("does not let a failed old hello tear down the replacement connection", async () => {
    const { c, door } = client();
    const form = c.form("@topology");
    await vi.advanceTimersByTimeAsync(0);
    door.sockets[0]!.events.closed("before hello replied");
    await vi.advanceTimersByTimeAsync(20);
    expect(door.sockets).toHaveLength(2);
    await door.open(1);
    expect(c.connection.epoch).toBe(3);
    door.answer(0, "angelus.hello", { result: { version: 1, capabilities: [], node: "old", principal: { kind: "user", id: "old" } } });
    await door.follow(1);
    door.answer(1, "figaro.form", { result: seed(1, "fresh") });
    await form.ready();
    expect(c.hello?.principal.id).toBe("test");
    expect(form.root).toEqual({ name: "fresh" });
  });

  it("does not accept an old follow completion as current after reconnect", async () => {
    const { c, door } = client();
    const form = c.form("@topology");
    await door.open(0);
    door.sockets[0]!.events.closed("before follow replied");
    await vi.advanceTimersByTimeAsync(20);
    await door.open(1);
    door.answer(0, "figaro.follow", { result: { ok: true, figaro_id: "@topology" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(door.sockets[1]!.requests.some((r) => r.method === "figaro.form")).toBe(false);
    await door.follow(1);
    door.answer(1, "figaro.form", { result: seed(1, "fresh") });
    await form.ready();
    expect(form.root).toEqual({ name: "fresh" });
  });
});
