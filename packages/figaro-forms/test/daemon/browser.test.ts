import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startDaemon, type Daemon } from "./daemon.js";

const bin = process.env.FIGARO_BIN;
const chromiumPath = process.env.CHROMIUM ?? "/usr/bin/chromium";
const dist = fileURLToPath(new URL("../../../../apps/demo/dist", import.meta.url));
const ready = Boolean(bin) && existsSync(chromiumPath) && existsSync(join(dist, "aria.html"));
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

describe.skipIf(!ready)("the demo aria page in a real browser, through an edge that names the user", () => {
  let daemon: Daemon;
  let browser: Browser;
  let server: Server;
  let origin = "";

  beforeAll(async () => {
    daemon = await startDaemon(bin as string);
    server = createServer((req, res) => {
      const path = join(dist, new URL(req.url ?? "/", "http://x").pathname);
      if (!path.startsWith(dist) || !existsSync(path) || !extname(path)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, sock, head) => {
      if (req.url !== "/door") {
        sock.destroy();
        return;
      }
      wss.handleUpgrade(req, sock, head, (down) => {
        const up = new WebSocket(`ws+unix://${join(daemon.root, "run", "web.sock")}:/door`, { headers: { "Remote-User": "gluck" } });
        const held: string[] = [];
        up.on("open", () => held.splice(0).forEach((m) => up.send(m)));
        up.on("message", (m) => down.send(m.toString()));
        up.on("close", () => down.close());
        down.on("message", (m) => (up.readyState === WebSocket.OPEN ? up.send(m.toString()) : held.push(m.toString())));
        down.on("close", () => up.close());
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: chromiumPath });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    server?.close();
    await daemon?.stop();
  }, 60_000);

  it("shows history, streams a reply typed into the composer, and renders a tool call", async () => {
    const id = daemon.newAria("seed");
    await new Promise((r) => setTimeout(r, 800));
    const page = await (await browser.newContext()).newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    await page.goto(`${origin}/aria.html#aria=${id}`);
    await page.locator(".phase-live").waitFor({ timeout: 10_000 });
    expect(await page.locator(".turn .input pre").first().textContent()).toBe("seed");
    expect(await page.locator(".turn pre.prose").first().textContent()).toContain("Buongiorno, signore");

    await page.locator("textarea").fill("[tool] run it");
    await page.getByRole("button", { name: "send" }).click();
    await page.locator(".turn", { hasText: "[tool] run it" }).locator(".tool-ok").waitFor({ timeout: 15_000 });
    await page.locator(".turn", { hasText: "[tool] run it" }).locator(".end", { hasText: "done" }).waitFor({ timeout: 15_000 });
    const turn = page.locator(".turn", { hasText: "[tool] run it" });
    expect(await turn.locator(".tool-name").textContent()).toBe("bash");
    expect(await turn.locator(".tool-out").textContent()).toBe("tool-ran-ok");
    expect(await turn.locator("pre.prose").allTextContents()).toEqual(["Let me look. ", "The tool said tool-ran-ok. Done."]);
    expect(await page.locator(".status").textContent()).toContain("1 tools finished here");
    expect(problems).toEqual([]);
  }, 60_000);

  it("keeps the transcript whole across a reload by showing the tail again", async () => {
    const id = daemon.newAria("seed");
    await new Promise((r) => setTimeout(r, 800));
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/aria.html#aria=${id}`);
    await page.locator(".phase-live").waitFor({ timeout: 10_000 });
    await page.locator("textarea").fill("say hi");
    await page.getByRole("button", { name: "send" }).click();
    await page.locator(".turn", { hasText: "say hi" }).locator(".end", { hasText: "done" }).waitFor({ timeout: 15_000 });
    await page.reload();
    await page.locator(".phase-live").waitFor({ timeout: 10_000 });
    await page.locator(".turn", { hasText: "say hi" }).locator(".end", { hasText: "done" }).waitFor({ timeout: 10_000 });
    expect(await page.locator(".turn").count()).toBe(2);
  }, 60_000);
});
