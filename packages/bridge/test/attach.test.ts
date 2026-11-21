import { execFileSync } from "node:child_process";
import { request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAria, tick } from "../../figaro-forms/test/aria/fake-aria.js";
import { AttachError, AttachStore, fold, maxImageEdge, sniff, systemTools, type ImageFormat, type Tools } from "../src/attach.js";
import { startGateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { startFakeSpeech } from "./fake-speech.js";

const id = "0123456789abcdef0123456789abcdef";
const secret = "s".repeat(40);
const good = { "x-figaro-edge": secret, "remote-user": "gluck" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.from("heic-body")]);
const pdf = Buffer.from("%PDF-1.4 text");
const scan = Buffer.from("%PDF-1.4 scan");

function fakeTools(): Tools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    picture: async (data: Buffer, from: ImageFormat) => {
      calls.push(`picture ${from}`);
      if (data.includes("broken")) throw new Error("magick failed");
      return { mime: from === "png" ? "image/png" : "image/jpeg", data: Buffer.from(`scaled ${from}`) };
    },
    pdfText: async (data: Buffer) => {
      calls.push("pdfText");
      return data.equals(scan) ? { text: "\f", pages: 6 } : { text: "Invoice 4471 total 93.50\n", pages: 2 };
    },
    pdfPages: async (_data: Buffer, pages: number) => {
      calls.push(`pdfPages ${pages}`);
      return Array.from({ length: pages }, (_, i) => Buffer.from(`page ${i + 1}`));
    },
  };
}

async function rig(store: AttachStore | undefined): Promise<{ fake: FakeAria; port: number; lines: string[] }> {
  const fake = new FakeAria();
  fake.addAria(id);
  fake.answers.set("figaro.qua", { ok: true, cursor: 1 });
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const lines: string[] = [];
  const gw = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => fake.dial,
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    log: (l) => lines.push(l),
    ...(store ? { attachments: store } : {}),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { fake, port: typeof addr === "object" && addr ? addr.port : 0, lines };
}

function upload(port: number, body: Buffer, headers: Record<string, string> = {}, method = "POST"): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", method, path: "/attach", agent: false, headers: { ...good, "content-type": "application/octet-stream", ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let j: Record<string, unknown> = {};
        try {
          j = JSON.parse(b) as Record<string, unknown>;
        } catch {}
        ok({ status: res.statusCode ?? 0, body: j });
      });
    });
    req.on("error", (e) => (["ECONNRESET", "EPIPE"].includes((e as NodeJS.ErrnoException).code ?? "") && headers["transfer-encoding"] === "chunked" ? undefined : fail(e)));
    if (headers["transfer-encoding"] === "chunked") {
      for (let i = 0; i < body.length; i += 512 * 1024) req.write(body.subarray(i, i + 512 * 1024));
      setTimeout(() => req.end(), 50);
    } else req.end(body);
  });
}

function door(port: number): Promise<{ ws: WebSocket; got: Record<string, unknown>[] }> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/door`, { headers: good });
    const got: Record<string, unknown>[] = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString()) as Record<string, unknown>));
    ws.once("open", () => ok({ ws, got }));
    ws.once("error", fail);
    cleanups.push(() => ws.terminate());
  });
}

async function qua(port: number, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d = await door(port);
  d.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "figaro.qua", params: { figaro_id: id, ...params } }));
  await until("answer", () => d.got.some((f) => f.id === 1));
  return d.got.find((f) => f.id === 1)!;
}

describe("attachments", () => {
  it("sniffs by content, not by header", () => {
    expect([png, jpeg, heic, pdf, Buffer.from("GIF89a..."), Buffer.from("RIFF\0\0\0\0WEBPVP8 ")].map(sniff)).toEqual(["png", "jpeg", "heic", "pdf", "gif", "webp"]);
    expect(sniff(Buffer.from("<svg/>"))).toBeUndefined();
    expect(sniff(Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypmp42")]))).toBeUndefined();
  });

  it("takes a photo and a pdf over POST /attach and folds them into the next qua", async () => {
    const tools = fakeTools();
    const { fake, port, lines } = await rig(new AttachStore({ tools }));
    const photo = await upload(port, heic, { "x-attach-name": "IMG_0042.HEIC" });
    const doc = await upload(port, pdf, { "x-attach-name": encodeURIComponent("Invoice «4471».pdf") });
    expect(photo).toMatchObject({ status: 200, body: { kind: "image", name: "IMG_0042.HEIC", images: 1 } });
    expect(doc).toMatchObject({ status: 200, body: { kind: "pdf", name: "Invoice «4471».pdf", pages: 2, text: true, images: 0 } });
    expect(tools.calls).toEqual(["picture heic", "pdfText"]);
    const answer = await qua(port, { text: "what do these say?", attachments: [photo.body.id, doc.body.id] });
    expect(answer).toMatchObject({ result: { ok: true } });
    const sent = fake.calls.find((c) => c.method === "figaro.qua")!.params as Record<string, unknown>;
    expect(sent.attachments).toBeUndefined();
    expect(sent.images).toEqual([{ mime_type: "image/jpeg", data: Buffer.from("scaled heic").toString("base64") }]);
    expect(sent.text).toBe('what do these say?\n\nAttached PDF "Invoice «4471».pdf", 2 pages, its text:\n```\nInvoice 4471 total 93.50\n```');
    expect(lines).toContain(`door: call method=figaro.qua aria=${id} attachments=2 session=-`);
    expect(lines.join("\n")).not.toContain("IMG_0042");
    expect(lines.join("\n")).not.toContain("Invoice");
  });

  it("spends an id once, and refuses unknown, repeated, expired or too many", async () => {
    let now = 1_000;
    const { fake, port } = await rig(new AttachStore({ tools: fakeTools(), now: () => now, ttlMs: 60_000 }));
    const a = (await upload(port, png)).body.id as string;
    expect(await qua(port, { text: "x", attachments: [a] })).toMatchObject({ result: { ok: true } });
    expect(JSON.stringify(await qua(port, { text: "x", attachments: [a] }))).toContain("unknown, already sent or expired");
    const b = (await upload(port, png)).body.id as string;
    expect(JSON.stringify(await qua(port, { text: "x", attachments: [b, b] }))).toContain("named twice");
    now += 61_000;
    expect(JSON.stringify(await qua(port, { text: "x", attachments: [b] }))).toContain("unknown, already sent or expired");
    const five = [];
    for (let i = 0; i < 5; i++) five.push((await upload(port, jpeg)).body.id);
    expect(JSON.stringify(await qua(port, { text: "x", attachments: five }))).toContain("at most 4");
    expect(await qua(port, { text: "x", attachments: five.slice(0, 4) })).toMatchObject({ result: { ok: true } });
    expect(JSON.stringify(await qua(port, { text: "x", attachments: five.slice(4), images: [{ mime_type: "image/png", data: "eA==" }, 1, 2, 3] }))).toContain("at most 4");
    expect(JSON.stringify(await qua(port, { text: "  ", attachments: five.slice(4) }))).toContain("give text too");
    expect(JSON.stringify(await qua(port, { text: "x", attachments: "nope" }))).toContain("list of 1 to 8 ids");
    expect(JSON.stringify(await qua(port, { text: "x", attachments: [] }))).toContain("list of 1 to 8 ids");
    expect(fake.calls.filter((c) => c.method === "figaro.qua")).toHaveLength(2);
  });

  it("sends a scanned pdf's first pages as images and says so, never empty text", async () => {
    const tools = fakeTools();
    const { fake, port } = await rig(new AttachStore({ tools }));
    const doc = await upload(port, scan, { "x-attach-name": "scan.pdf" });
    expect(doc).toMatchObject({ status: 200, body: { kind: "pdf", pages: 6, text: false, images: 4 } });
    expect(tools.calls).toEqual(["pdfText", "pdfPages 4"]);
    await qua(port, { text: "read it", attachments: [doc.body.id] });
    const sent = fake.calls.find((c) => c.method === "figaro.qua")!.params as { text: string; images: unknown[] };
    expect(sent.images).toHaveLength(4);
    expect(sent.text).toBe('read it\n\nAttached PDF "scan.pdf", 6 pages, no text layer: its first 4 pages are attached as images.');
  });

  it("refuses what it cannot take, with a reason and the right status", async () => {
    const { port, lines } = await rig(new AttachStore({ tools: fakeTools(), maxHeld: 2 }));
    expect(await upload(port, Buffer.from("<svg onload=x/>"))).toMatchObject({ status: 415, body: { error: expect.stringContaining("png, jpeg") } });
    expect(await upload(port, Buffer.alloc(0))).toMatchObject({ status: 400 });
    expect(await upload(port, Buffer.concat([jpeg, Buffer.from("broken")]))).toMatchObject({ status: 422, body: { error: "the image could not be read" } });
    expect(await upload(port, png, { "content-length": String(10 * 1024 * 1024 + 1) })).toMatchObject({ status: 413 });
    expect(await upload(port, Buffer.alloc(10 * 1024 * 1024 + 1, 1), { "transfer-encoding": "chunked" })).toMatchObject({ status: 413 });
    expect((await upload(port, png, {}, "GET")).status).toBe(405);
    await upload(port, png);
    await upload(port, png);
    expect(await upload(port, png)).toMatchObject({ status: 429 });
    expect(lines.filter((l) => l.startsWith("attach refused")).map((l) => l.split(" ")[2])).toEqual(["status=415", "status=422", "status=429"]);
  });

  it("refuses attachments when the gateway takes none, and passes a plain qua untouched", async () => {
    const { fake, port } = await rig(undefined);
    expect((await upload(port, png)).status).toBe(404);
    expect(JSON.stringify(await qua(port, { text: "x", attachments: ["abc"] }))).toContain("takes no attachments");
    expect(await qua(port, { text: "plain" })).toMatchObject({ result: { ok: true } });
    expect(fake.calls.find((c) => c.method === "figaro.qua")!.params).toEqual({ figaro_id: id, text: "plain" });
  });

  it("fences pdf text that itself holds backticks", () => {
    const f = fold("q", [{ kind: "pdf", text: "a ``` b ```` c", pages: 1, pictures: [], name: "n", bytes: 1 }]);
    expect(f.text).toContain("`````\na ``` b ```` c\n`````");
  });

  it("refuses an AttachError's status as given", () => {
    expect(new AttachError(413, "x").status).toBe(413);
  });
});

const has = (bin: string): boolean => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const real = has("magick") && has("pdftotext") && has("pdfinfo") && has("pdftoppm");

function textPdf(line: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 18 Tf 20 70 Td (${line}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 20 70 Td (${line}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe.skipIf(!real)("attachments with the real tools", () => {
  it("scales a large photo to the long edge, strips it to jpeg, and reads a pdf's text", async () => {
    const big = execFileSync("magick", ["-size", "4032x3024", "plasma:", "-set", "comment", "secret-gps", "jpeg:-"], { maxBuffer: 64 * 1024 * 1024 });
    const tools = systemTools();
    const p = await tools.picture(big, "jpeg");
    expect(p.mime).toBe("image/jpeg");
    const dims = execFileSync("magick", ["identify", "-format", "%w %h", "jpeg:-"], { input: p.data }).toString();
    expect(dims).toBe(`${maxImageEdge} 1176`);
    expect(p.data.includes(Buffer.from("secret-gps"))).toBe(false);
    expect(await tools.pdfText(textPdf("Invoice 4471 total 93.50"))).toEqual({ text: expect.stringContaining("Invoice 4471 total 93.50"), pages: 1 });
    const scanned = execFileSync("magick", ["-size", "600x200", "xc:white", "pdf:-"]);
    expect((await tools.pdfText(scanned)).text.trim()).toBe("");
    const pages = await tools.pdfPages(scanned, 1);
    expect(pages).toHaveLength(1);
    expect(sniff(pages[0]!)).toBe("jpeg");
  }, 30_000);
});
