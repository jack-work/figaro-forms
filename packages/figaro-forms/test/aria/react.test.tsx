// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import type { AppliedFrame } from "../../src/aria/index.js";
import { AriaProvider, useAria, useAriaFrames, useAriaList, useAriaPhase } from "../../src/aria/react.js";
import { FakeAria, settle, tick } from "./fake-aria.js";

afterEach(cleanup);

function setup() {
  const fake = new FakeAria();
  fake.addAria("a1");
  const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5, retryMinMs: 5, retryMaxMs: 10 });
  return { fake, client };
}

describe("aria React hooks", () => {
  it("renders the open message as frames arrive, and the closed one once the turn seals", async () => {
    const { fake, client } = setup();
    const View = () => {
      const snap = useAria("a1");
      const open = snap?.view.open;
      const sealed = snap?.view.closed[0];
      return createElement(
        "div",
        { "data-testid": "v" },
        `${snap?.phase}|${(open ?? sealed)?.inquiry ?? ""}|${(open ?? sealed)?.nodes[0]?.markdown ?? ""}:${open ? "open" : sealed ? "closed" : ""}`,
      );
    };
    const ui = render(createElement(StrictMode, null, createElement(AriaProvider, { client }, createElement(View))));
    await act(() => settle());
    expect(ui.getByTestId("v").textContent).toBe("live||:");
    await act(async () => {
      fake.openTurn("a1", 1, "ciao");
      fake.update("a1", 1, [{ id: 0, set: { type: "prose", markdown: "Buon" } }]);
      await settle();
    });
    expect(ui.getByTestId("v").textContent).toBe("live|ciao|Buon:open");
    await act(async () => {
      fake.update("a1", 1, [{ id: 0, patch: { markdown: { at: 4, del: 0, ins: "giorno" } } }]);
      await settle();
    });
    expect(ui.getByTestId("v").textContent).toBe("live|ciao|Buongiorno:open");
    await act(async () => {
      fake.closeRound("a1", 1);
      fake.seal("a1", 1);
      await settle();
    });
    expect(ui.getByTestId("v").textContent).toBe("live|ciao|Buongiorno:closed");
    client.close();
  });

  it("leaves a component untouched when another aria changes", async () => {
    const { fake, client } = setup();
    fake.addAria("a2");
    let renders = 0;
    const Quiet = () => {
      renders++;
      useAria("a2");
      return null;
    };
    render(createElement(AriaProvider, { client }, createElement(Quiet)));
    await act(() => settle());
    const before = renders;
    await act(async () => {
      fake.openTurn("a1", 1, "other");
      await settle();
    });
    expect(renders).toBe(before);
    client.close();
  });

  it("hands each frame to a handler with the nodes it touched, whatever the render in between", async () => {
    const { fake, client } = setup();
    const seen: string[] = [];
    const Listen = () => {
      useAriaFrames("a1", (a: AppliedFrame) => {
        for (const c of a.nodes) if (c.node.type === "tool") seen.push(c.node.status ?? "");
      });
      return null;
    };
    render(createElement(AriaProvider, { client }, createElement(Listen)));
    await act(() => settle());
    await act(async () => {
      fake.openTurn("a1", 1, "run");
      fake.update("a1", 1, [{ id: 0, set: { type: "prose", markdown: "x" } }, { id: 1, set: { type: "tool", name: "bash", status: "running", tool_call_id: "c1" } }]);
      fake.update("a1", 1, [{ id: 1, set: { status: "ok", output: "done" } }]);
      await settle();
    });
    expect(seen).toEqual(["running", "ok"]);
    client.close();
  });

  it("reports the stream phase, including a refusal", async () => {
    const { fake, client } = setup();
    fake.refuseFollow.set("a1", { code: -32020, message: "no listen" });
    const Phase = () => createElement("span", { "data-testid": "p" }, useAriaPhase("a1") ?? "none");
    const ui = render(createElement(AriaProvider, { client }, createElement(Phase)));
    await act(() => settle());
    expect(ui.getByTestId("p").textContent).toBe("refused");
    client.close();
  });

  it("lists the figaros the daemon shows, and says how many it held back", async () => {
    const { fake, client } = setup();
    fake.rows = [{ id: "a1", state: "idle", handle: "one" }, { id: "a2", state: "dormant", handle: "two" }];
    fake.listRefused = 4;
    const List = () => {
      const { list } = useAriaList();
      return createElement("span", { "data-testid": "l" }, list ? `${list.rows.map((r) => r.handle).join(",")}|${list.refused}` : "loading");
    };
    const ui = render(createElement(AriaProvider, { client }, createElement(List)));
    await act(() => tick(30));
    expect(ui.getByTestId("l").textContent).toBe("one,two|4");
    client.close();
  });

  it("releases the stream after unmount", async () => {
    const { fake, client } = setup();
    const View = () => {
      useAria("a1");
      return null;
    };
    const ui = render(createElement(AriaProvider, { client }, createElement(View)));
    await act(() => settle());
    ui.unmount();
    await tick(40);
    expect(fake.calls.filter((c) => c.method === "figaro.unfollow")).toHaveLength(1);
    client.close();
  });
});
