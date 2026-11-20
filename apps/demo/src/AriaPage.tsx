import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AriaRefusal, Message, Node as IRNode, TurnEnd } from "figaro-forms/aria";
import { useAria, useAriaClient, useAriaConnection, useAriaFrames, useAriaList, useAriaStream } from "figaro-forms/aria/react";

function chosen(): string {
  return new URLSearchParams(location.hash.slice(1)).get("aria") ?? "";
}

export function AriaPage(props: { readonly door: string }) {
  const conn = useAriaConnection();
  const [aria, setAria] = useState(chosen);
  const [typed, setTyped] = useState("");
  const { list, error, refresh } = useAriaList({ limit: 40 });

  useEffect(() => {
    const on = (): void => setAria(chosen());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const pick = (id: string): void => {
    const hash = new URLSearchParams(location.hash.slice(1));
    hash.set("aria", id);
    location.hash = hash.toString();
  };

  const open = (e: FormEvent): void => {
    e.preventDefault();
    if (typed.trim() !== "") pick(typed.trim());
    setTyped("");
  };

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">figaro aria</span>
        <span className={`conn conn-${conn}`}>{conn}</span>
        <span className="door">{props.door}</span>
      </header>
      <nav className="side">
        <button type="button" className="action" onClick={refresh}>
          refresh
        </button>
        <ul>
          {(list?.rows ?? []).map((r) => (
            <li key={r.id}>
              <button type="button" className={r.id === aria ? "pick on" : "pick"} onClick={() => pick(r.id)}>
                <span className="pick-title">{r.handle ?? r.short ?? r.id.slice(0, 8)}</span>
                <span className="pick-note">
                  {r.state}
                  {r.mantra ? ` · ${r.mantra}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list && list.refused > 0 ? <p className="hint">{list.refused} more held back by policy</p> : null}
        {error ? <p className="error">{error instanceof Error ? error.message : String(error)}</p> : null}
        <form className="open" onSubmit={open}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="aria id" spellCheck={false} />
          <button type="submit">attend</button>
        </form>
      </nav>
      <main className="main">{aria === "" ? <p className="hint">pick a figaro, or type an id</p> : <Attended key={aria} aria={aria} />}</main>
    </div>
  );
}

function Attended(props: { readonly aria: string }) {
  const snap = useAria(props.aria);
  const stream = useAriaStream(props.aria);
  const client = useAriaClient();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | undefined>();
  const [tools, setTools] = useState(0);
  const finished = useRef(new Set<string>());
  useAriaFrames(props.aria, (a) => {
    for (const c of a.nodes) {
      if (c.node.type !== "tool" || c.node.status === "running" || finished.current.has(`${c.turn}.${c.id}`)) continue;
      finished.current.add(`${c.turn}.${c.id}`);
      setTools((n) => n + 1);
    }
  });

  if (!snap || !stream) return null;
  const turns = byTurn([...snap.view.closed, ...(snap.view.open ? [snap.view.open] : [])]);

  const guard = async (what: () => Promise<unknown>): Promise<void> => {
    setNote(undefined);
    try {
      await what();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const send = (e: FormEvent): void => {
    e.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    setDraft("");
    void guard(() => stream.qua(text));
  };

  return (
    <div className="attended">
      <div className="status">
        <span className="ref">{props.aria}</span>
        <span className={`phase phase-${snap.phase}`}>{snap.phase}</span>
        <span>cursor {snap.cursor}</span>
        <span>{tools} tools finished here</span>
        {snap.metrics ? <span>{snap.metrics.context_tokens} tokens of context</span> : null}
      </div>
      {snap.refusal ? <Refused refusal={snap.refusal} /> : null}
      {snap.olderAvailable ? (
        <button type="button" className="older" onClick={() => void guard(() => stream.loadOlder())}>
          older turns
        </button>
      ) : null}
      <ol className="turns">
        {turns.map((t) => (
          <Turn key={t.turn} turn={t.turn} messages={t.messages} open={snap.view.open?.turn === t.turn} end={snap.ends.find((e) => e.turn === t.turn)} />
        ))}
      </ol>
      <form className="composer" onSubmit={send}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="say something to this figaro" rows={3} />
        <div className="composer-actions">
          <button type="submit">send</button>
          <button type="button" onClick={() => void guard(() => stream.interrupt())}>
            interrupt
          </button>
          <button
            type="button"
            onClick={() =>
              void guard(async () => {
                const forked = await client.fork(props.aria);
                location.hash = new URLSearchParams({ aria: forked.alternative }).toString();
              })
            }
          >
            fork
          </button>
        </div>
        {note ? <p className="error">{note}</p> : null}
      </form>
    </div>
  );
}

function Refused(props: { readonly refusal: AriaRefusal }) {
  return (
    <p className="refusal">
      {props.refusal.kind}: {props.refusal.message}
    </p>
  );
}

interface TurnGroup {
  readonly turn: number;
  readonly messages: Message[];
}

function byTurn(messages: readonly Message[]): TurnGroup[] {
  const out: TurnGroup[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.turn === m.turn) last.messages.push(m);
    else out.push({ turn: m.turn, messages: [m] });
  }
  return out;
}

function Turn(props: { readonly turn: number; readonly messages: readonly Message[]; readonly open: boolean; readonly end: TurnEnd | undefined }) {
  const head = props.messages.find((m) => m.from === 0);
  const sender = head?.inquirySegments?.map((s) => s.name ?? s.sender).find((s) => s) ?? "you";
  return (
    <li className="turn">
      <div className="input">
        <span className="who">{sender}</span>
        <pre>{head?.inquiry ?? ""}</pre>
      </div>
      {props.messages.flatMap((m) => m.nodes.map((n, i) => <Node key={m.from + i} node={n} live={props.open && m === props.messages[props.messages.length - 1] && i === m.nodes.length - 1} />))}
      <End end={props.end} open={props.open} />
    </li>
  );
}

function End(props: { readonly end: TurnEnd | undefined; readonly open: boolean }) {
  if (props.open) return <div className="end running">…</div>;
  const { end } = props;
  if (!end) return null;
  if (!end.done) return <div className="end">ended</div>;
  const reason = end.done.reason;
  if (reason.startsWith("error")) return <div className="end failed">{reason}</div>;
  return <div className="end">{reason === "stop" ? "done" : `done: ${reason}`}</div>;
}

function Node(props: { readonly node: IRNode; readonly live: boolean }) {
  const n = props.node;
  if (n.type === "tool") return <ToolBlock node={n} />;
  if (n.type === "thinking") {
    return (
      <details className="thinking" open={props.live}>
        <summary>thinking</summary>
        <pre>{n.markdown ?? ""}</pre>
      </details>
    );
  }
  if (n.type === "steering") {
    return (
      <div className="steering">
        <span className="who">{n.sender_name ?? n.sender ?? "steering"}</span>
        <pre>{n.markdown ?? ""}</pre>
      </div>
    );
  }
  if (n.type !== "prose") {
    return (
      <div className="unknown">
        <span className="who">{n.type}</span>
        {n.markdown ? <pre>{n.markdown}</pre> : null}
      </div>
    );
  }
  return <pre className={props.live ? "prose live" : "prose"}>{n.markdown ?? ""}</pre>;
}

function ToolBlock(props: { readonly node: IRNode }) {
  const { node } = props;
  const status = node.status ?? "running";
  const headline = node.summary ?? (node.args ? Object.values(node.args)[0] : undefined) ?? node.input ?? "";
  return (
    <div className={`tool tool-${status}`}>
      <div className="tool-head">
        <span className="tool-name">{node.name ?? "tool"}</span>
        <span className="tool-status">{status}</span>
        <span className="tool-line">{String(headline)}</span>
      </div>
      {node.output ? <pre className="tool-out">{node.output}</pre> : null}
    </div>
  );
}
