import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Dial } from "../../src/rpc.js";
import { webSocketDial } from "../../src/websocket.js";
import { startFakeModel, type FakeModel } from "./fake-model.js";

export interface Daemon {
  readonly root: string;
  readonly model: FakeModel;
  dial(user: string): Dial;
  figaro(...args: string[]): string;
  newAria(prompt: string): string;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startDaemon(bin: string): Promise<Daemon> {
  const root = mkdtempSync(join(tmpdir(), "ff-daemon-"));
  for (const d of ["home", "config/outfits", "state", "run", "cache", "data", "work"]) mkdirSync(join(root, d), { recursive: true });
  const model = await startFakeModel();
  const web = join(root, "run", "web.sock");
  writeFileSync(
    join(root, "config", "config.toml"),
    `default_outfit = "fake"\n\n[authz]\npolicy = "policy.toml"\n\n[door.web]\npath = "${web}"\nauthn = "upstream"\n\n[authz.upstream]\nissuer = "https://edge.test"\n`,
  );
  writeFileSync(
    join(root, "config", "policy.toml"),
    [
      `[roles.chat]\npermissions = ["read:*", "listen:*", "send:*", "fork:*", "use:*"]`,
      `[roles.viewer]\npermissions = ["read:*", "listen:*"]`,
      `[roles.owner]\npermissions = ["*:*"]`,
      `[[bind]]\nrole = "chat"\nprincipals = ["user:gluck@edge.test"]`,
      `[[bind]]\nrole = "viewer"\nprincipals = ["user:viewer@edge.test"]`,
      `[[bind]]\nrole = "owner"\nprincipals = ["user:${process.getuid?.() ?? 1000}"]`,
    ].join("\n\n") + "\n",
  );
  writeFileSync(join(root, "config", "outfits", "fake.toml"), `[system]\nprovider = "gateway"\nmodel = "fake-1"\n`);
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home"),
    FIGARO_CONFIG_DIR: join(root, "config"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_RUNTIME_DIR: join(root, "run"),
    FIGARO_RUNTIME_DIR: join(root, "run"),
    FIGARO_STATE_DIR: join(root, "state"),
    FIGARO_GATEWAY_BASE_URL: model.url,
  };
  const child: ChildProcess = spawn(bin, ["--angelus"], { env, cwd: join(root, "work"), stdio: "ignore", detached: true });
  const figaro = (...args: string[]): string => {
    const r = spawnSync(bin, args, { env, cwd: join(root, "work"), encoding: "utf8", input: "", timeout: 60_000 });
    if (r.status !== 0) throw new Error(`figaro ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  for (let i = 0; i < 100 && !(existsSync(web) && existsSync(join(root, "run", "angelus.sock"))); i++) await sleep(100);
  if (!existsSync(web)) {
    child.kill("SIGKILL");
    throw new Error("the disposable daemon did not open its web socket");
  }
  return {
    root,
    model,
    figaro,
    dial: (user) =>
      webSocketDial({
        url: `ws+unix://${web}:/door`,
        credential: { name: "test-edge", upgrade: () => ({ headers: { "Remote-User": user } }) },
        WebSocket: WebSocket as unknown as NonNullable<Parameters<typeof webSocketDial>[0]["WebSocket"]>,
      }),
    newAria: (prompt) => {
      const out = figaro("new", "-j", "--", prompt);
      const id = /"aria_id":"([0-9a-f]+)"/.exec(out)?.[1];
      if (!id) throw new Error(`no aria id in ${out}`);
      return id;
    },
    stop: async () => {
      spawnSync(bin, ["stop", "-f"], { env, cwd: join(root, "work"), input: "", timeout: 30_000 });
      await sleep(300);
      if (child.pid) spawnSync("kill", ["-KILL", "--", `-${child.pid}`]);
      await model.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
