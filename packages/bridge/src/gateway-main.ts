#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { webSocketDial } from "figaro-forms";
import { bearer } from "figaro-forms/auth";
import { startGateway, type GatewayListen } from "./gateway.js";
import { speechOverSocket } from "./speech.js";
import { sttRoute } from "./stt.js";

const usage = `figaro-gateway: the door, passed through, and a speech side channel for the figaro web client.

Usage: figaro-gateway --door-url URL --speech-socket PATH --admin USER --store NAME
                       (--listen-socket PATH [--mode OCTAL] | --port N --peer ADDR...)
                       [--edge-secret-file PATH] [--door-token-file PATH] [--origin URL]...

  --door-url URL        the figaro door, e.g. wss://gluck.tailnet.ts.net:7445/door
                        (ws+unix://PATH:/door for a daemon's web socket)
  --door-token-file P   bearer for the door (default $CREDENTIALS_DIRECTORY/door);
                        without a file the door is dialled with no credential
  --speech-socket PATH  figchat-speech, e.g. /run/figchat/speech.sock
  --store NAME          the store id in audio keys, <store>/<aria>:<turn>/out
  --listen-socket PATH  serve on a unix socket (default /run/figaro-gateway/gateway.sock mode 0660;
                        the unit's Group= and UMask= decide who reaches it)
  --port N --peer ADDR  serve on loopback TCP instead; --peer is the edge's address
  --admin USER          the one Remote-User served
  --edge-secret-file P  shared secret, 32 bytes or more (default $CREDENTIALS_DIRECTORY/edge)
  --origin URL          also admit pages from URL (same-origin pages always pass)

Routes behind the edge gate: /door (WebSocket, JSON-RPC, aria methods), /audio/<aria>
(WebSocket, audio frames), GET /audio/key/<key> (replay from the speech service), POST /stt?aria=<store>/<aria>
(a recording in, {text, duration_ms, audio_id} out).`;

const { values } = parseArgs({
  options: {
    "door-url": { type: "string" },
    "door-token-file": { type: "string" },
    "speech-socket": { type: "string" },
    store: { type: "string" },
    "listen-socket": { type: "string" },
    mode: { type: "string" },
    port: { type: "string" },
    peer: { type: "string", multiple: true },
    admin: { type: "string" },
    "edge-secret-file": { type: "string" },
    origin: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(usage + "\n");
  process.exit(0);
}

const credential = (flag: string | undefined, name: string, required: boolean): string | undefined => {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  const path = flag ?? (dir ? join(dir, name) : undefined);
  if (!path) {
    if (required) throw new Error(`need --${name === "edge" ? "edge-secret-file" : "door-token-file"} or a LoadCredential named ${name}`);
    return undefined;
  }
  return readFileSync(path, "utf8").trim();
};

try {
  const url = values["door-url"];
  if (!url) throw new Error("--door-url is required");
  if (!values["speech-socket"]) throw new Error("--speech-socket is required");
  if (!values.store) throw new Error("--store is required");
  const token = credential(values["door-token-file"], "door", false);
  const secret = credential(values["edge-secret-file"], "edge", true) as string;
  const listen: GatewayListen = values.port
    ? { port: Number(values.port), host: "127.0.0.1" }
    : { path: values["listen-socket"] ?? "/run/figaro-gateway/gateway.sock", mode: values.mode ? parseInt(values.mode, 8) : 0o660 };
  const g = await startGateway({
    listen,
    edge: { secret, admin: values.admin ?? "", ...(values.port ? { peers: values.peer ?? [] } : {}) },
    door: () =>
      webSocketDial({
        url,
        ...(token ? { credential: bearer(token) } : {}),
        WebSocket: WebSocket as unknown as NonNullable<Parameters<typeof webSocketDial>[0]["WebSocket"]>,
      }),
    speech: speechOverSocket(values["speech-socket"]),
    speechSocket: values["speech-socket"],
    store: values.store,
    routes: sttRoute({ socket: values["speech-socket"], store: values.store }),
    ...(values.origin ? { origins: values.origin } : {}),
  });
  process.stderr.write(`figaro-gateway: listening on ${g.address}, door ${url.replace(/\?.*$/, "")}\n`);
  const stop = (): void => void g.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  process.stderr.write(`figaro-gateway: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
