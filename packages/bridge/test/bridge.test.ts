import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FormsClient, webSocketDial } from "../../figaro-forms/src/index.js";
import { FakeDaemon, settle } from "../../figaro-forms/test/fake-daemon.js";
import { startBridge, type Bridge } from "../src/bridge.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fakeDaemon(daemon: FakeDaemon): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ffb-"));
  const path = join(dir, "angelus.sock");
  const srv: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    void daemon
      .dial({
        message: (frame) => sock.write(frame + "\n"),
        closed: () => sock.end(),
      })
      .then((s) => {
        sock.on("data", (chunk: string) => {
          buf += chunk;
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            s.send(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        });
        sock.on("close", () => s.close());
      });
  });
  await new Promise<void>((ok) => srv.listen(path, ok));
  cleanups.push(() => new Promise<void>((ok) => srv.close(() => ok())));
  return path;
}

async function bridge(daemon: FakeDaemon, extra: Partial<Parameters<typeof startBridge>[0]> = {}): Promise<Bridge> {
  const b = await startBridge({ socket: await fakeDaemon(daemon), ...extra });
  cleanups.push(() => b.close());
  return b;
}

async function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as never);
    ws.onopen = () => {
      ws.close();
      resolve("open");
    };
    ws.onerror = () => resolve("refused");
  });
}

function rawUpgrade(endpointUrl: string, host: string): Promise<number> {
  const u = new URL(endpointUrl.replace(/^ws/, "http"));
  return new Promise((resolve) => {
    const req = request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { Host: host, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") },
    });
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

describe("figaro-forms-bridge", () => {
  it("carries a FormsClient end to end, read-only by default", async () => {
    const daemon = new FakeDaemon();
    daemon.add("@f1", { title: "demo" });
    const b = await bridge(daemon);
    const client = new FormsClient({ dial: webSocketDial({ url: b.endpointUrl }), client: "b1", retryMinMs: 5 });
    cleanups.push(() => client.close());
    const f = client.retain("@f1");
    await f.ready();
    expect(f.root).toEqual({ title: "demo" });
    expect(client.hello?.principal.id).toBe("gluck");
    daemon.write("@f1", { object: { Set: { more: 1 } } });
    await settle(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(f.get("more")).toBe(1);
    const res = await f.set("title", "edited");
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.refusal.reason).toContain("read-only bridge");
    expect(f.get("title")).toBe("demo");
    expect(daemon.forms.get("@f1")!.value).toEqual({ title: "demo", more: 1 });
  });

  it("lets edits through with --write", async () => {
    const daemon = new FakeDaemon();
    daemon.add("@f1", { title: "demo" });
    const b = await bridge(daemon, { write: true });
    const client = new FormsClient({ dial: webSocketDial({ url: b.endpointUrl }), client: "b2" });
    cleanups.push(() => client.close());
    const f = client.retain("@f1");
    await f.ready();
    await expect(f.set("title", "edited")).resolves.toMatchObject({ ok: true });
    expect(daemon.forms.get("@f1")!.value).toEqual({ title: "edited" });
  });

  it("refuses an upgrade without the token, with a foreign origin, or for a rebound host", async () => {
    const daemon = new FakeDaemon();
    daemon.add("@f1", {});
    const b = await bridge(daemon, { origins: ["http://127.0.0.1:8765"] });
    const bare = b.endpointUrl.replace(/\?token=.*/, "");
    expect(await upgradeStatus(bare)).toBe("refused");
    expect(await upgradeStatus(`${bare}?token=wrong`)).toBe("refused");
    expect(await upgradeStatus(b.endpointUrl, { Origin: "https://evil.example" })).toBe("refused");
    expect(await upgradeStatus(b.endpointUrl, { Origin: "http://127.0.0.1:8765" })).toBe("open");
    expect(await rawUpgrade(b.endpointUrl, "evil.example")).toBe(421);
    expect(await rawUpgrade(b.endpointUrl, new URL(b.origin).host)).toBe(101);
    expect(await upgradeStatus(b.endpointUrl)).toBe("open");
  });

  it("refuses to listen anywhere but loopback", async () => {
    await expect(startBridge({ socket: "/nonexistent", host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("serves a static page without escaping its root", async () => {
    const daemon = new FakeDaemon();
    const dir = mkdtempSync(join(tmpdir(), "ffs-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<p>page</p>");
    await writeFile(join(dir, "assets", "a.js"), "1");
    const b = await bridge(daemon, { staticDir: dir });
    expect(b.pageUrl).toContain("#token=");
    const page = await fetch(`${b.origin}/`);
    expect(await page.text()).toBe("<p>page</p>");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await (await fetch(`${b.origin}/assets/a.js`)).text()).toBe("1");
    expect((await fetch(`${b.origin}/deep/link`)).status).toBe(404);
    const escape = await fetch(`${b.origin}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(escape.status);
    expect(await escape.text()).not.toContain("root:");
  });
});

async function rawSession(url: string) {
  const ws = new WebSocket(url);
  const replies = new Map<number, { result?: unknown; error?: { code: number; message: string } }>();
  const waiters = new Map<number, () => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { code: number; message: string } };
    if (typeof f.id !== "number") return;
    replies.set(f.id, f);
    waiters.get(f.id)?.();
  };
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error("no upgrade"));
  });
  let next = 1;
  return {
    call: (method: string, params: unknown) =>
      new Promise<{ result?: unknown; error?: { code: number; message: string } }>((ok) => {
        const id = next++;
        waiters.set(id, () => ok(replies.get(id)!));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }),
    close: () => ws.close(),
  };
}

describe("figaro-forms-bridge static serving", () => {
  it("frames only the origins it is given, never its own, and types PDFs and text", async () => {
    const daemon = new FakeDaemon();
    const dir = mkdtempSync(join(tmpdir(), "fff-"));
    await writeFile(join(dir, "index.html"), "<p>page</p>");
    await writeFile(join(dir, "paper.pdf"), "%PDF-1.4");
    await writeFile(join(dir, "notes.tex"), "\\section{x}");
    const plain = await bridge(daemon, { staticDir: dir });
    expect((await fetch(`${plain.origin}/`)).headers.get("content-security-policy")).not.toContain("frame-src");
    const framed = await bridge(daemon, { staticDir: dir, frameOrigins: ["http://127.0.0.1:8765"] });
    expect((await fetch(`${framed.origin}/`)).headers.get("content-security-policy")).toContain("; frame-src http://127.0.0.1:8765");
    expect((await fetch(`${framed.origin}/paper.pdf`)).headers.get("content-type")).toBe("application/pdf");
    expect((await fetch(`${framed.origin}/notes.tex`)).headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(bridge(daemon, { staticDir: dir, frameOrigins: ["http://127.0.0.1:8765/path"] })).rejects.toThrow(/origin/);
    await expect(bridge(daemon, { staticDir: dir, frameOrigins: ["*"] })).rejects.toThrow(/URL|origin/);
    await expect(
      bridge(daemon, { staticDir: dir, frameOrigins: ["http://127.0.0.1:8765"], origins: ["http://127.0.0.1:8765/"] }),
    ).rejects.toThrow(/both --frame-src and --origin/);
    const port = new URL(framed.origin).port;
    await framed.close();
    await expect(bridge(daemon, { staticDir: dir, port: Number(port), frameOrigins: [`http://localhost:${port}`] })).rejects.toThrow(/own origin/);
  });
});

describe("figaro-forms-bridge under --write", () => {
  it("survives a malformed escape in a static path", async () => {
    const daemon = new FakeDaemon();
    const dir = mkdtempSync(join(tmpdir(), "ffs-"));
    await writeFile(join(dir, "index.html"), "<p>page</p>");
    const b = await bridge(daemon, { staticDir: dir });
    expect((await fetch(`${b.origin}/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${b.origin}/`)).status).toBe(200);
  });

  it("refuses owner-held and daemon-written keys, outfits, and ambiguous shapes", async () => {
    const daemon = new FakeDaemon();
    daemon.add("@f1", { title: "demo", system: { model: "m" } });
    const b = await bridge(daemon, { write: true });
    const s = await rawSession(b.endpointUrl);
    cleanups.push(() => s.close());
    const set = (patch: unknown, extra: object = {}) => s.call("figaro.set", { figaro_id: "@f1", patch, ...extra });
    const refused: [string, Promise<{ error?: { message: string } }>][] = [
      ["nested system key", set({ object: { Update: { system: { object: { Update: { model: { scalar: { Before: "m", After: "x" } } } } } } } })],
      ["system subtree", set({ object: { Set: { system: { tools: [] } } } })],
      ["dotted literal", set({ object: { Set: { "system.provider": "evil" } } })],
      ["whole form", set({ scalar: { Before: null, After: { system: {} } } })],
      ["daemon-written", set({ object: { Set: { model: "x" } } })],
      ["outfits", set({ object: { Set: { a: 1 } } }, { outfits: ["anything"] })],
      ["case-folded field", s.call("figaro.set", { figaro_id: "@f1", Patch: { object: { Set: { system: {} } } } })],
      ["case-folded shape", set({ Object: { Set: { system: {} } } })],
      ["two shapes", set({ object: { Set: { a: 1 } }, scalar: { Before: null, After: {} } })],
      ["create with system", s.call("form.create", { patch: { object: { Set: { system: { provider: "evil" } } } } })],
    ];
    for (const [what, p] of refused) {
      const r = await p;
      expect(r.error?.message, what).toMatch(/^bridge: /);
    }
    expect(daemon.forms.get("@f1")!.value).toEqual({ title: "demo", system: { model: "m" } });
    expect((await set({ object: { Set: { memo: { a: 1 } } } })).error).toBeUndefined();
    expect((await s.call("form.create", { patch: { object: { Set: { title: "new" } } } })).error).toBeUndefined();
    expect(daemon.forms.get("@f1")!.value).toEqual({ title: "demo", system: { model: "m" }, memo: { a: 1 } });
  });

  it("lets owner-held keys through only with --write-system", async () => {
    const daemon = new FakeDaemon();
    daemon.add("@f1", { system: { model: "m" } });
    const b = await bridge(daemon, { write: true, writeSystem: true });
    const s = await rawSession(b.endpointUrl);
    cleanups.push(() => s.close());
    const r = await s.call("figaro.set", { figaro_id: "@f1", patch: { object: { Update: { system: { object: { Update: { model: { scalar: { Before: "m", After: "x" } } } } } } } } });
    expect(r.error).toBeUndefined();
    expect(daemon.forms.get("@f1")!.value).toEqual({ system: { model: "x" } });
    const odd = await s.call("figaro.set", { figaro_id: "@f1", Patch: {} });
    expect(odd.error?.message).toMatch(/unexpected key/);
  });
});

async function getHierarchy(b: Bridge, path = "/hierarchy", headers: Record<string, string> = {}, method = "GET"): Promise<{ code: number; body: unknown }> {
  const res = await fetch(`${b.origin}${path}`, { method, headers });
  const text = await res.text();
  return { code: res.status, body: text ? JSON.parse(text) : undefined };
}

function orderDaemon(): FakeDaemon {
  const daemon = new FakeDaemon();
  daemon.add("@king", { "role-name": "King", system: { key: "secret-system" } });
  daemon.add("@eng", { "role-name": "Engineer" });
  daemon.rows = [
    { id: "@king", kind: "form", state: "form", target_aria: "ak", parent: "" },
    { id: "@eng", kind: "form", state: "form", target_aria: "ae", parent: "@king" },
    { id: "ak", kind: "conversation", state: "active" },
    { id: "ae", kind: "conversation", state: "active" },
  ];
  return daemon;
}

describe("figaro-forms-bridge /hierarchy", () => {
  it("serves the caller's projection only to a bearer of the token", async () => {
    const b = await bridge(orderDaemon());
    const bearer = { Authorization: `Bearer ${b.token}` };
    const none = await getHierarchy(b);
    expect(none).toEqual({ code: 401, body: { status: "signedout", reason: expect.any(String) } });
    expect((await getHierarchy(b, "/hierarchy", { Authorization: "Bearer wrong" })).code).toBe(401);
    expect((await getHierarchy(b, "/hierarchy", bearer, "POST")).code).toBe(405);
    const ok = await getHierarchy(b, "/hierarchy", bearer);
    expect(ok.code).toBe(200);
    const body = ok.body as { status: string; orders: { root: string; forms: { id: string }[] }[] };
    expect(body.status).toBe("current");
    expect(body.orders.map((o) => [o.root, o.forms.map((f) => f.id)])).toEqual([["@king", ["@eng", "@king"]]]);
    expect(JSON.stringify(body)).not.toContain("secret-system");
    const one = await getHierarchy(b, "/hierarchy?root=%40eng", bearer);
    expect((one.body as typeof body).orders[0]?.root).toBe("@eng");
  });

  it("answers a refusal with no nodes", async () => {
    const daemon = orderDaemon();
    const b = await bridge(daemon);
    const bearer = { Authorization: `Bearer ${b.token}` };
    expect(await getHierarchy(b, "/hierarchy?root=%40hidden", bearer)).toEqual({ code: 403, body: { status: "denied", reason: expect.any(String) } });
    daemon.sees = () => false;
    expect(await getHierarchy(b, "/hierarchy", bearer)).toEqual({ code: 200, body: { status: "empty", observed_at: expect.any(Number) } });
    daemon.listDenied = "figaro.list: not yours";
    expect(await getHierarchy(b, "/hierarchy", bearer)).toEqual({ code: 403, body: { status: "denied", reason: "figaro.list: not yours" } });
  });

  it("refuses to listen off loopback, edge or not", async () => {
    await expect(startBridge({ socket: "/nonexistent", host: "0.0.0.0" })).rejects.toThrow(/loopback/);
    await expect(startBridge({ socket: "/nonexistent", host: "100.92.208.109", edge: { secret: "s".repeat(32), peers: ["127.0.0.1"], admin: "admin" } })).rejects.toThrow(/loopback/);
  });

  it("reports a missing daemon as unavailable", async () => {
    const b = await startBridge({ socket: join(mkdtempSync(join(tmpdir(), "ffn-")), "none.sock") });
    cleanups.push(() => b.close());
    const r = await getHierarchy(b, "/hierarchy", { Authorization: `Bearer ${b.token}` });
    expect(r).toEqual({ code: 503, body: { status: "unavailable", reason: expect.stringContaining("daemon socket") } });
  });
});
