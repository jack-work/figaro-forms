import { useEffect, useState, type FormEvent } from "react";
import type { AriaRefusal, NodeView, Tool, TurnView } from "figaro-forms/aria";
import { useAria, useAriaClient, useAriaConnection, useAriaEvents, useAriaList, useAriaStream } from "figaro-forms/aria/react";

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
  useAriaEvents(props.aria, { type: "tool.end" }, () => setTools((n) => n + 1));

  if (!snap || !stream) return null;

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
    void guard(() => stream.prompt(text));
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
        {snap.turns.map((t) => (
          <Turn key={t.turn} turn={t} />
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

function Turn(props: { readonly turn: TurnView }) {
  const { turn } = props;
  return (
    <li className="turn">
      <div className="input">
        <span className="who">{turn.input?.segments.map((s) => s.senderName ?? s.sender).find((s) => s) ?? "you"}</span>
        <pre>{turn.input?.text ?? ""}</pre>
      </div>
      {turn.nodes.map((n) => (
        <Node key={n.node} node={n} />
      ))}
      {turn.end ? (
        <div className={turn.end.failed ? "end failed" : "end"}>{turn.end.failed ? turn.end.reason : `done${turn.end.reason ? `: ${turn.end.reason}` : ""}`}</div>
      ) : !turn.sealed ? (
        <div className="end running">…</div>
      ) : null}
    </li>
  );
}

function Node(props: { readonly node: NodeView }) {
  const n = props.node;
  if (n.kind === "tool") return <ToolBlock tool={n.tool} settled={n.settled} />;
  if (n.kind === "thinking") {
    return (
      <details className="thinking" open={!n.settled}>
        <summary>thinking</summary>
        <pre>{n.text}</pre>
      </details>
    );
  }
  if (n.kind === "steering") {
    return (
      <div className="steering">
        <span className="who">{n.senderName ?? n.sender ?? "steering"}</span>
        <pre>{n.text}</pre>
      </div>
    );
  }
  if (n.kind === "unknown") {
    return (
      <div className="unknown">
        <span className="who">{n.type}</span>
        {n.text ? <pre>{n.text}</pre> : null}
      </div>
    );
  }
  return <pre className={n.settled ? "prose" : "prose live"}>{n.text}</pre>;
}

function ToolBlock(props: { readonly tool: Tool; readonly settled: boolean }) {
  const { tool } = props;
  const headline = tool.summary ?? (tool.args ? Object.values(tool.args)[0] : undefined) ?? tool.input ?? "";
  return (
    <div className={`tool tool-${tool.status}`}>
      <div className="tool-head">
        <span className="tool-name">{tool.name ?? "tool"}</span>
        <span className="tool-status">{tool.status}</span>
        <span className="tool-line">{String(headline)}</span>
      </div>
      {tool.output ? <pre className="tool-out">{tool.output}</pre> : null}
    </div>
  );
}
