import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FormsClient, webSocketDial } from "../../figaro-forms/src/index.js";
import { FakeDoor, settle } from "../../figaro-forms/test/fake-door.js";
import { startBridge, type Bridge } from "../src/bridge.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fakeDaemon(door: FakeDoor): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ffb-"));
  const path = join(dir, "angelus.sock");
  const srv: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    void door
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

async function bridge(door: FakeDoor, extra: Partial<Parameters<typeof startBridge>[0]> = {}): Promise<Bridge> {
  const b = await startBridge({ socket: await fakeDaemon(door), ...extra });
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

function rawUpgrade(doorUrl: string, host: string): Promise<number> {
  const u = new URL(doorUrl.replace(/^ws/, "http"));
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
    const door = new FakeDoor();
    door.add("@f1", { title: "demo" });
    const b = await bridge(door);
    const client = new FormsClient({ dial: webSocketDial({ url: b.doorUrl }), client: "b1", retryMinMs: 5 });
    cleanups.push(() => client.close());
    const f = client.form("@f1");
    await f.ready();
    expect(f.root).toEqual({ title: "demo" });
    expect(client.hello?.principal.id).toBe("gluck");
    door.write("@f1", { object: { Set: { more: 1 } } });
    await settle(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(f.get("more")).toBe(1);
    const res = await f.set("title", "edited");
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.refusal.reason).toContain("read-only bridge");
    expect(f.get("title")).toBe("demo");
    expect(door.forms.get("@f1")!.value).toEqual({ title: "demo", more: 1 });
  });

  it("lets edits through with --write", async () => {
    const door = new FakeDoor();
    door.add("@f1", { title: "demo" });
    const b = await bridge(door, { write: true });
    const client = new FormsClient({ dial: webSocketDial({ url: b.doorUrl }), client: "b2" });
    cleanups.push(() => client.close());
    const f = client.form("@f1");
    await f.ready();
    await expect(f.set("title", "edited")).resolves.toMatchObject({ ok: true });
    expect(door.forms.get("@f1")!.value).toEqual({ title: "edited" });
  });

  it("refuses an upgrade without the token, with a foreign origin, or for a rebound host", async () => {
    const door = new FakeDoor();
    door.add("@f1", {});
    const b = await bridge(door, { origins: ["http://127.0.0.1:8765"] });
    const bare = b.doorUrl.replace(/\?token=.*/, "");
    expect(await upgradeStatus(bare)).toBe("refused");
    expect(await upgradeStatus(`${bare}?token=wrong`)).toBe("refused");
    expect(await upgradeStatus(b.doorUrl, { Origin: "https://evil.example" })).toBe("refused");
    expect(await upgradeStatus(b.doorUrl, { Origin: "http://127.0.0.1:8765" })).toBe("open");
    expect(await rawUpgrade(b.doorUrl, "evil.example")).toBe(421);
    expect(await rawUpgrade(b.doorUrl, new URL(b.origin).host)).toBe(101);
    expect(await upgradeStatus(b.doorUrl)).toBe("open");
  });

  it("refuses to listen anywhere but loopback", async () => {
    await expect(startBridge({ socket: "/nonexistent", host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("serves a static page without escaping its root", async () => {
    const door = new FakeDoor();
    const dir = mkdtempSync(join(tmpdir(), "ffs-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<p>page</p>");
    await writeFile(join(dir, "assets", "a.js"), "1");
    const b = await bridge(door, { staticDir: dir });
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
    const door = new FakeDoor();
    const dir = mkdtempSync(join(tmpdir(), "fff-"));
    await writeFile(join(dir, "index.html"), "<p>page</p>");
    await writeFile(join(dir, "paper.pdf"), "%PDF-1.4");
    await writeFile(join(dir, "notes.tex"), "\\section{x}");
    const plain = await bridge(door, { staticDir: dir });
    expect((await fetch(`${plain.origin}/`)).headers.get("content-security-policy")).not.toContain("frame-src");
    const framed = await bridge(door, { staticDir: dir, frameOrigins: ["http://127.0.0.1:8765"] });
    expect((await fetch(`${framed.origin}/`)).headers.get("content-security-policy")).toContain("; frame-src http://127.0.0.1:8765");
    expect((await fetch(`${framed.origin}/paper.pdf`)).headers.get("content-type")).toBe("application/pdf");
    expect((await fetch(`${framed.origin}/notes.tex`)).headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(bridge(door, { staticDir: dir, frameOrigins: ["http://127.0.0.1:8765/path"] })).rejects.toThrow(/origin/);
    await expect(bridge(door, { staticDir: dir, frameOrigins: ["*"] })).rejects.toThrow(/URL|origin/);
    const port = new URL(framed.origin).port;
    await framed.close();
    await expect(bridge(door, { staticDir: dir, port: Number(port), frameOrigins: [`http://localhost:${port}`] })).rejects.toThrow(/own origin/);
  });
});

describe("figaro-forms-bridge under --write", () => {
  it("survives a malformed escape in a static path", async () => {
    const door = new FakeDoor();
    const dir = mkdtempSync(join(tmpdir(), "ffs-"));
    await writeFile(join(dir, "index.html"), "<p>page</p>");
    const b = await bridge(door, { staticDir: dir });
    expect((await fetch(`${b.origin}/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${b.origin}/`)).status).toBe(200);
  });

  it("refuses owner-held and daemon-written keys, outfits, and ambiguous shapes", async () => {
    const door = new FakeDoor();
    door.add("@f1", { title: "demo", system: { model: "m" } });
    const b = await bridge(door, { write: true });
    const s = await rawSession(b.doorUrl);
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
    expect(door.forms.get("@f1")!.value).toEqual({ title: "demo", system: { model: "m" } });
    expect((await set({ object: { Set: { notes: { a: 1 } } } })).error).toBeUndefined();
    expect((await s.call("form.create", { patch: { object: { Set: { title: "new" } } } })).error).toBeUndefined();
    expect(door.forms.get("@f1")!.value).toEqual({ title: "demo", system: { model: "m" }, notes: { a: 1 } });
  });

  it("lets owner-held keys through only with --write-system", async () => {
    const door = new FakeDoor();
    door.add("@f1", { system: { model: "m" } });
    const b = await bridge(door, { write: true, writeSystem: true });
    const s = await rawSession(b.doorUrl);
    cleanups.push(() => s.close());
    const r = await s.call("figaro.set", { figaro_id: "@f1", patch: { object: { Update: { system: { object: { Update: { model: { scalar: { Before: "m", After: "x" } } } } } } } } });
    expect(r.error).toBeUndefined();
    expect(door.forms.get("@f1")!.value).toEqual({ system: { model: "x" } });
    const odd = await s.call("figaro.set", { figaro_id: "@f1", Patch: {} });
    expect(odd.error?.message).toMatch(/unexpected key/);
  });
});
