import { useState, type FormEvent } from "react";
import { useConnectionState, useFormsClient } from "figaro-forms/react";
import { forms } from "figaro-forms/semantics";
import { FormPanel } from "./FormPanel.js";

interface Example {
  readonly ref: string;
  readonly title: string;
  readonly note: string;
}

const examples: readonly Example[] = [
  { ref: forms.recent, title: "Recent", note: "your arias by last activity; rows live-sort as they move" },
  { ref: forms.arias, title: "Arias", note: "the fork forest, forks folded through their parent" },
  { ref: forms.models, title: "Models", note: "the provider catalog, grouped, hidden rows skipped" },
  { ref: forms.troupe, title: "Troupe", note: "the nodes this daemon federates with" },
  { ref: forms.reaped, title: "Reaped", note: "arias waiting to be purged" },
];

export function App(props: { readonly door: string }) {
  const client = useFormsClient();
  const conn = useConnectionState();
  const [extra, setExtra] = useState<Example[]>([]);
  const [selected, setSelected] = useState<string>(forms.recent);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const all = [...examples, ...extra];

  const add = (e: Example): void => {
    setExtra((xs) => (xs.some((x) => x.ref === e.ref) || examples.some((x) => x.ref === e.ref) ? xs : [...xs, e]));
    setSelected(e.ref);
  };

  const scratch = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const id = await client.create({ object: { Set: { title: "scratch", notes: { first: "edit me" }, count: 0 } } });
      add({ ref: id, title: "Scratch", note: "an unbound form this page minted; edit it" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (e: FormEvent): void => {
    e.preventDefault();
    const ref = custom.trim();
    if (ref === "") return;
    add({ ref, title: ref, note: "opened by id" });
    setCustom("");
  };

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">figaro forms</span>
        <span className={`conn conn-${conn}`}>{conn}</span>
        <span className="door">{props.door}</span>
      </header>
      <nav className="side">
        <ul>
          {all.map((x) => (
            <li key={x.ref}>
              <button type="button" className={x.ref === selected ? "pick on" : "pick"} onClick={() => setSelected(x.ref)}>
                <span className="pick-title">{x.title}</span>
                <span className="pick-note">{x.note}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="action" disabled={busy} onClick={() => void scratch()}>
          new scratch form
        </button>
        <form className="open" onSubmit={open}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="@id, aria id, or id/runtime" spellCheck={false} />
          <button type="submit">open</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </nav>
      <main className="main">
        <FormPanel key={selected} formRef={selected} />
      </main>
    </div>
  );
}
