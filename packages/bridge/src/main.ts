#!/usr/bin/env node
import { parseArgs } from "node:util";
import { defaultSocket, startBridge } from "./bridge.js";

const usage = `figaro-forms-bridge: a loopback WebSocket door for a browser page, relayed to a figaro daemon's unix socket.

Usage: figaro-forms-bridge [--socket PATH] [--port N] [--static DIR] [--origin URL]... [--write]

  --socket PATH  the daemon socket (default $FIGARO_RUNTIME_DIR/angelus.sock, else $XDG_RUNTIME_DIR/figaro/angelus.sock)
  --port N       loopback port (default: any free port)
  --static DIR   serve DIR at / so the page shares the bridge's origin
  --origin URL   also admit pages from URL (repeatable), e.g. http://127.0.0.1:8765
  --write        allow figaro.set and form.create; without it the bridge is read-only

Every connection needs the token printed at start. The page URL carries it in
the fragment (#token=...); the door URL in its query (?token=...).`;

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    port: { type: "string" },
    static: { type: "string" },
    origin: { type: "string", multiple: true },
    write: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(usage + "\n");
  process.exit(0);
}

try {
  const b = await startBridge({
    socket: values.socket ?? defaultSocket(),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.static ? { staticDir: values.static } : {}),
    ...(values.origin ? { origins: values.origin } : {}),
    write: values.write === true,
  });
  process.stdout.write(`door ${b.doorUrl}\n`);
  if (b.pageUrl) process.stdout.write(`page ${b.pageUrl}\n`);
  process.stderr.write(`figaro-forms-bridge: ${values.write ? "read-write" : "read-only"}, listening on ${b.origin}\n`);
  const stop = (): void => void b.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  process.stderr.write(`figaro-forms-bridge: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
