#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultSocket, startBridge, type EdgeGate } from "./bridge.js";

const usage = `figaro-forms-bridge: a loopback WebSocket door for a browser page, relayed to a figaro daemon's unix socket.

Usage: figaro-forms-bridge [--socket PATH] [--port N] [--static DIR [--frame-src ORIGIN]...] [--origin URL]... [--write [--write-system]]
       figaro-forms-bridge --edge --peer ADDR... --admin USER [--edge-secret-file PATH] --port N [--socket PATH]

  --socket PATH  the daemon socket (default $FIGARO_RUNTIME_DIR/angelus.sock, else $XDG_RUNTIME_DIR/figaro/angelus.sock)
  --port N       loopback port (default: any free port)
  --edge         serve GET /hierarchy and GET /drift and nothing else, to an edge proxy
                 reaching loopback through a tunnel: every request must come from a
                 --peer, carry the edge secret in X-Figaro-Edge, and name --admin in
                 Remote-User. No door, no pages, no bearer
  --peer ADDR    with --edge, an address the edge proxy connects from (repeatable)
  --admin USER   with --edge, the one Remote-User served
  --edge-secret-file PATH
                 with --edge, the shared secret (32 bytes or more); default
                 $CREDENTIALS_DIRECTORY/edge, from LoadCredential=edge:...
  --drift-command PATH
                 what GET /drift runs with --check -j (default figaro-apply)
  --static DIR   serve DIR at / so the page shares the bridge's origin, files only,
                 under a CSP with no inline script or style and no eval
  --frame-src ORIGIN
                 let the static page frame pages from ORIGIN (repeatable), e.g.
                 http://127.0.0.1:8765; never the bridge's own origin, whose
                 pages could read the token, and never an --origin: framed
                 pages must not reach the door
  --origin URL   also admit pages from URL (repeatable), e.g. http://127.0.0.1:8765;
                 every page served on that origin gets the bridge's reach, which is
                 the owner's
  --write        allow figaro.set and form.create, except on system.*, daemon-written
                 keys and outfits; without it the bridge is read-only
  --write-system with --write, allow those too: a page holding the token can then
                 rewire any aria's provider, tools and environment

FIGARO_FORMS_BRIDGE_TOKEN, when set, is the token; it is then never printed.
Otherwise every connection needs the token printed at start. The page URL carries it in
the fragment (#token=...); the door URL in its query (?token=...). The token is
printed once on stdout: never pipe it into a log or journal others can read.`;

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    port: { type: "string" },
    edge: { type: "boolean" },
    peer: { type: "string", multiple: true },
    admin: { type: "string" },
    "edge-secret-file": { type: "string" },
    "drift-command": { type: "string" },
    static: { type: "string" },
    origin: { type: "string", multiple: true },
    "frame-src": { type: "string", multiple: true },
    write: { type: "boolean" },
    "write-system": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(usage + "\n");
  process.exit(0);
}

if (values["write-system"] && !values.write) {
  process.stderr.write("figaro-forms-bridge: --write-system needs --write\n");
  process.exit(2);
}

function edgeGate(): EdgeGate | undefined {
  if (!values.edge) {
    if (values.peer || values.admin || values["edge-secret-file"]) throw new Error("--peer, --admin and --edge-secret-file need --edge");
    return undefined;
  }
  let path = values["edge-secret-file"];
  if (!path) {
    const dir = process.env.CREDENTIALS_DIRECTORY;
    if (!dir) throw new Error("--edge needs --edge-secret-file or a LoadCredential named edge");
    path = join(dir, "edge");
  }
  return { secret: readFileSync(path, "utf8").trim(), peers: values.peer ?? [], admin: values.admin ?? "" };
}

const given = process.env.FIGARO_FORMS_BRIDGE_TOKEN;
delete process.env.FIGARO_FORMS_BRIDGE_TOKEN;

try {
  const edge = edgeGate();
  const b = await startBridge({
    socket: values.socket ?? defaultSocket(),
    ...(given ? { token: given } : {}),
    ...(edge ? { edge } : {}),
    ...(values["drift-command"] ? { driftCommand: values["drift-command"] } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.static ? { staticDir: values.static } : {}),
    ...(values.origin ? { origins: values.origin } : {}),
    ...(values["frame-src"] ? { frameOrigins: values["frame-src"] } : {}),
    write: values.write === true,
    writeSystem: values["write-system"] === true,
  });
  if (edge) {
    process.stdout.write(`edge ${b.origin}/hierarchy ${b.origin}/drift\n`);
  } else if (given) {
    process.stdout.write(`door ${b.doorUrl.replace(/token=.*$/, "token=<FIGARO_FORMS_BRIDGE_TOKEN>")}\n`);
    if (b.pageUrl) process.stdout.write(`page ${b.origin}/#token=<FIGARO_FORMS_BRIDGE_TOKEN>\n`);
  } else {
    process.stdout.write(`door ${b.doorUrl}\n`);
    if (b.pageUrl) process.stdout.write(`page ${b.pageUrl}\n`);
  }
  const mode = edge ? `edge for ${edge.admin} from ${edge.peers.join(",")}` : values.write ? (values["write-system"] ? "read-write, owner-held keys included" : "read-write, owner-held keys refused") : "read-only";
  process.stderr.write(`figaro-forms-bridge: ${mode}, listening on ${b.origin}\n`);
  const stop = (): void => void b.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  process.stderr.write(`figaro-forms-bridge: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
