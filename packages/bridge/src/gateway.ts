import { timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Dial } from "figaro-forms";
import { AriaClient, ariaRefusal, AriaUnavailable } from "figaro-forms/aria";
import { AudioHub, ariaIdPattern, type AudioListener } from "./audio.js";
import { noSession, proxyDoor, redact, sessionHeader, sessionOf } from "./door.js";
import { edgeHeader } from "./bridge.js";
import type { SpeechDial } from "./speech.js";
import { keyStored } from "./stt.js";
import { noTracer, parseTraceparent, type Tracer } from "./trace.js";
import { attachRoute, type AttachStore } from "./attach.js";

export interface GatewayEdge {
  readonly secret: string;
  readonly admin: string;
  readonly peers?: readonly string[];
}

export type GatewayListen = { readonly path: string; readonly mode?: number } | { readonly port: number; readonly host?: string };

export interface GatewayOptions {
  readonly listen: GatewayListen;
  readonly edge: GatewayEdge;
  readonly door: (user: string, session: string) => Dial;
  readonly speech: SpeechDial;
  readonly speechSocket?: string;
  readonly store: string;
  readonly origins?: readonly string[];
  readonly maxFrameBytes?: number;
  readonly log?: (line: string) => void;
  readonly joinTimeoutMs?: number;
  readonly routes?: GatewayRoute;
  readonly tracer?: Tracer;
  readonly attachments?: AttachStore;
  readonly sockets?: GatewaySocket;
}

export type GatewayRoute = (req: IncomingMessage, res: ServerResponse, path: string, user: string) => boolean;

export type GatewaySocket = (path: string) => ((ws: WebSocket, req: IncomingMessage) => void) | undefined;

export interface Gateway {
  readonly server: Server;
  readonly audio: AudioHub;
  readonly address: string;
  close(): Promise<void>;
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function gatewayRefusal(edge: GatewayEdge, req: IncomingMessage): string | undefined {
  if (edge.peers) {
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!edge.peers.includes(peer)) return "not from the edge";
  }
  const given = req.headers[edgeHeader];
  if (typeof given !== "string" || !sameToken(given, edge.secret)) return "not from the edge";
  if (req.headers["remote-user"] !== edge.admin) return "admin only";
  return undefined;
}

const keyPattern = /^[a-z0-9-]{1,63}\/[0-9a-f]{32}:\d{1,20}\/out$/;
const bufferCeiling = 8 << 20;

function pathOf(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? "/", "http://gateway").pathname;
  } catch {
    return undefined;
  }
}

function originOk(req: IncomingMessage, extra: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (extra.has(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const refusalCode = (e: unknown): string => {
  const r = e instanceof AriaUnavailable ? e.refusal : ariaRefusal(e);
  if (!r) return "unavailable";
  return r.kind === "not_found" ? "aria_gone" : r.kind;
};

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
  const e = o.edge;
  if (Buffer.byteLength(e.secret) < 32) throw new Error("the edge secret is shorter than 32 bytes");
  if (!e.admin) throw new Error("the gateway needs --admin: the Remote-User the edge signs in");
  if (!("path" in o.listen) && e.peers === undefined) throw new Error("a TCP gateway needs --peer: the address the edge proxy connects from");
  const origins = new Set(o.origins ?? []);
  const maxPayload = o.maxFrameBytes ?? 1 << 20;

  const log = o.log ?? ((line: string) => process.stderr.write(`figaro-gateway: ${line}\n`));
  let shared: AriaClient | undefined;
  const tracer = o.tracer ?? noTracer;
  const hub = new AudioHub({
    log,
    tracer,
    connect: () => {
      log("audio: dialing the door");
      return (shared = new AriaClient({ dial: o.door(e.admin, noSession) }));
    },
    speech: o.speech,
    store: o.store,
    stored: async (key, session) => (o.speechSocket ? keyStored({ socket: o.speechSocket, store: o.store, timeoutMs: 5_000 }, key, session) : false),
    voiceOf: async (aria) => {
      const r = (await shared?.connection.call("figaro.form", { figaro_id: aria })) as { snapshot?: { system?: { voice?: unknown } } } | null | undefined;
      const v = r?.snapshot?.system?.voice;
      return typeof v === "string" && v !== "" ? v : undefined;
    },
  });

  const attach = o.attachments ? attachRoute(o.attachments, log, (req) => sessionOf(req, false)) : undefined;
  const server = createServer((req, res) => {
    const refusal = gatewayRefusal(e, req);
    if (refusal) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(refusal);
      return;
    }
    const path = pathOf(req);
    if (path === undefined) {
      res.writeHead(400).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !originOk(req, origins)) {
      log(`http ${req.method ?? "-"} ${redact(path)} 403 foreign origin session=${sessionOf(req, false)}`);
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end("foreign origin");
      return;
    }
    const session = sessionOf(req, false);
    const started = Date.now();
    const asked = typeof req.headers.traceparent === "string" && parseTraceparent(req.headers.traceparent) ? req.headers.traceparent : undefined;
    if (asked === undefined) delete req.headers.traceparent;
    const sp = tracer.recording ? tracer.start(`http ${req.method ?? "-"} ${routeOf(path)}`, asked, { "http.request.method": req.method ?? "-", "figchat.session": session }) : undefined;
    if (sp) req.headers.traceparent = sp.traceparent;
    res.once("finish", () => {
      log(`http ${req.method ?? "-"} ${redact(path)} ${res.statusCode} ${Date.now() - started} ms session=${session}`);
      sp?.set("http.response.status_code", res.statusCode);
      if (res.statusCode >= 500) sp?.fail(`status ${res.statusCode}`);
      sp?.end();
    });
    if (path.startsWith("/audio/key/")) {
      let key: string;
      try {
        key = decodeURIComponent(path.slice("/audio/key/".length));
      } catch {
        res.writeHead(400).end();
        return;
      }
      replay(o.speechSocket, o.store, key, req, res, session);
      return;
    }
    if (path === "/attach" && attach) {
      attach(req, res);
      return;
    }
    if (o.routes?.(req, res, path, String(req.headers["remote-user"]))) return;
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const pings = new Set<WebSocket & { alive?: boolean }>();
  const beat = setInterval(() => {
    for (const ws of pings) {
      if (ws.alive === false) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 20_000);
  beat.unref();

  const refuseUpgrade = (sock: import("node:stream").Duplex, line: string): void => {
    sock.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (req, sock, head) => {
    if (gatewayRefusal(e, req) || !originOk(req, origins)) {
      refuseUpgrade(sock, "403 Forbidden");
      return;
    }
    const path = pathOf(req);
    if (path === undefined) {
      refuseUpgrade(sock, "400 Bad Request");
      return;
    }
    const session = sessionOf(req, true);
    const target = /^\/audio\/(?:([^/]+)\/)?([^/]+)$/.exec(path);
    const audio = target?.[2];
    const asked = target?.[1];
    let take: ReturnType<GatewaySocket>;
    if (path === "/door") {
      wss.handleUpgrade(req, sock, head, (ws) => {
        track(ws);
        proxyDoor(ws, o.door(String(req.headers["remote-user"]), session), hub, log, session, tracer, o.attachments);
      });
    } else if (audio !== undefined && ariaIdPattern.test(audio)) {
      wss.handleUpgrade(req, sock, head, (ws) => {
        track(ws);
        void attend(ws, audio, asked, String(req.headers["remote-user"]), session);
      });
    } else if ((take = o.sockets?.(path))) {
      const attend = take;
      wss.handleUpgrade(req, sock, head, (ws) => {
        track(ws);
        attend(ws, req);
      });
    } else {
      refuseUpgrade(sock, "404 Not Found");
    }
  });

  function track(ws: WebSocket & { alive?: boolean }): void {
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    pings.add(ws);
    ws.on("close", () => pings.delete(ws));
  }

  async function attend(ws: WebSocket, aria: string, asked: string | undefined, user: string, session: string): Promise<void> {
    let jsonSent = 0;
    let binarySent = 0;
    const listener: AudioListener = {
      session,
      json: (f) => {
        if (ws.readyState !== ws.OPEN) return;
        jsonSent += 1;
        ws.send(JSON.stringify(f));
      },
      binary: (b) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > bufferCeiling) {
          log(`audio: closing aria=${aria}, client too slow session=${session}`);
          ws.close(1013, "client too slow for audio");
          return;
        }
        binarySent += 1;
        ws.send(b, { binary: true });
      },
    };
    let leave: (() => void) | undefined;
    let closed = false;
    log(`audio: connect aria=${aria} user=${user}${asked !== undefined ? ` store=${asked}` : ""} session=${session}`);
    ws.on("close", (code, reason) => {
      closed = true;
      leave?.();
      log(`audio: closed aria=${aria} code=${code} reason=${redact(reason.toString())} json=${jsonSent} binary=${binarySent} session=${session}`);
    });
    if (asked !== undefined && asked !== o.store) {
      log(`audio: refused aria=${aria}, store ${redact(asked)} is not served here session=${session}`);
      listener.json({ type: "error", code: "store", text: `this gateway serves the store ${o.store}, not ${asked}` });
      ws.close(1008, "unknown store");
      return;
    }
    let ready: (ok: boolean) => void = () => {};
    const joined = new Promise<boolean>((ok) => (ready = ok));
    ws.on("message", (data, binary) => {
      if (binary) {
        ws.close(1003, "text frames only");
        return;
      }
      try {
        const f = JSON.parse(data.toString()) as { type?: unknown; turn?: unknown };
        if (f.type === "cancel") hub.cancel(aria, "client", listener);
        else if (f.type === "say") void joined.then(async (ok) => {
          if (ok && !closed) await hub.say(aria, listener, f.turn);
        });
      } catch {
        ws.close(1007, "not JSON");
      }
    });
    try {
      const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error("the door did not answer")), o.joinTimeoutMs ?? 10_000).unref());
      const left = await Promise.race([hub.join(aria, listener), timeout]);
      if (closed) {
        left();
        return;
      }
      leave = left;
      ready(true);
      log(`audio: follow ready aria=${aria} session=${session}`);
      listener.json({ type: "ready", aria, store: o.store });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log(`audio: follow failed aria=${aria} code=${refusalCode(err)} text=${redact(text)} session=${session}`);
      ready(false);
      listener.json({ type: "error", code: refusalCode(err), text });
      ws.close(1011, "cannot attend");
    }
  }

  const listen = o.listen;
  if ("path" in listen) await rm(listen.path, { force: true });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    if ("path" in listen) server.listen(listen.path, ok);
    else server.listen(listen.port, listen.host ?? "127.0.0.1", ok);
  });
  if ("path" in listen) await chmod(listen.path, listen.mode ?? 0o660);
  const addr = server.address();
  const address = "path" in listen ? listen.path : typeof addr === "object" && addr ? `http://${listen.host ?? "127.0.0.1"}:${addr.port}` : "";

  return {
    server,
    audio: hub,
    address,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(beat);
        hub.close();
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

function routeOf(path: string): string {
  if (path.startsWith("/audio/key/")) return "/audio/key";
  if (path.startsWith("/stt/key/")) return "/stt/key";
  if (path === "/attach") return "/attach";
  return path === "/stt" ? "/stt" : "other";
}

function replay(socket: string | undefined, store: string, key: string, req: IncomingMessage, res: ServerResponse, session: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (!socket || !keyPattern.test(key)) {
    res.writeHead(socket ? 400 : 404).end();
    return;
  }
  if (!key.startsWith(`${store}/`)) {
    res.writeHead(404).end();
    return;
  }
  const headers: Record<string, string> = {};
  if (typeof req.headers.range === "string") headers.range = req.headers.range;
  if (session !== noSession) headers[sessionHeader] = session;
  if (typeof req.headers.traceparent === "string" && parseTraceparent(req.headers.traceparent)) headers.traceparent = req.headers.traceparent;
  const up = request({ socketPath: socket, path: `/audio/key/${key}`, method: req.method, headers }, (r) => {
    const keep = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];
    const out: Record<string, string> = { "x-content-type-options": "nosniff", "cache-control": "no-store" };
    for (const k of keep) if (typeof r.headers[k] === "string") out[k] = r.headers[k] as string;
    res.writeHead(r.statusCode ?? 502, out);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("close", () => up.destroy());
  up.end();
}
