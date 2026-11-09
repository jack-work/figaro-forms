import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { refusalOf, writable } from "figaro-forms/auth";
import { useFormEditor, useFormStatus, useFormView } from "figaro-forms/react";
import { OpenState, type ViewNode } from "figaro-forms/view";
import type { Json } from "figaro-forms";

const openState = new OpenState({ channel: "figaro-forms-demo" });

function parse(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

function show(v: Json | undefined): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function age(v: Json | undefined): string {
  if (typeof v !== "number" || v < 1e12) return show(v);
  const s = Math.round((Date.now() - v) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const depthClass = (d: number): string => `d${Math.min(d, 12)}`;

export function FormPanel(props: { readonly formRef: string }) {
  const status = useFormStatus(props.formRef);
  const nodes = useFormView(props.formRef, { open: openState });
  const editor = useFormEditor(props.formRef);
  const canWrite = status.phase === "ready" && writable(status.access) && !props.formRef.includes("/");
  const [path, setPath] = useState("");
  const [value, setValue] = useState("");

  const addField = (e: FormEvent): void => {
    e.preventDefault();
    if (path.trim() === "") return;
    void editor.set(path.trim(), parse(value));
    setPath("");
    setValue("");
  };

  return (
    <section className="panel">
      <div className="status">
        <span className="ref">{props.formRef}</span>
        <span className={`phase phase-${status.phase}`}>{status.phase}</span>
        <span>v{status.version}</span>
        {status.pending > 0 ? <span className="pending">{status.pending} pending</span> : null}
        <span>{canWrite ? "writable" : "read-only"}</span>
        {status.view ? <span className="hint">view hint</span> : null}
      </div>
      {status.error ? <p className="error">{status.error}</p> : null}
      {status.refusal ? (
        <p className="refusal">
          refused{status.refusal.key ? ` at ${status.refusal.key}` : ""}: {status.refusal.reason}
        </p>
      ) : null}
      <ul className="tree">
        {nodes.map((n) => (
          <Row key={n.id} node={n} formRef={props.formRef} canWrite={canWrite} />
        ))}
      </ul>
      {canWrite ? (
        <form className="add" onSubmit={addField}>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="path, e.g. notes.second" spellCheck={false} />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value (JSON or text)" spellCheck={false} />
          <button type="submit">set</button>
        </form>
      ) : null}
      {status.view?.actions?.length ? (
        <p className="actions">
          actions this view offers: {status.view.actions.map((a) => `${a.key} ${a.label}`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function Row(props: { readonly node: ViewNode; readonly formRef: string; readonly canWrite: boolean }) {
  const { node } = props;
  const status = useFormStatus(props.formRef);
  const editor = useFormEditor(props.formRef);
  const [editing, setEditing] = useState<string | undefined>();
  const denied = useMemo(() => refusalOf(status.access, node.path), [status.access, node.path]);
  const editable = props.canWrite && !denied;
  const cls = ["node", depthClass(node.depth), node.row?.marked ? "marked" : "", node.row ? "row" : ""].filter(Boolean).join(" ");

  const commit = (): void => {
    if (editing === undefined) return;
    void editor.set(node.path, parse(editing));
    setEditing(undefined);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") setEditing(undefined);
  };

  if (node.branch) {
    return (
      <li className={cls}>
        <button type="button" className="toggle" onClick={() => openState.set(node.path, !node.open)}>
          <span className="caret">{node.open ? "▾" : "▸"}</span>
          <span className="key">{node.key}</span>
          {node.row?.label ? <span className="label">{node.row.label}</span> : <span className="count">{node.size}</span>}
          {node.row?.aside !== undefined ? <span className="aside">{age(node.row.aside)}</span> : null}
        </button>
        {editable ? (
          <button type="button" className="remove" title="unset" onClick={() => void editor.unset(node.path)}>
            ×
          </button>
        ) : null}
      </li>
    );
  }
  return (
    <li className={cls}>
      <span className="key">{node.key}</span>
      {editing !== undefined ? (
        <input className="edit" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onKeyDown={keys} onBlur={commit} spellCheck={false} />
      ) : editable ? (
        <button type="button" className="value" onClick={() => setEditing(show(node.value))}>
          {show(node.value)}
        </button>
      ) : (
        <span className="value" title={denied?.reason}>
          {show(node.value)}
        </span>
      )}
      {editable && editing === undefined ? (
        <button type="button" className="remove" title="unset" onClick={() => void editor.unset(node.path)}>
          ×
        </button>
      ) : null}
    </li>
  );
}
