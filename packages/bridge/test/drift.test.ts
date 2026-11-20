import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDoor } from "../../figaro-forms/test/fake-door.js";
import { startBridge, type Bridge, type BridgeOptions } from "../src/bridge.js";
import { cachedDrift, DriftCheckFailed, mapDrift, parseCheck, runCheck, type CheckRow, type CheckRun, type DriftDaemon, type DriftReport } from "../src/drift.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const at = () => new Date("2026-11-20T04:00:00Z");

function daemon(forms: Record<string, Record<string, unknown>>, outfits: Record<string, Record<string, unknown>> = {}): DriftDaemon {
  return {
    forms: async () => Object.entries(forms).map(([id, s]) => (typeof s["role-name"] === "string" ? { id, roleName: s["role-name"] } : { id })),
    read: async (id) => {
      const f = forms[id];
      if (!f) throw new Error(`figaro.form: aria ${id} not found`);
      return f;
    },
    fold: async (names) => {
      const lost = names.find((n) => !outfits[n]);
      if (lost) throw new Error(`outfit ${lost} not found`);
      return Object.assign({}, ...names.map((n) => outfits[n]));
    },
  };
}

const eng = "@ee9271497f3823d7f50922bec4899818";
const mayor = "@2b4fe37fc20436ff3123373ed0a504f6";

describe("drift mapping", () => {
  const forms = {
    "@96447061aaaabbbbccccddddeeeeffff": { "role-name": "King of Spain", "target-aria": "k" },
    [eng]: { "role-name": "Figaro Engineer", "target-aria": "e", fanout: { "when-full": "old" }, system: { fanout: { max_children: 2 } } },
    [mayor]: { "role-name": "El Mayor", "target-aria": "m", lifecycle: "seated" },
    "@4a845160c69f9aaaabbbbccccdddd00": { "role-name": "Merlin Migration" },
    "@51baf7237560faaaabbbbccccdddd00": { "role-name": "TV QA" },
    "@03c43ce0aaaabbbbccccddddeeee0000": { note: "not a role" },
  };
  const outfits = { "role-engineer-fields": { fanout: { "when-full": "new" } }, "role-mayor-fields": { lifecycle: { status: "routing-alias" } } };

  const rows: CheckRow[] = [
    { role: "king-of-spain", form: "@96447061", outcome: "unchanged", outfits: ["role-king-fields"] },
    { role: "figaro-engineer", form: eng, outcome: "would-apply", outfits: ["role-engineer-fields"], set: ["fanout"], remove: ["system.fanout.max_children"] },
    { role: "el-mayor", form: mayor, outcome: "error", error: "figaro form apply: refused" },
    { role: "merlin-migration", form: "@4a845160c69f9aaaabbbbccccdddd00", outcome: "would-apply", unseated: true, outfits: ["role-mayor-fields"], set: ["lifecycle"] },
    { role: "ghost-role", form: "@deadbeefdeadbeefdeadbeefdeadbeef", outcome: "error", error: "figaro state show: not found" },
  ];

  it("maps every outcome to Zanni's shape, with exact JSON values", async () => {
    const r = await mapDrift(rows, daemon(forms, outfits), at);
    expect(r.generated_at).toBe("2026-11-20T04:00:00.000Z");
    expect(r.source).toBe("figaro-apply --check");
    const by = Object.fromEntries(r.roles.map((x) => [x.role, x]));
    expect(by["king-of-spain"]).toEqual({ role: "king-of-spain", id: "@96447061aaaabbbbccccddddeeeeffff", status: "ok", changes: [] });
    expect(by["figaro-engineer"]).toEqual({
      role: "figaro-engineer",
      id: eng,
      status: "drift",
      changes: [
        { key: "fanout", live: '{"when-full":"old"}', want: '{"when-full":"new"}' },
        { key: "system.fanout.max_children", live: "2", want: null },
      ],
    });
    expect(by["el-mayor"]).toEqual({ role: "el-mayor", id: mayor, status: "error", changes: [], error: "figaro form apply: refused" });
    expect(by["merlin-migration"]).toEqual({
      role: "merlin-migration",
      id: "@4a845160c69f9aaaabbbbccccdddd00",
      status: "drift",
      unseated: true,
      changes: [{ key: "lifecycle", live: null, want: '{"status":"routing-alias"}' }],
    });
    expect(by["ghost-role"]).toEqual({ role: "ghost-role", id: "@deadbeefdeadbeefdeadbeefdeadbeef", status: "missing", changes: [] });
    expect(by["TV QA"]).toEqual({ role: "TV QA", id: "@51baf7237560faaaabbbbccccdddd00", status: "extra", changes: [] });
    expect(r.roles.map((x) => x.id)).not.toContain("@03c43ce0aaaabbbbccccddddeeee0000");
    expect(r.roles.filter((x) => x.status === "extra").map((x) => x.role)).toEqual(["TV QA"]);
  });

  it("an unseated role in line is ok and unseated", async () => {
    const r = await mapDrift([{ role: "merlin-migration", form: "@4a845160c69f9aaaabbbbccccdddd00", outcome: "unchanged", unseated: true }], daemon(forms), at);
    expect(r.roles[0]).toEqual({ role: "merlin-migration", id: "@4a845160c69f9aaaabbbbccccdddd00", status: "ok", unseated: true, changes: [] });
  });

  it("a drift it cannot value is an error, never a drift without values", async () => {
    const noOutfits = await mapDrift([{ role: "figaro-engineer", form: eng, outcome: "would-apply", set: ["fanout"] }], daemon(forms), at);
    expect(noOutfits.roles[0]).toMatchObject({ status: "error", error: expect.stringMatching(/names no outfits/) });
    const lost = await mapDrift([{ role: "figaro-engineer", form: eng, outcome: "would-apply", outfits: ["gone"], set: ["fanout"] }], daemon(forms), at);
    expect(lost.roles[0]).toMatchObject({ status: "error", error: "outfit gone not found" });
    const keyless = await mapDrift([{ role: "figaro-engineer", form: eng, outcome: "would-apply", outfits: ["role-engineer-fields"] }], daemon(forms, outfits), at);
    expect(keyless.roles[0]).toMatchObject({ status: "error", error: expect.stringMatching(/names no key/) });
    const odd = await mapDrift([{ role: "figaro-engineer", form: eng, outcome: "applied" }], daemon(forms), at);
    expect(odd.roles[0]).toMatchObject({ status: "error", error: expect.stringMatching(/not a check verdict/) });
  });

  it("a short form id matches its live form by prefix, and never below 8 hex", async () => {
    const r = await mapDrift([{ role: "x", form: "@96447", outcome: "unchanged" }], daemon({ "@96447061": { "role-name": "King" } }), at);
    expect(r.roles.map((x) => [x.role, x.status])).toEqual([
      ["x", "missing"],
      ["King", "extra"],
    ]);
  });
});

describe("a check run", () => {
  const line = (o: object): string => JSON.stringify(o) + "\n";
  const ok = line({ role: "a", form: "@aaaaaaaa", outcome: "unchanged" });
  const bad = line({ role: "b", form: "@bbbbbbbb", outcome: "error", error: "boom" });
  const off = line({ role: "c", form: "@cccccccc", outcome: "would-apply", set: ["k"] });

  it("is read when it exits 0 clean, or 1 with exactly its failed or drifting rows tallied", () => {
    expect(parseCheck({ code: 0, stdout: ok, stderr: "" })).toHaveLength(1);
    expect(parseCheck({ code: 1, stdout: ok + bad + off, stderr: "figaro-apply: 1 of 3 roles failed\n" })).toHaveLength(3);
    expect(parseCheck({ code: 1, stdout: ok + off, stderr: "figaro-apply: 1 of 2 roles drift; run without --check to apply\n" })).toHaveLength(2);
  });

  it("fails on any other exit, a tally that disagrees, or a line that is not a row", () => {
    const fails: [string, CheckRun][] = [
      ["exit 2", { code: 2, stdout: ok, stderr: "usage" }],
      ["exit 1 with no tally", { code: 1, stdout: ok + bad, stderr: "Traceback" }],
      ["exit 1 tally disagrees", { code: 1, stdout: ok + bad, stderr: "figaro-apply: 2 of 2 roles failed" }],
      ["exit 1 with no error row", { code: 1, stdout: ok, stderr: "figaro-apply: 0 of 1 roles failed" }],
      ["exit 1 cut short", { code: 1, stdout: bad, stderr: "figaro-apply: 1 of 2 roles failed" }],
      ["exit 1 drift tallied over a failure", { code: 1, stdout: bad + off, stderr: "figaro-apply: 1 of 2 roles drift; run without --check to apply" }],
      ["exit 1 drift miscounted", { code: 1, stdout: ok + off, stderr: "figaro-apply: 2 of 2 roles drift; run without --check to apply" }],
      ["exit 1 on a bad manifest", { code: 1, stdout: "", stderr: "figaro-apply: manifest: open roles.json: no such file" }],
      ["exit 0 with no rows", { code: 0, stdout: "", stderr: "" }],
      ["error row with exit 0", { code: 0, stdout: bad, stderr: "" }],
      ["drift row with exit 0", { code: 0, stdout: off, stderr: "" }],
      ["killed", { code: null, stdout: ok, stderr: "spawn figaro-apply ENOENT" }],
      ["not JSON", { code: 0, stdout: ok + "Traceback (most recent call last):\n", stderr: "" }],
      ["not a row", { code: 0, stdout: line({ role: "a" }), stderr: "" }],
    ];
    for (const [name, run] of fails) expect(() => parseCheck(run), name).toThrow(DriftCheckFailed);
  });

  it("runs the command with --check -j and keeps its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ffd-"));
    const cmd = join(dir, "apply");
    writeFileSync(cmd, `#!/bin/sh\necho "$@" >&2\necho '{"role":"a","form":"@aaaaaaaa","outcome":"unchanged"}'\nexit 3\n`);
    chmodSync(cmd, 0o755);
    expect(await runCheck(cmd)).toEqual({ code: 3, stdout: '{"role":"a","form":"@aaaaaaaa","outcome":"unchanged"}\n', stderr: "--check -j\n" });
    const missing = await runCheck(join(dir, "nothing"));
    expect(missing.code).toBeNull();
    expect(missing.stderr).toMatch(/ENOENT/);
  });

  it("is cached for the window and never run twice at once", async () => {
    let runs = 0;
    let t = 0;
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const report: DriftReport = { generated_at: "g", source: "figaro-apply --check", roles: [] };
    const src = cachedDrift(
      async () => {
        runs++;
        await gate;
        return report;
      },
      60_000,
      () => t,
    );
    const both = Promise.all([src.get(), src.get()]);
    release();
    await both;
    expect(runs).toBe(1);
    t = 59_999;
    await src.get();
    expect(runs).toBe(1);
    t = 60_000;
    await src.get();
    expect(runs).toBe(2);
  });

  it("does not keep a failure", async () => {
    let runs = 0;
    const src = cachedDrift(async () => {
      runs++;
      throw new DriftCheckFailed("nope");
    });
    await expect(src.get()).rejects.toThrow("nope");
    await expect(src.get()).rejects.toThrow("nope");
    expect(runs).toBe(2);
  });
});

async function fakeDaemon(door: FakeDoor): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ffd-"));
  const path = join(dir, "angelus.sock");
  const srv: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    void door.dial({ message: (frame) => sock.write(frame + "\n"), closed: () => sock.end() }).then((s) => {
      sock.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          s.send(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      sock.on("close", () => s.close());
    });
  });
  await new Promise<void>((ok) => srv.listen(path, ok));
  cleanups.push(() => new Promise<void>((ok) => srv.close(() => ok())));
  return path;
}

function orderDoor(): FakeDoor {
  const door = new FakeDoor();
  door.add("@king0000", { "role-name": "King", "target-aria": "ak" });
  door.add("@eng00000", { "role-name": "Engineer", "target-aria": "ae", fanout: 1 });
  door.outfits.set("role-eng-fields", { fanout: 2 });
  door.rows = [
    { id: "@king0000", kind: "form", state: "form", target_aria: "ak", parent: "" },
    { id: "@eng00000", kind: "form", state: "form", target_aria: "ae", parent: "@king0000" },
    { id: "ak", kind: "conversation", state: "active" },
    { id: "ae", kind: "conversation", state: "active" },
  ];
  return door;
}

const driftTally = "figaro-apply: 1 of 2 roles drift; run without --check to apply\n";
const checkOut =
  JSON.stringify({ role: "king", form: "@king0000", outcome: "unchanged", outfits: ["role-king-fields"] }) +
  "\n" +
  JSON.stringify({ role: "engineer", form: "@eng00000", outcome: "would-apply", outfits: ["role-eng-fields"], set: ["fanout"] }) +
  "\n";

async function bridge(extra: Partial<BridgeOptions> = {}, run: () => Promise<CheckRun> = async () => ({ code: 1, stdout: checkOut, stderr: driftTally })): Promise<Bridge> {
  const b = await startBridge({ socket: await fakeDaemon(orderDoor()), checkRun: run, ...extra });
  cleanups.push(() => b.close());
  return b;
}

function get(b: Bridge, path: string, headers: Record<string, string> = {}): Promise<{ code: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request(`${b.origin}${path}`, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => ok({ code: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("GET /drift", () => {
  it("answers the owner's check with live and wanted values, to a bearer", async () => {
    const b = await bridge();
    expect((await get(b, "/drift")).code).toBe(401);
    const r = await get(b, "/drift", { Authorization: `Bearer ${b.token}` });
    expect(r.code).toBe(200);
    const body = JSON.parse(r.body) as DriftReport;
    expect(body.roles).toEqual([
      { role: "king", id: "@king0000", status: "ok", changes: [] },
      { role: "engineer", id: "@eng00000", status: "drift", changes: [{ key: "fanout", live: "1", want: "2" }] },
    ]);
  });

  it("starts one check for overlapping loads, and they all get its answer", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const b = await bridge({}, async () => {
      runs++;
      await gate;
      return { code: 1, stdout: checkOut, stderr: driftTally };
    });
    const auth = { Authorization: `Bearer ${b.token}` };
    const loads = Promise.all([get(b, "/drift", auth), get(b, "/drift", auth), get(b, "/drift", auth)]);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(runs).toBe(1);
    release();
    const answers = await loads;
    expect(answers.map((a) => a.code)).toEqual([200, 200, 200]);
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
    expect(runs).toBe(1);
  });

  it("shares a failing run too, and does not keep it", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const b = await bridge({}, async () => {
      runs++;
      await gate;
      return { code: 2, stdout: "", stderr: "boom" };
    });
    const auth = { Authorization: `Bearer ${b.token}` };
    const loads = Promise.all([get(b, "/drift", auth), get(b, "/drift", auth)]);
    await new Promise((ok) => setTimeout(ok, 50));
    release();
    expect((await loads).map((a) => a.code)).toEqual([502, 502]);
    expect(runs).toBe(1);
    expect((await get(b, "/drift", auth)).code).toBe(502);
    expect(runs).toBe(2);
  });

  it("answers a failed run with 502 and the error, never an empty list", async () => {
    const b = await bridge({}, async () => ({ code: 2, stdout: "", stderr: "figaro: system.fanout is refused inside a figaro" }));
    const r = await get(b, "/drift", { Authorization: `Bearer ${b.token}` });
    expect(r.code).toBe(502);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body).toEqual({ error: expect.stringContaining("system.fanout is refused") });
    expect(body.roles).toBeUndefined();
    const garbled = await bridge({}, async () => ({ code: 0, stdout: "{not json\n", stderr: "" }));
    expect((await get(garbled, "/drift", { Authorization: `Bearer ${garbled.token}` })).code).toBe(502);
  });
});

describe("--edge", () => {
  const secret = randomBytes(32).toString("base64url");
  const edge = { secret, peers: ["127.0.0.1"], admin: "admin" };
  const good = { "X-Figaro-Edge": secret, "Remote-User": "admin", Host: "order.kelliher.info" };

  it("serves /hierarchy and /drift to the edge, signed in as the admin, and nothing else", async () => {
    const b = await bridge({ edge });
    const h = await get(b, "/hierarchy", good);
    expect(h.code).toBe(200);
    expect(JSON.parse(h.body)).toMatchObject({ status: "current" });
    const d = await get(b, "/drift", good);
    expect(d.code).toBe(200);
    expect((JSON.parse(d.body) as DriftReport).roles).toHaveLength(2);
    expect((await get(b, "/", good)).code).toBe(404);
    expect((await get(b, `/door?token=${b.token}`, good)).code).toBe(404);
  });

  for (const [name, headers] of [
    ["no secret", { "Remote-User": "admin" }],
    ["a wrong secret", { "X-Figaro-Edge": secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A"), "Remote-User": "admin" }],
    ["a short secret", { "X-Figaro-Edge": secret.slice(0, 8), "Remote-User": "admin" }],
    ["a bearer instead", { Authorization: "Bearer x", "Remote-User": "admin" }],
  ] as const) {
    it(`refuses ${name} before reading the request`, async () => {
      let runs = 0;
      const b = await bridge({ edge }, async () => {
        runs++;
        return { code: 0, stdout: checkOut, stderr: "" };
      });
      for (const path of ["/hierarchy", "/drift", "/"]) expect(await get(b, path, headers)).toEqual({ code: 403, body: "not from the edge" });
      expect(runs).toBe(0);
    });
  }

  it("refuses a peer outside the allowlist even with the secret", async () => {
    const b = await bridge({ edge: { ...edge, peers: ["10.0.0.9"] } });
    expect(await get(b, "/drift", good)).toEqual({ code: 403, body: "not from the edge" });
  });

  it("refuses any Remote-User but the admin", async () => {
    const b = await bridge({ edge });
    for (const user of [{ "Remote-User": "gluck" }, {}]) {
      expect(await get(b, "/drift", { "X-Figaro-Edge": secret, ...user })).toEqual({ code: 403, body: "admin only" });
    }
  });

  it("refuses to start with a short secret, no peer, a bad peer, no admin, or door options", async () => {
    const s = "/nonexistent";
    await expect(startBridge({ socket: s, edge: { ...edge, secret: "x".repeat(31) } })).rejects.toThrow(/32 bytes/);
    await expect(startBridge({ socket: s, edge: { ...edge, peers: [] } })).rejects.toThrow(/--peer/);
    await expect(startBridge({ socket: s, edge: { ...edge, peers: ["spain"] } })).rejects.toThrow(/not an IP/);
    await expect(startBridge({ socket: s, edge: { ...edge, admin: "" } })).rejects.toThrow(/--admin/);
    for (const extra of [{ write: true }, { staticDir: "/tmp" }, { origins: ["http://127.0.0.1:1"] }, { frameOrigins: ["http://127.0.0.1:1"] }]) {
      await expect(startBridge({ socket: s, edge, ...extra })).rejects.toThrow(/--edge serves/);
    }
  });

  it("opens no door", async () => {
    const b = await bridge({ edge });
    const status = await new Promise<string>((ok) => {
      const ws = new WebSocket(b.doorUrl);
      ws.onopen = () => (ws.close(), ok("open"));
      ws.onerror = () => ok("refused");
    });
    expect(status).toBe("refused");
  });
});
