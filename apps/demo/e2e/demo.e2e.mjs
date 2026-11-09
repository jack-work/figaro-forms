import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startBridge } from "../../../packages/bridge/dist/bridge.js";

const run = process.env.FIGARO_FORMS_LIVE_RUNTIME;
if (!run) {
  process.stderr.write("demo e2e: set FIGARO_FORMS_LIVE_RUNTIME to a dev daemon's runtime dir\n");
  process.exit(2);
}

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const bridge = await startBridge({ socket: join(run, "angelus.sock"), staticDir: dist, write: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" });
const failures = [];
const check = (ok, what) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`);
  if (!ok) failures.push(what);
};

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(bridge.pageUrl);
  await page.locator(".conn-open").waitFor({ timeout: 5000 });
  check(true, "connects through the bridge");
  await page.locator(".phase-ready").waitFor({ timeout: 5000 });
  check((await page.locator(".ref").textContent()) === "@recent", "opens @recent first");

  await page.getByRole("button", { name: "new scratch form" }).click();
  await page.locator(".pick.on .pick-title", { hasText: "Scratch" }).waitFor({ timeout: 5000 });
  await page.locator(".phase-ready").waitFor({ timeout: 5000 });
  const ref = await page.locator(".ref").textContent();
  check(/^@[0-9a-f]+$/.test(ref ?? ""), `mints a scratch form (${ref})`);

  await page.locator(".node", { hasText: "title" }).locator("button.value").click();
  await page.locator("input.edit").fill("renamed");
  await page.locator("input.edit").press("Enter");
  await page.locator(".node", { hasText: "title" }).locator(".value", { hasText: "renamed" }).waitFor({ timeout: 5000 });
  await page.locator(".pending").waitFor({ state: "detached", timeout: 5000 });
  check(true, "an edit shows at once and settles");

  const hostile = '<img src=x onerror="window.__pwned=1">';
  await page.locator(".add input").nth(0).fill("hostile");
  await page.locator(".add input").nth(1).fill(JSON.stringify(hostile));
  await page.getByRole("button", { name: "set" }).click();
  await page.locator(".node", { hasText: "hostile" }).waitFor({ timeout: 5000 });
  const imgs = await page.locator(".tree img").count();
  const pwned = await page.evaluate(() => window.__pwned === 1);
  check(imgs === 0 && !pwned, "renders form values as text, never markup");

  await page.locator(".node", { hasText: "notes" }).locator("button.toggle").click();
  await page.locator(".node", { hasText: "first" }).waitFor({ timeout: 5000 });
  check(true, "opens a branch from UI state");

  const second = await context.newPage();
  await second.goto(bridge.pageUrl);
  await second.locator(".conn-open").waitFor({ timeout: 5000 });
  await second.locator("form.open input").fill(ref ?? "");
  await second.getByRole("button", { name: "open" }).click();
  await second.locator(".node", { hasText: "first" }).waitFor({ timeout: 5000 });
  check(true, "a second tab shares the open branch over BroadcastChannel");

  await second.locator(".node", { hasText: "count" }).locator("button.value").click();
  await second.locator("input.edit").fill("41");
  await second.locator("input.edit").press("Enter");
  await page.locator(".node", { hasText: "count" }).locator(".value", { hasText: "41" }).waitFor({ timeout: 5000 });
  check(true, "an edit in one tab arrives in the other as a delta");

  check(problems.filter((p) => /Content Security Policy|Refused to/.test(p)).length === 0, `no CSP violations (${problems.length} console errors)`);
  for (const p of problems) process.stdout.write(`     console: ${p}\n`);
} catch (e) {
  check(false, String(e).split("\n")[0]);
  for (const p of browser.contexts().flatMap((c) => c.pages())) {
    process.stdout.write(`     page ${p.url().replace(/#.*/, "")}: ${(await p.locator("body").innerText()).replace(/\s+/g, " ").slice(300, 1200)}\n`);
  }
} finally {
  await browser.close();
  await bridge.close();
}
process.exit(failures.length ? 1 : 0);
