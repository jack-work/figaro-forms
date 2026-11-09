import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { FormsClient, webSocketDial, type Replica } from "../src/index.js";

const runDir = process.env.FIGARO_FORMS_LIVE_RUNTIME;
const formId = process.env.FIGARO_FORMS_LIVE_FORM ?? "";
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function edge(webSock: string, user: string): Promise<string> {
  const srv = createServer((_req, res) => res.writeHead(404).end());
  srv.on("upgrade", (req, client: Duplex, head) => {
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith("remote-")) headers[k] = v;
    headers["remote-user"] = user;
    const up = request({ socketPath: webSock, path: req.url ?? "/", method: "GET", headers });
    up.on("upgrade", (res, sock, upHead) => {
      const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      client.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead.length) client.write(upHead);
      if (head.length) sock.write(head);
      sock.pipe(client).pipe(sock);
      sock.on("error", () => client.destroy());
      client.on("error", () => sock.destroy());
    });
    up.on("response", (res) => {
      client.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\nContent-Length: 0\r\n\r\n`);
    });
    up.on("error", () => client.destroy());
    up.end();
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise<void>((ok) => srv.close(() => ok())));
  const addr = srv.address();
  return `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/door`;
}

function until(r: Replica, pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const t = setTimeout(() => {
      off();
      reject(new Error(`timed out; form is ${JSON.stringify(r.root)}`));
    }, ms);
    const off = r.subscribe([], () => {
      if (!pred()) return;
      clearTimeout(t);
      off();
      resolve();
    });
  });
}

describe.skipIf(!runDir || !formId)("live: a dev daemon", () => {
  it("through the web door as the owner, edits land and a second writer's deltas arrive", async () => {
    const url = await edge(join(runDir as string, "web.sock"), "tester");
    const a = new FormsClient({ dial: webSocketDial({ url }), client: "live-a" });
    const b = new FormsClient({ dial: webSocketDial({ url }), client: "live-b" });
    cleanups.push(() => a.close(), () => b.close());
    const fa = a.form(formId);
    const fb = b.form(formId);
    await Promise.all([fa.ready(), fb.ready()]);
    expect(a.hello?.principal).toMatchObject({ kind: "user" });
    const stamp = `t${Date.now()}`;
    const res = await fa.set(["live", "stamp"], stamp);
    expect(res.ok).toBe(true);
    await until(fb, () => fb.get("live.stamp") === stamp);
    await fb.set("live.from_b", { n: 1, list: [1, 2] });
    await until(fa, () => (fa.get("live.from_b") as { n?: number } | undefined)?.n === 1);
    await fa.unset("live.from_b");
    await until(fb, () => fb.get("live.from_b") === undefined);
    expect(fa.status.version).toBe(fb.status.version);
    expect(fa.status.pending).toBe(0);
    expect(fa.root).toEqual(fb.root);
  });

  it("through the web door as a reader, a set is refused and rolled back", async () => {
    const url = await edge(join(runDir as string, "web.sock"), "reader");
    const c = new FormsClient({ dial: webSocketDial({ url }), client: "live-r" });
    cleanups.push(() => c.close());
    const f = c.form(formId);
    await f.ready();
    const before = f.get("title");
    const res = await f.set("title", "should not land");
    expect(res).toMatchObject({ ok: false, refusal: { key: "title", kind: "denied" } });
    expect(f.get("title")).toEqual(before);
  });

  it("reads the daemon's own catalogs and their view hints", async () => {
    const url = await edge(join(runDir as string, "web.sock"), "tester");
    const c = new FormsClient({ dial: webSocketDial({ url }), client: "live-c" });
    cleanups.push(() => c.close());
    const recent = c.form("@recent");
    const models = c.form("@models");
    await Promise.all([recent.ready(), models.ready()]);
    expect(recent.status.view?.rows).toEqual(["*"]);
    expect(models.status.view?.rows).toEqual(["*.models.*"]);
  });
});
