import { describe, expect, it } from "vitest";
import { AriaClient, ForkedButUnsent } from "../../src/aria/client.js";
import { RpcError } from "../../src/rpc.js";
import { FakeAria } from "./fake-aria.js";

function world() {
  const fake = new FakeAria();
  fake.addAria("r1");
  const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5 });
  return { fake, client };
}

describe("forks", () => {
  it("forks at a turn, then sends the text to the new branch", async () => {
    const { fake, client } = world();
    const out = await client.forkAt("r1", 4, "try again");
    expect(out.id).toBe("r1-f1");
    expect(out.qua).toMatchObject({ ok: true });
    const calls = fake.calls.filter((c) => c.method === "figaro.fork" || c.method === "figaro.qua");
    expect(calls.map((c) => c.method)).toEqual(["figaro.fork", "figaro.qua"]);
    expect(calls[0]?.params).toEqual({ figaro_id: "r1", at_turn: 4 });
    expect(calls[1]?.params).toEqual({ figaro_id: "r1-f1", text: "try again" });
    client.close();
  });

  it("forks without sending when there is no text, and tail forks carry no turn", async () => {
    const { fake, client } = world();
    await client.forkAt("r1", 2);
    await client.tailFork("r1");
    expect(fake.calls.filter((c) => c.method === "figaro.qua")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.method === "figaro.fork").map((c) => c.params)).toEqual([{ figaro_id: "r1", at_turn: 2 }, { figaro_id: "r1" }]);
    client.close();
  });

  it("rejects when the gateway refuses the fork, and sends nothing", async () => {
    const { fake, client } = world();
    fake.refuseFork.set("r1", { code: -32020, message: "gateway: figaro.fork is not allowed" });
    await expect(client.forkAt("r1", 1, "hi")).rejects.toBeInstanceOf(RpcError);
    expect(fake.calls.filter((c) => c.method === "figaro.qua")).toHaveLength(0);
    client.close();
  });

  it("names the new aria when the fork lands but the send is refused", async () => {
    const { fake, client } = world();
    fake.refuseQua.set("r1-f1", { code: -32020, message: "send denied" });
    const err = await client.forkAt("r1", 1, "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForkedButUnsent);
    expect(err).toMatchObject({ id: "r1-f1", message: expect.stringContaining("send denied") });
    client.close();
  });
});

