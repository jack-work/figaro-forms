#!/usr/bin/env node
import { parseArgs } from "node:util";
import { defaultSocket, startBridge } from "./bridge.js";

const usage = `figaro-forms-bridge: a loopback WebSocket door for a browser page, relayed to a figaro daemon's unix socket.

Usage: figaro-forms-bridge [--socket PATH] [--port N] [--static DIR] [--origin URL]... [--write [--write-system]]

  --socket PATH  the daemon socket (default $FIGARO_RUNTIME_DIR/angelus.sock, else $XDG_RUNTIME_DIR/figaro/angelus.sock)
  --port N       loopback port (default: any free port)
  --static DIR   serve DIR at / so the page shares the bridge's origin
  --origin URL   also admit pages from URL (repeatable), e.g. http://127.0.0.1:8765;
                 every page served on that origin gets the bridge's reach, which is
                 the owner's
  --write        allow figaro.set and form.create, except on system.*, daemon-written
                 keys and outfits; without it the bridge is read-only
  --write-system with --write, allow those too: a page holding the token can then
                 rewire any aria's provider, tools and environment

Every connection needs the token printed at start. The page URL carries it in
the fragment (#token=...); the door URL in its query (?token=...). The token is
printed once on stdout: never pipe it into a log or journal others can read.`;

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    port: { type: "string" },
    static: { type: "string" },
    origin: { type: "string", multiple: true },
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

try {
  const b = await startBridge({
    socket: values.socket ?? defaultSocket(),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.static ? { staticDir: values.static } : {}),
    ...(values.origin ? { origins: values.origin } : {}),
    write: values.write === true,
    writeSystem: values["write-system"] === true,
  });
  process.stdout.write(`door ${b.doorUrl}\n`);
  if (b.pageUrl) process.stdout.write(`page ${b.pageUrl}\n`);
  const mode = values.write ? (values["write-system"] ? "read-write, owner-held keys included" : "read-write, owner-held keys refused") : "read-only";
  process.stderr.write(`figaro-forms-bridge: ${mode}, listening on ${b.origin}\n`);
  const stop = (): void => void b.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  process.stderr.write(`figaro-forms-bridge: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
