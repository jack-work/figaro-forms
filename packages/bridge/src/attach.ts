import { execFile, type ExecFileOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const maxAttachBytes = 10 * 1024 * 1024;
export const maxImageEdge = 1568;
export const maxImageBytes = 5 * 1024 * 1024;
export const maxScanPages = 4;
const maxPdfText = 2 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "heic";

export interface Picture {
  readonly mime: "image/png" | "image/jpeg";
  readonly data: Buffer;
}

export interface Tools {
  picture(data: Buffer, from: ImageFormat): Promise<Picture>;
  pdfText(data: Buffer): Promise<{ text: string; pages: number }>;
  pdfPages(data: Buffer, pages: number): Promise<Buffer[]>;
}

export type Held =
  | { readonly kind: "image"; readonly pictures: readonly Picture[]; readonly name: string; readonly bytes: number }
  | { readonly kind: "pdf"; readonly text: string; readonly pages: number; readonly pictures: readonly Picture[]; readonly name: string; readonly bytes: number };

export class AttachError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sniff(b: Buffer): ImageFormat | "pdf" | undefined {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b.toString("latin1", 8, 12))) return "heic";
  if (b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  return undefined;
}

export const magickPolicy = `<policymap>
  <policy domain="resource" name="memory" value="256MiB"/>
  <policy domain="resource" name="map" value="512MiB"/>
  <policy domain="resource" name="disk" value="1GiB"/>
  <policy domain="resource" name="area" value="128MP"/>
  <policy domain="resource" name="width" value="16KP"/>
  <policy domain="resource" name="height" value="16KP"/>
  <policy domain="resource" name="time" value="15"/>
  <policy domain="delegate" rights="none" pattern="*"/>
  <policy domain="filter" rights="none" pattern="*"/>
  <policy domain="path" rights="none" pattern="@*"/>
  <policy domain="module" rights="none" pattern="*"/>
  <policy domain="module" rights="read | write" pattern="{PNG,JPEG,GIF,WEBP,HEIC}"/>
  <policy domain="coder" rights="none" pattern="*"/>
  <policy domain="coder" rights="read | write" pattern="{PNG,JPEG,JPG,GIF,WEBP,HEIC,HEIF}"/>
</policymap>
`;

async function withMagickPolicy<T>(tmp: string, f: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmp, "attach-magick-"));
  try {
    const path = join(dir, "policy.xml");
    await writeFile(path, magickPolicy, { mode: 0o400, flag: "wx" });
    if ((await readFile(path, "utf8")) !== magickPolicy) throw new Error("the magick policy did not write");
    return await f({ MAGICK_CONFIGURE_PATH: dir, HOME: "/nonexistent" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(file: string, args: readonly string[], input: Buffer, timeoutMs: number, maxBuffer: number, cwd?: string, env: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const opts: ExecFileOptions & { encoding: "buffer" } = { timeout: timeoutMs, maxBuffer, encoding: "buffer", killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "", ...env }, ...(cwd ? { cwd } : {}) };
    const child = execFile(file, args as string[], opts, (err, stdout) => {
      if (err) fail(new Error(`${file} failed${(err as { killed?: boolean }).killed ? " (timed out)" : ""}`));
      else ok(stdout as Buffer);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export interface ToolPaths {
  readonly magick?: string;
  readonly pdftotext?: string;
  readonly pdfinfo?: string;
  readonly pdftoppm?: string;
  readonly tmp?: string;
}

export function systemTools(p: ToolPaths = {}): Tools {
  const magick = p.magick ?? "magick";
  const tmp = p.tmp ?? tmpdir();
  const picture = (data: Buffer, from: ImageFormat): Promise<Picture> => withMagickPolicy(tmp, async (env) => {
    const keepPng = from === "png";
    const out = await run(
      magick,
      ["-limit", "memory", "256MiB", "-limit", "area", "128MP", "-limit", "time", "15", `${from}:-[0]`, "-auto-orient", "-resize", `${maxImageEdge}x${maxImageEdge}>`, "-strip", ...(keepPng ? [] : ["-quality", "85"]), keepPng ? "png:-" : "jpeg:-"],
      data,
      20_000,
      32 * 1024 * 1024,
      undefined,
      env,
    );
    if (out.length > maxImageBytes) {
      const smaller = await run(magick, ["-limit", "memory", "256MiB", "-limit", "time", "15", `${keepPng ? "png" : "jpeg"}:-`, "-resize", "1024x1024>", "-quality", "75", "jpeg:-"], out, 20_000, 32 * 1024 * 1024, undefined, env);
      if (smaller.length > maxImageBytes) throw new AttachError(413, "the image is still over 5 MB after scaling");
      return { mime: "image/jpeg", data: smaller };
    }
    return { mime: keepPng ? "image/png" : "image/jpeg", data: out };
  });
  return {
    picture,
    pdfText: async (data) => {
      const info = (await run(p.pdfinfo ?? "pdfinfo", ["-"], data, 10_000, 1024 * 1024)).toString("utf8");
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
      const text = (await run(p.pdftotext ?? "pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], data, 15_000, maxPdfText * 2)).toString("utf8");
      return { text: text.length > maxPdfText ? text.slice(0, maxPdfText) : text, pages };
    },
    pdfPages: async (data, pages) => {
      const dir = await mkdtemp(join(tmp, "attach-"));
      try {
        await run(p.pdftoppm ?? "pdftoppm", ["-scale-to", String(maxImageEdge), "-f", "1", "-l", String(pages), "-jpeg", "-", join(dir, "p")], data, 20_000, 1024 * 1024);
        const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
        return await Promise.all(files.map(async (f) => (await picture(await readFile(join(dir, f)), "jpeg")).data));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface AttachOptions {
  readonly tools: Tools;
  readonly ttlMs?: number;
  readonly maxHeld?: number;
  readonly maxHeldBytes?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly held: Held;
  readonly expires: number;
}

const heldBytes = (h: Held): number => h.pictures.reduce((n, p) => n + p.data.length, 0) + (h.kind === "pdf" ? Buffer.byteLength(h.text) : 0);

export class AttachStore {
  private readonly held = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly o: AttachOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, e] of this.held) {
      if (e.expires > now) continue;
      this.held.delete(id);
      this.bytes -= heldBytes(e.held);
    }
  }

  async add(data: Buffer, name: string): Promise<{ id: string; held: Held }> {
    this.sweep();
    if (this.held.size >= (this.o.maxHeld ?? 16)) throw new AttachError(429, "too many attachments waiting to be sent");
    const kind = sniff(data);
    if (kind === undefined) throw new AttachError(415, "attach a png, jpeg, gif, webp or heic image, or a pdf");
    let held: Held;
    try {
      if (kind === "pdf") {
        const { text, pages } = await this.o.tools.pdfText(data);
        if (text.trim() !== "") held = { kind: "pdf", text, pages, pictures: [], name, bytes: data.length };
        else {
          if (pages < 1) throw new AttachError(422, "the pdf has no pages");
          const pictures = (await this.o.tools.pdfPages(data, Math.min(pages, maxScanPages))).map((d) => ({ mime: "image/jpeg" as const, data: d }));
          if (pictures.length === 0) throw new AttachError(422, "the pdf has no text and its pages could not be drawn");
          held = { kind: "pdf", text: "", pages, pictures, name, bytes: data.length };
        }
      } else held = { kind: "image", pictures: [await this.o.tools.picture(data, kind)], name, bytes: data.length };
    } catch (e) {
      if (e instanceof AttachError) throw e;
      throw new AttachError(422, kind === "pdf" ? "the pdf could not be read" : "the image could not be read");
    }
    const size = heldBytes(held);
    if (this.bytes + size > (this.o.maxHeldBytes ?? 64 * 1024 * 1024)) throw new AttachError(429, "too much waiting to be sent; send or wait");
    const id = randomBytes(16).toString("base64url");
    this.held.set(id, { held, expires: this.now() + (this.o.ttlMs ?? 15 * 60_000) });
    this.bytes += size;
    return { id, held };
  }

  take(ids: readonly string[], alongside = 0): Held[] | string {
    this.sweep();
    if (new Set(ids).size !== ids.length) return "an attachment is named twice";
    const out: Held[] = [];
    for (const id of ids) {
      const e = typeof id === "string" ? this.held.get(id) : undefined;
      if (!e) return "an attachment is unknown, already sent or expired";
      out.push(e.held);
    }
    const pictures = out.reduce((n, h) => n + h.pictures.length, alongside);
    if (pictures > maxQuaImages) return `the attachments hold ${pictures} images; a message carries at most ${maxQuaImages}`;
    for (const id of ids) {
      const e = this.held.get(id)!;
      this.held.delete(id);
      this.bytes -= heldBytes(e.held);
    }
    return out;
  }

  get size(): number {
    return this.held.size;
  }
}

export const maxQuaImages = 4;

export interface Folded {
  readonly text: string;
  readonly images: { mime_type: string; data: string }[];
}

export function fold(text: string, held: readonly Held[]): Folded {
  const images: { mime_type: string; data: string }[] = [];
  const blocks: string[] = [];
  for (const h of held) {
    for (const p of h.pictures) images.push({ mime_type: p.mime, data: p.data.toString("base64") });
    if (h.kind !== "pdf") continue;
    const head = `Attached PDF "${h.name}", ${h.pages} page${h.pages === 1 ? "" : "s"}`;
    if (h.text !== "") {
      const fence = "`".repeat(Math.max(3, ...[...h.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      blocks.push(`${head}, its text:\n${fence}\n${h.text.trimEnd()}\n${fence}`);
    } else blocks.push(`${head}, no text layer: ${h.pictures.length === h.pages ? "its pages are" : `its first ${h.pictures.length} pages are`} attached as images.`);
  }
  return { text: blocks.length === 0 ? text : `${text}\n\n${blocks.join("\n\n")}`, images };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        req.removeAllListeners("data");
        ok("too-large");
        return;
      }
      parts.push(c);
    });
    req.once("end", () => ok(Buffer.concat(parts)));
    req.once("error", fail);
    req.once("close", () => {
      if (!req.complete) fail(new Error("client went away"));
    });
  });
}

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(req.readableEnded ? {} : { Connection: "close" }),
  });
  res.end(text, () => {
    if (!req.readableEnded) req.destroy();
  });
}

const cleanName = (raw: unknown): string => {
  let s = typeof raw === "string" ? raw : "";
  try {
    s = decodeURIComponent(s);
  } catch {
    s = "";
  }
  s = s.replace(/[\u0000-\u001f\u007f"`\\]/g, "").trim().slice(0, 120);
  return s === "" ? "attachment" : s;
};

export function attachRoute(store: AttachStore, log: (line: string) => void, session: (req: IncomingMessage) => string) {
  let running = 0;
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", Connection: "close" }).end();
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > maxAttachBytes) {
      reply(req, res, 413, { error: `over ${maxAttachBytes} bytes` });
      return;
    }
    if (running >= 2) {
      reply(req, res, 503, { error: "attachments busy" });
      return;
    }
    running++;
    void (async () => {
      try {
        const body = await readBody(req, maxAttachBytes);
        if (body === "too-large") return reply(req, res, 413, { error: `over ${maxAttachBytes} bytes` });
        if (body.length === 0) return reply(req, res, 400, { error: "empty body" });
        const { id, held } = await store.add(body, cleanName(req.headers["x-attach-name"]));
        log(`attach kind=${held.kind} bytes=${held.bytes} images=${held.pictures.length}${held.kind === "pdf" ? ` pages=${held.pages} text=${held.text.length}` : ""} session=${session(req)}`);
        reply(req, res, 200, { id, kind: held.kind, name: held.name, bytes: held.bytes, images: held.pictures.length, ...(held.kind === "pdf" ? { pages: held.pages, text: held.text !== "" } : {}) });
      } catch (e) {
        const status = e instanceof AttachError ? e.status : 500;
        log(`attach refused status=${status} session=${session(req)}`);
        if (!res.headersSent) reply(req, res, status, { error: e instanceof AttachError ? e.message : "attach failed" });
      } finally {
        running--;
      }
    })();
  };
}
