import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, type Dial, type SocketEvents } from "../src/rpc.js";

function dialer(lifeMs: number | undefined, helloFails = false) {
  const opened: number[] = [];
  const dial: Dial = async (ev: SocketEvents) => {
    opened.push(Date.now());
    if (lifeMs !== undefined) setTimeout(() => ev.closed("lapsed"), lifeMs);
    return { send: () => {}, close: () => {} };
  };
  const onOpen = helloFails
    ? async () => {
        await new Promise((r) => setTimeout(r, 10_000));
        throw new Error("hello: no answer in 10000 ms");
      }
    : undefined;
  return { dial, opened, onOpen };
}

async function run(ms: number) {
  for (let t = 0; t < ms; t += 1000) await vi.advanceTimersByTimeAsync(1000);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Connection against a server that drops every fresh socket", () => {
  it("stops after five sockets die young, instead of reconnecting all hour", async () => {
    const d = dialer(16_000);
    const c = new Connection({ dial: d.dial });
    const states: string[] = [];
    c.onState((s) => states.push(s));
    await run(3_600_000);
    expect(d.opened.length).toBe(5);
    expect(c.state).toBe("signedout");
    expect(c.error).toBe("lapsed");
    await expect(c.call("figaro.list", {})).rejects.toThrow(/lapsed/);
    c.close();
  });

  it("grows the wait between young deaths rather than reconnecting at once", async () => {
    const d = dialer(16_000);
    const c = new Connection({ dial: d.dial, youngDeathsBeforeSignedOut: 100 });
    await run(600_000);
    const gaps = d.opened.slice(1).map((t, i) => t - d.opened[i]! - 16_000);
    expect(gaps[0]).toBeLessThan(1_000);
    expect(gaps.at(-1)).toBeGreaterThan(20_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000 * 1.25);
    c.close();
  });

  it("treats a hello that never answers as a young death", async () => {
    const d = dialer(undefined, true);
    const c = new Connection({ dial: d.dial, ...(d.onOpen ? { onOpen: d.onOpen } : {}) });
    await run(3_600_000);
    expect(d.opened.length).toBe(5);
    expect(c.state).toBe("signedout");
    c.close();
  });

  it("resets after a socket that lived past a stable minute, and resume starts again", async () => {
    let life = 120_000;
    const opened: number[] = [];
    const dial: Dial = async (ev) => {
      opened.push(Date.now());
      setTimeout(() => ev.closed("lapsed"), life);
      return { send: () => {}, close: () => {} };
    };
    const c = new Connection({ dial });
    await run(3_600_000);
    expect(c.state).not.toBe("signedout");
    expect(opened.length).toBeGreaterThan(25);
    c.close();
    life = 1_000;
    const again = new Connection({ dial });
    await run(600_000);
    expect(again.state).toBe("signedout");
    const before = opened.length;
    again.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(opened.length).toBe(before + 1);
    expect(again.state).toBe("open");
    again.close();
  });

  it("keeps retrying a dial that fails, which is the network, not the session", async () => {
    let dials = 0;
    const c = new Connection({
      dial: async () => {
        dials++;
        throw new Error("ECONNREFUSED");
      },
    });
    await run(600_000);
    expect(c.state).toBe("waiting");
    expect(dials).toBeGreaterThan(15);
    c.close();
  });
});
