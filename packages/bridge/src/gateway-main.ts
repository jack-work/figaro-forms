#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { webSocketDial } from "figaro-forms";
import { bearer, type Credential } from "figaro-forms/auth";
import { onBehalfOf, redact } from "./door.js";
import { ClientCredentials, doorTokenPath, redialAfterRejection } from "./token.js";
import { startGateway, type GatewayListen } from "./gateway.js";
import { speechOverSocket } from "./speech.js";
import { sttRoute } from "./stt.js";

const usage = `figaro-gateway: the door, passed through, and a speech side channel for the figaro web client.

Usage: figaro-gateway --door-url URL --speech-socket PATH --admin USER --store NAME
                       (--listen-socket PATH [--mode OCTAL] | --port N --peer ADDR...)
                       [--edge-secret-file PATH] [--origin URL]...
                       [--door-token-file PATH | --token-url URL --client-id ID --client-secret-file PATH [--audience URL]]

  --door-url URL        the figaro door, e.g. wss://gluck.tailnet.ts.net:7445/door
                        (ws+unix://PATH:/door for a daemon's web socket)
  --door-token-file P   bearer for the door (default $CREDENTIALS_DIRECTORY/door);
                        without a file the door is dialled with no credential
  --token-url URL       mint the door bearer with an OAuth client_credentials grant at URL
                        (e.g. https://auth.kelliher.info/api/oidc/token); fetched at start,
                        refreshed at 80% of expires_in, and again after a 401 on dial
  --client-id ID        the client (e.g. figaro-gateway)
  --client-secret-file P  its secret (default $CREDENTIALS_DIRECTORY/client-secret); never logged
  --audience URL        the audience asked for (e.g. https://fig.kelliher.info)
  --on-behalf-of        send X-Figaro-On-Behalf-Of: <Remote-User> on each door dial, so the
                        daemon seats the connection as that user (needs [[authz.delegation]]
                        on the daemon; without a match the door answers 403)
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
(a recording in, {text, duration_ms, audio_id} out), POST /stt/key/<key> (re-transcribe a stored clip).`;

const { values } = parseArgs({
  options: {
    "door-url": { type: "string" },
    "door-token-file": { type: "string" },
    "token-url": { type: "string" },
    "client-id": { type: "string" },
    "client-secret-file": { type: "string" },
    audience: { type: "string" },
    "on-behalf-of": { type: "boolean" },
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
  const doorPath = doorTokenPath({
    flag: values["door-token-file"],
    credentialsDirectory: process.env.CREDENTIALS_DIRECTORY,
    tokenMode: Boolean(values["token-url"]),
    exists: existsSync,
  });
  const token = doorPath ? readFileSync(doorPath, "utf8").trim() : undefined;
  const secret = credential(values["edge-secret-file"], "edge", true) as string;
  let minter: ClientCredentials | undefined;
  if (values["token-url"]) {
    if (!values["client-id"]) throw new Error("--token-url needs --client-id");
    const secretPath = values["client-secret-file"] ?? (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, "client-secret") : undefined);
    if (!secretPath) throw new Error("--token-url needs --client-secret-file or a LoadCredential named client-secret");
    minter = new ClientCredentials({
      tokenUrl: values["token-url"],
      clientId: values["client-id"],
      secret: () => readFileSync(secretPath, "utf8").trim(),
      ...(values.audience ? { audience: values.audience } : {}),
      log: (line) => process.stderr.write(`figaro-gateway: ${line}\n`),
    });
    await minter.start();
  }
  const listen: GatewayListen = values.port
    ? { port: Number(values.port), host: "127.0.0.1" }
    : { path: values["listen-socket"] ?? "/run/figaro-gateway/gateway.sock", mode: values.mode ? parseInt(values.mode, 8) : 0o660 };
  const g = await startGateway({
    listen,
    edge: { secret, admin: values.admin ?? "", ...(values.port ? { peers: values.peer ?? [] } : {}) },
    door: (user) => {
      const base: Credential | undefined = minter ? bearer(() => (minter as ClientCredentials).token()) : token ? bearer(token) : undefined;
      const credential = base && values["on-behalf-of"] ? onBehalfOf(base, user) : base;
      const dial = webSocketDial({
        url,
        ...(credential ? { credential } : {}),
        WebSocket: WebSocket as unknown as NonNullable<Parameters<typeof webSocketDial>[0]["WebSocket"]>,
      });
      return minter ? redialAfterRejection(dial, (g) => (minter as ClientCredentials).rejected(g), () => (minter as ClientCredentials).generation) : dial;
    },
    speech: speechOverSocket(values["speech-socket"]),
    speechSocket: values["speech-socket"],
    store: values.store,
    routes: sttRoute({ socket: values["speech-socket"], store: values.store }),
    ...(values.origin ? { origins: values.origin } : {}),
  });
  process.stderr.write(`figaro-gateway: listening on ${g.address}, door ${redact(url)}\n`);
  const stop = (): void => void g.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  process.stderr.write(`figaro-gateway: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
