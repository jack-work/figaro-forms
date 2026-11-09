// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FormsClient } from "../src/client.js";
import { FormsProvider, useFormStatus, useFormValue, useFormView } from "../src/react/index.js";
import { OpenState } from "../src/view/index.js";
import { FakeDoor, settle } from "./fake-door.js";

afterEach(cleanup);

function setup() {
  const door = new FakeDoor();
  door.add("@f1", { a: { b: 1, c: 2 }, z: 0 });
  const client = new FormsClient({ dial: door.dial, client: "r1", releaseGraceMs: 5 });
  return { door, client };
}

describe("React hooks", () => {
  it("re-renders only the components whose path a delta touched", async () => {
    const { door, client } = setup();
    const renders: Record<string, number> = { ab: 0, ac: 0, z: 0 };
    const Leaf = (p: { name: string; path: string }) => {
      renders[p.name] = (renders[p.name] ?? 0) + 1;
      const v = useFormValue("@f1", p.path);
      return createElement("span", { "data-testid": p.name }, JSON.stringify(v ?? null));
    };
    const ui = render(
      createElement(
        FormsProvider,
        { client },
        createElement(Leaf, { name: "ab", path: "a.b" }),
        createElement(Leaf, { name: "ac", path: "a.c" }),
        createElement(Leaf, { name: "z", path: "z" }),
      ),
    );
    await act(() => settle());
    expect(ui.getByTestId("ab").textContent).toBe("1");
    const before = { ...renders };
    await act(async () => {
      door.write("@f1", { object: { Update: { a: { object: { Update: { b: { scalar: { Before: 1, After: 7 } } } } } } } });
      await settle();
    });
    expect(ui.getByTestId("ab").textContent).toBe("7");
    expect(renders.ab).toBe((before.ab ?? 0) + 1);
    expect(renders.ac).toBe(before.ac);
    expect(renders.z).toBe(before.z);
    client.close();
  });

  it("keeps a form open across StrictMode's double mount and releases it after unmount", async () => {
    const { client } = setup();
    const Status = () => createElement("i", null, useFormStatus("@f1").phase);
    const ui = render(createElement(StrictMode, null, createElement(FormsProvider, { client }, createElement(Status))));
    await act(() => settle());
    expect(ui.container.textContent).toBe("ready");
    expect(client.open).toBe(1);
    ui.unmount();
    await act(() => settle(5));
    await new Promise((r) => setTimeout(r, 20));
    expect(client.open).toBe(0);
    client.close();
  });

  it("keeps UI open state across a version change", async () => {
    const { door, client } = setup();
    const open = new OpenState();
    open.set(["a"], true);
    const Tree = () =>
      createElement(
        "ul",
        null,
        useFormView("@f1", { open }).map((n) => createElement("li", { key: n.id }, `${"  ".repeat(n.depth)}${n.key}`)),
      );
    const ui = render(createElement(FormsProvider, { client }, createElement(Tree)));
    await act(() => settle());
    expect([...ui.container.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(["a", "b", "c", "z"]);
    await act(async () => {
      door.write("@f1", { object: { Set: { y: 1 } } });
      await settle();
    });
    expect([...ui.container.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(["a", "b", "c", "y", "z"]);
    await act(async () => {
      open.set(["a"], false);
    });
    expect([...ui.container.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(["a", "y", "z"]);
    client.close();
  });
});
