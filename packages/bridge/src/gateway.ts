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
import { handoverDial } from "./handover.js";
import type { Faults, Who } from "./faults.js";
import { noMetrics, type Metrics } from "./metrics.js";
import type { Dictations } from "./dictation.js";

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
  readonly compress?: boolean;
  readonly renew?: (until: number) => Promise<number | undefined>;
  readonly sockets?: GatewaySocket;
  readonly faults?: Faults;
  readonly metrics?: Metrics;
  readonly audioLeaveGraceMs?: number;
  readonly dictations?: Dictations;
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

const keyPattern = /^[a-z0-9-]{1,63}\/[0-9a-f]{32}:\d{1,20}\/(in|out)$/;
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
  const socketCeiling = Math.max(maxPayload * 8, 8 << 20);

  const log = o.log ?? ((line: string) => process.stderr.write(`figaro-gateway: ${line}\n`));
  const renew = o.faults ? o.faults.renew(o.renew) : o.renew;
  const doorFor = (user: string, session: string, who: Who): Dial => {
    const base = o.faults ? o.faults.door(o.door(user, session), who) : o.door(user, session);
    let legs = 0;
    const dial: Dial = async (events) => {
      const kind = legs++ === 0 ? (who.audio ? "audio" : "page") : "handover";
      const t = Date.now();
      try {
        const s = await base(events);
        metrics.ms("figchat.gateway.door.dial_ms", Date.now() - t, { "figchat.session": session, kind, outcome: "ok" });
        return s;
      } catch (e) {
        metrics.ms("figchat.gateway.door.dial_ms", Date.now() - t, { "figchat.session": session, kind, outcome: "error" });
        throw e;
      }
    };
    const tag = who.audio ? "for=audio" : `session=${session}`;
    const moved = (outcome: "ok" | "error", why: string, ms: number): void => {
      const kind = why.replace(/ /g, "_");
      if (outcome === "ok") metrics.ms("figchat.gateway.handover_ms", ms, { "figchat.session": session, kind, outcome });
      else metrics.count("figchat.gateway.errors", { "figchat.session": session, kind: "handover" });
    };
    return renew ? handoverDial(dial, { renew, moved, log: (l) => log(`${l} ${tag}`) }) : dial;
  };
  let shared: AriaClient | undefined;
  const tracer = o.tracer ?? noTracer;
  const metrics = o.metrics ?? noMetrics;
  const seenSessions = { door: new Set<string>(), audio: new Set<string>() };
  const reconnect = (path: "door" | "audio", session: string): void => {
    if (session === noSession) return;
    if (seenSessions[path].has(session)) metrics.count("figchat.gateway.reconnects", { "figchat.session": session, kind: path });
    else seenSessions[path].add(session);
  };
  const hub = new AudioHub({
    log,
    tracer,
    ...(o.metrics ? { metrics: o.metrics } : {}),
    ...(o.audioLeaveGraceMs !== undefined ? { leaveGraceMs: o.audioLeaveGraceMs } : {}),
    connect: () => {
      log("audio: dialing the door");
      return (shared = new AriaClient({ dial: doorFor(e.admin, noSession, { session: noSession, audio: true }) }));
    },
    speech: o.faults ? o.faults.speech(o.speech) : o.speech,
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

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: socketCeiling,
    perMessageDeflate:
      o.compress === false
        ? false
        : { zlibDeflateOptions: { level: 6, memLevel: 8 }, zlibInflateOptions: { chunkSize: 16 * 1024 }, threshold: 128, concurrencyLimit: 8 },
  });
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
        meterDoor(ws, req.socket, session);
        o.faults?.page(ws, { session, audio: false });
        proxyDoor(ws, doorFor(String(req.headers["remote-user"]), session, { session, audio: false }), hub, log, session, tracer, o.attachments, maxPayload);
      });
    } else if (audio !== undefined && ariaIdPattern.test(audio)) {
      wss.handleUpgrade(req, sock, head, (ws) => {
        track(ws);
        o.faults?.page(ws, { session, audio: true });
        reconnect("audio", session);
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

  function meterDoor(ws: WebSocket, sock: import("node:net").Socket, session: string): void {
    const sp = tracer.recording ? tracer.start("door session", undefined, { "figchat.session": session }) : undefined;
    const wire0 = { out: sock.bytesWritten, in: sock.bytesRead };
    let out = 0;
    let outFrames = 0;
    let inBytes = 0;
    let inFrames = 0;
    const opened = Date.now();
    const asked = new Map<string, number>();
    const awaitingTurn = new Map<string, { aria: string; text: string }>();
    const openedTurn = (data: string): void => {
      let f: { params?: { figaro_id?: unknown; parts?: { turn?: unknown; inquiry?: unknown; inquiry_segments?: { text?: unknown }[]; sealed?: unknown }[] } };
      try {
        f = JSON.parse(data) as typeof f;
      } catch {
        return;
      }
      const aria = f.params?.figaro_id;
      if (typeof aria !== "string") return;
      for (const [audioId, w] of awaitingTurn) {
        if (w.aria !== aria) continue;
        if (!o.dictations?.holds(session, aria, audioId)) {
          awaitingTurn.delete(audioId);
          continue;
        }
        const part = (f.params?.parts ?? []).find((p) => p.sealed === false && typeof p.turn === "number" && carriesInquiry(p, w.text));
        if (!part) continue;
        awaitingTurn.delete(audioId);
        void o.dictations.turnOpened(session, aria, part.turn as number, audioId);
      }
    };
    reconnect("door", session);
    const send = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void;
    (ws as unknown as { send: (data: unknown, ...rest: unknown[]) => void }).send = (data, ...rest) => {
      out += typeof data === "string" ? Buffer.byteLength(data) : Buffer.isBuffer(data) ? data.length : 0;
      if (outFrames++ === 0) metrics.ms("figchat.gateway.door.first_frame_ms", Date.now() - opened, { "figchat.session": session });
      if (typeof data === "string") {
        if (data.includes('"code":-32020')) metrics.count("figchat.gateway.errors", { "figchat.session": session, kind: "refused" });
        if (awaitingTurn.size > 0 && data.includes('"figaro.aria"') && data.includes('"inquiry"')) openedTurn(data);
        if (asked.size > 0 && data.includes('"figaro.aria"') && data.includes('"role":"output"')) {
          const aria = /"figaro_id":"([^"]+)"/.exec(data)?.[1];
          const at = aria === undefined ? undefined : asked.get(aria);
          if (aria !== undefined && at !== undefined) {
            asked.delete(aria);
            metrics.ms("figchat.gateway.turn.first_token_ms", Date.now() - at, { "figchat.session": session, "figaro.aria": aria });
          }
        }
      }
      send(data, ...rest);
    };
    ws.on("message", (d: Buffer | ArrayBuffer | Buffer[]) => {
      inBytes += Buffer.isBuffer(d) ? d.length : Array.isArray(d) ? d.reduce((n, b) => n + b.length, 0) : d.byteLength;
      inFrames++;
      if (!Buffer.isBuffer(d) || !d.includes('"figaro.qua"')) return;
      const aria = /"figaro_id"\s*:\s*"([^"]+)"/.exec(d.toString())?.[1];
      if (aria !== undefined) asked.set(aria, Date.now());
      if (aria === undefined || !d.includes('"dictation"') || !o.dictations) return;
      let q: { params?: { text?: unknown; dictation?: unknown } };
      try {
        q = JSON.parse(d.toString()) as typeof q;
      } catch {
        return;
      }
      const audioId = q.params?.dictation;
      const text = typeof q.params?.text === "string" ? q.params.text.trim() : "";
      if (typeof audioId === "string" && text !== "" && o.dictations.holds(session, aria, audioId)) awaitingTurn.set(audioId, { aria, text });
    });
    ws.once("close", (code: number, reason: Buffer) => {
      if (code === 1011) metrics.count("figchat.gateway.errors", { "figchat.session": session, kind: "door_closed" });
      const lived = Date.now() - opened;
      const wireOut = sock.bytesWritten - wire0.out;
      const wireIn = sock.bytesRead - wire0.in;
      const deflate = ws.extensions.includes("permessage-deflate");
      log(`door: session closed code=${code} reason=${redact(reason.toString())} lived_ms=${lived} frames_out=${outFrames} bytes_out=${out} wire_out=${wireOut} frames_in=${inFrames} bytes_in=${inBytes} wire_in=${wireIn} deflate=${deflate} session=${session}`);
      if (sp) {
        for (const [k, v] of Object.entries({ "door.frames_out": outFrames, "door.bytes_out": out, "door.wire_out": wireOut, "door.frames_in": inFrames, "door.bytes_in": inBytes, "door.wire_in": wireIn, "door.deflate": deflate, "ws.close_code": code, "ws.lived_ms": lived })) sp.set(k, v);
        sp.end();
      }
    });
  }

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
        ws.send(b, { binary: true, compress: false });
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

function carriesInquiry(part: { inquiry?: unknown; inquiry_segments?: { text?: unknown }[] }, text: string): boolean {
  const said = (s: unknown): boolean => typeof s === "string" && (s.trim() === text || s.trim().startsWith(`${text}\n\n`));
  return said(part.inquiry) || (Array.isArray(part.inquiry_segments) && part.inquiry_segments.some((g) => said(g?.text)));
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
