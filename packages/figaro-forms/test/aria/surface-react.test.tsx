// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AriaClient } from "../../src/aria/client.js";
import { AriaProvider, useBoundForm, useRecent, useTree } from "../../src/aria/react.js";
import { FakeAria, settle } from "./fake-aria.js";

afterEach(cleanup);

describe("surface hooks", () => {
  it("render the tree, recent list and a bound form as they change", async () => {
    const fake = new FakeAria();
    fake.addForm("@troupe", { n1: { self: true, form: "@arias" } });
    fake.addForm("@arias", { arias: { root: { id: "r1", state: "idle", active_at: 1 } } });
    fake.addForm("@recent", { a: { id: "r1", title: "first", active_at: 1 }, b: { id: "r2", title: "second", active_at: 2 } });
    fake.addForm("r1", { mantra: "m1" });
    const client = new AriaClient({ dial: fake.dial, releaseGraceMs: 5, retryMinMs: 5, retryMaxMs: 10 });
    const View = () => {
      const tree = useTree();
      const recent = useRecent();
      const bound = useBoundForm("r1");
      return createElement("div", { "data-testid": "v" }, `${[...tree.nodes.keys()].sort().join(",")}|${recent.rows.map((r) => r.id).join(",")}|${String(bound.root.mantra ?? "")}`);
    };
    const ui = render(createElement(StrictMode, null, createElement(AriaProvider, { client }, createElement(View))));
    await act(() => settle());
    expect(ui.getByTestId("v").textContent).toBe("r1|r2,r1|m1");
    await act(async () => {
      fake.formSet("@arias", ["arias", "root", "forks", "k"], { id: "k1", state: "idle" });
      fake.formSet("@recent", ["a", "active_at"], 9);
      fake.formSet("r1", ["mantra"], "m2");
      await settle();
    });
    expect(ui.getByTestId("v").textContent).toBe("k1,r1|r1,r2|m2");
    client.close();
  });
});
