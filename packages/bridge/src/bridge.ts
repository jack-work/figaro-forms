import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { touchedKeys, type Patch } from "figaro-forms";
import { wellKnownKeys } from "figaro-forms/semantics";

export const readMethods = ["angelus.hello", "figaro.follow", "figaro.form"] as const;
export const writeMethods = ["figaro.set", "form.create"] as const;

export interface BridgeOptions {
  readonly socket: string;
  readonly host?: string;
  readonly port?: number;
  readonly write?: boolean;
  readonly writeSystem?: boolean;
  readonly origins?: readonly string[];
  readonly staticDir?: string;
  readonly token?: string;
  readonly maxFrameBytes?: number;
}

export interface Bridge {
  readonly server: Server;
  readonly token: string;
  readonly origin: string;
  readonly doorUrl: string;
  readonly pageUrl: string | undefined;
  close(): Promise<void>;
}

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const daemonWritten = wellKnownKeys.filter((d) => d.mode !== "user" && !d.key.startsWith("system.")).map((d) => d.key);

function heldKey(dotted: string): string | undefined {
  if (dotted === "") return "the whole form";
  if (dotted === "system" || dotted.startsWith("system.")) return dotted;
  for (const k of daemonWritten) {
    if (dotted === k || dotted.startsWith(k + ".") || k.startsWith(dotted + ".")) return dotted;
  }
  return undefined;
}

const fields: Record<string, readonly string[]> = {
  "figaro.set": ["figaro_id", "patch", "outfits", "if_version", "assert", "client", "seq"],
  "form.create": ["parent", "patch", "outfits"],
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function exactly(where: string, v: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(v)) return `${where} must be an object`;
  for (const k of Object.keys(v)) if (!keys.includes(k)) return `${where} has unexpected key ${JSON.stringify(k)}`;
  return undefined;
}

function strictPatch(where: string, v: unknown): string | undefined {
  const bad = exactly(where, v, ["scalar", "object", "list"]);
  if (bad) return bad;
  const p = v as Record<string, unknown>;
  if (Object.keys(p).length > 1) return `${where} names more than one shape`;
  if (p.scalar !== undefined) return exactly(`${where}.scalar`, p.scalar, ["Before", "After"]);
  if (p.object !== undefined) {
    const o = p.object;
    const e = exactly(`${where}.object`, o, ["Set", "Delete", "Update", "New"]);
    if (e) return e;
    const ob = o as Record<string, unknown>;
    for (const m of ["Set", "Delete", "New"]) if (ob[m] !== undefined && ob[m] !== null && !isRecord(ob[m])) return `${where}.object.${m} must be an object`;
    if (ob.Update !== undefined && ob.Update !== null) {
      if (!isRecord(ob.Update)) return `${where}.object.Update must be an object`;
      for (const [k, c] of Object.entries(ob.Update)) {
        const ce = strictPatch(`${where}.object.Update[${JSON.stringify(k)}]`, c);
        if (ce) return ce;
      }
    }
    return undefined;
  }
  if (p.list !== undefined) {
    const l = p.list;
    const e = exactly(`${where}.list`, l, ["Create", "Delete", "Update", "Order"]);
    if (e) return e;
    const lb = l as Record<string, unknown>;
    for (const m of ["Create", "Delete"]) {
      const items = lb[m];
      if (items === undefined || items === null) continue;
      if (!Array.isArray(items)) return `${where}.list.${m} must be an array`;
      for (const it of items) {
        const ie = exactly(`${where}.list.${m}[]`, it, ["Key", "Value"]);
        if (ie) return ie;
      }
    }
    if (lb.Order !== undefined && lb.Order !== null) {
      const oe = exactly(`${where}.list.Order`, lb.Order, ["Declared", "Moved", "Prior", "PriorMoved"]);
      if (oe) return oe;
    }
    if (lb.Update !== undefined && lb.Update !== null) {
      if (!isRecord(lb.Update)) return `${where}.list.Update must be an object`;
      for (const [k, c] of Object.entries(lb.Update)) {
        const ce = strictPatch(`${where}.list.Update[${JSON.stringify(k)}]`, c);
        if (ce) return ce;
      }
    }
  }
  return undefined;
}

export function writeRefusal(method: string, params: unknown, writeSystem: boolean): string | undefined {
  const keys = fields[method];
  if (!keys) return undefined;
  const shape = exactly(`${method} params`, params, keys);
  if (shape) return shape;
  const p = params as { patch?: unknown; outfits?: unknown };
  if (p.patch !== undefined && p.patch !== null) {
    const bad = strictPatch(`${method} patch`, p.patch);
    if (bad) return bad;
  }
  return writeSystem ? undefined : systemRefusal(method, p);
}

function systemRefusal(method: string, p: { patch?: unknown; outfits?: unknown }): string | undefined {
  const hint = "; start the bridge with --write-system to allow it";
  if (Array.isArray(p.outfits) && p.outfits.length > 0) return `${method}: outfits can carry owner-held keys${hint}`;
  if (p.patch === undefined || p.patch === null) return undefined;
  let paths: string[][];
  try {
    paths = touchedKeys(p.patch as Patch);
  } catch {
    return `${method}: unreadable patch`;
  }
  for (const path of paths) {
    const held = heldKey(path.join("."));
    if (held) return `${method}: ${held} is owner-held or daemon-written${hint}`;
  }
  return undefined;
}

function refuse(ws: WebSocket, id: unknown, message: string): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32020, message } }));
}

export function defaultSocket(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FIGARO_RUNTIME_DIR) return join(env.FIGARO_RUNTIME_DIR, "angelus.sock");
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "figaro", "angelus.sock");
  throw new Error("no daemon socket: pass --socket, or set FIGARO_RUNTIME_DIR or XDG_RUNTIME_DIR");
}

export async function startBridge(o: BridgeOptions): Promise<Bridge> {
  const host = o.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(`refusing to listen on ${host}: the bridge carries the daemon's owner reach and listens on loopback only`);
  }
  const token = o.token ?? randomBytes(24).toString("base64url");
  const allowed = new Set<string>([...readMethods, ...(o.write ? writeMethods : [])]);
  const maxFrame = o.maxFrameBytes ?? 1 << 20;
  const staticRoot = o.staticDir ? resolve(o.staticDir) : undefined;
  const origins = new Set(o.origins ?? []);

  const own = new Set<string>();
  const loopbackHost = (req: IncomingMessage): boolean => {
    const h = req.headers.host ?? "";
    return [...own].some((o) => o.endsWith(`//${h}`));
  };
  const server = createServer((req, res) => {
    if (!loopbackHost(req)) {
      res.writeHead(421).end();
      return;
    }
    serveStatic(staticRoot, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrame });

  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url ?? "/", "http://bridge");
    const given = url.searchParams.get("token") ?? "";
    const origin = req.headers.origin;
    const originOk = origin === undefined || own.has(origin) || origins.has(origin);
    if (!loopbackHost(req)) {
      sock.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (url.pathname !== "/door" || !sameToken(given, token) || !originOk) {
      sock.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => relay(ws, o.socket, allowed, o.write === true, o.writeSystem === true));
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port ?? 0, host, () => ok());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port ?? 0;
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  own.add(origin);
  if (host === "127.0.0.1" || host === "localhost") {
    own.add(`http://127.0.0.1:${port}`);
    own.add(`http://localhost:${port}`);
  }
  return {
    server,
    token,
    origin,
    doorUrl: `${origin.replace(/^http/, "ws")}/door?token=${token}`,
    pageUrl: staticRoot ? `${origin}/#token=${token}` : undefined,
    close: () =>
      new Promise<void>((ok) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

function relay(ws: WebSocket, path: string, allowed: ReadonlySet<string>, write: boolean, writeSystem: boolean): void {
  const up: Socket = connect(path);
  let buf = "";
  up.setEncoding("utf8");
  up.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() !== "") ws.send(line);
    }
  });
  up.on("error", () => ws.close(1011, "daemon socket error"));
  up.on("close", () => ws.close(1011, "daemon socket closed"));
  ws.on("close", () => up.destroy());
  ws.on("message", (data, binary) => {
    if (binary) {
      ws.close(1003, "text frames only");
      return;
    }
    const text = data.toString();
    let frame: { id?: unknown; method?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      ws.close(1007, "not JSON");
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      ws.close(1007, "not a JSON-RPC object");
      return;
    }
    if (typeof frame.method !== "string" || !allowed.has(frame.method)) {
      const name = typeof frame.method === "string" ? frame.method : "a frame without a method";
      refuse(ws, frame.id ?? null, `bridge: ${name} is not allowed${write ? "" : " (read-only bridge; start it with --write to edit)"}`);
      return;
    }
    const held = writeRefusal(frame.method, (frame as { params?: unknown }).params, writeSystem);
    if (held) {
      refuse(ws, frame.id ?? null, `bridge: ${held}`);
      return;
    }
    up.write(JSON.stringify(frame) + "\n");
  });
}

async function serveStatic(root: string | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const head = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  if (!root || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404, head).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://bridge");
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, head).end();
    return;
  }
  let file = normalize(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403, head).end();
    return;
  }
  try {
    let s = await stat(file);
    if (s.isDirectory()) {
      file = join(file, "index.html");
      s = await stat(file);
    }
    res.writeHead(200, { ...head, "Content-Type": types[extname(file)] ?? "application/octet-stream", "Content-Length": s.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, head).end();
  }
}
