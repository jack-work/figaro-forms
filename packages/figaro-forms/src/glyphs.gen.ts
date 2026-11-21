export interface GlyphDoc {
  readonly name: string;
  readonly symbol: string;
  readonly marks: string;
}

export const glyphs = {
  "send": "✎",
  "composer": "✎",
  "comment": "✎",
  "comment.closed": "▸",
  "comment.open": "▾",
  "comment.reply": "›",
  "steering": "↳",
  "tool.ok": "✓",
  "tool.error": "✗",
  "tool.running": "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  "tool.pending": "·",
  "thinking": "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  "busy": "…",
  "delta": "Δ",
  "fork": "⑂",
  "head": "•",
  "bullet": "•",
  "dead": "⊘",
  "absent": "∅",
  "head.open": "∧",
  "head.shut": "∨",
  "quote": "❝",
  "quote.open": "╭",
  "quote.close": "╰",
  "snake.hang": "╭",
  "snake.body": "│",
  "snake.close": "╰",
  "snake.elbow": "╯",
  "rule": "─",
  "rule.double": "═",
  "gutter": "│",
  "newline": "⏎",
  "select": "▸",
  "state.running": "▸",
  "state.here": "●",
  "state.idle": "○",
  "queue.committing": "→",
  "queue.waiting": "·",
  "session.idle": "𝄐",
  "session.disconnected": "⠸",
  "session.interrupted": "!",
  "alert.warn": "!",
  "transcript.call": "→",
  "transcript.result": "↩",
  "transcript.result.error": "⚠",
  "decide.marker": "←",
  "decide.sigil": "??",
  "pit.queue": "𝄚",
  "pit.queue.mark": "♭",
  "pit.notifications": "𝄞",
  "pit.notifications.mark": "♩",
  "pit.command": "∴",
  "pit.search": "⌕",
  "pit.help": "?",
  "pit.status": "!",
  "pit.dropped": "𝄽",
  "pit.form": "웃",
  "pit.form.mark": "⌖",
  "pit.models": "웃",
  "pit.models.mark": "⟡",
  "pit.reaped": "웃",
  "pit.reaped.mark": "⁂",
  "pit.troupe": "웃",
  "pit.troupe.mark": "⌘",
  "pit.confirm": "[y/N]",
  "pit.completion.mark": "♪",
  "pit.decision": "⁇",
  "pit.login": "⚷",
  "pit.login.mark": "▸",
  "pit.answer": "⚷",
  "voice": "♫",
  "attach": "⊕",
} as const;

export type GlyphName = keyof typeof glyphs;

export const glyphDocs: readonly GlyphDoc[] = [
  {
    "name": "send",
    "symbol": "✎",
    "marks": "the send-to pit and the draft that goes out"
  },
  {
    "name": "composer",
    "symbol": "✎",
    "marks": "the composer in normal mode"
  },
  {
    "name": "comment",
    "symbol": "✎",
    "marks": "a comment on the transcript"
  },
  {
    "name": "comment.closed",
    "symbol": "▸",
    "marks": "a collapsed comment row"
  },
  {
    "name": "comment.open",
    "symbol": "▾",
    "marks": "an expanded comment row"
  },
  {
    "name": "comment.reply",
    "symbol": "›",
    "marks": "a reply inside an open comment thread"
  },
  {
    "name": "steering",
    "symbol": "↳",
    "marks": "input that reached a turn already running, and the queued-messages heading"
  },
  {
    "name": "tool.ok",
    "symbol": "✓",
    "marks": "a tool call, outfit layer, login or setup step that finished well"
  },
  {
    "name": "tool.error",
    "symbol": "✗",
    "marks": "a tool call, outfit layer, login or setup step that failed"
  },
  {
    "name": "tool.running",
    "symbol": "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
    "marks": "the frames of the spinner, one per tick, for a running tool call"
  },
  {
    "name": "tool.pending",
    "symbol": "·",
    "marks": "a node with no settled status yet, an idle notification, a provider not signed in"
  },
  {
    "name": "thinking",
    "symbol": "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
    "marks": "the frames of the spinner, one per tick, while the model thinks"
  },
  {
    "name": "busy",
    "symbol": "…",
    "marks": "work under way where a mark is wanted, such as a sign-in flow"
  },
  {
    "name": "delta",
    "symbol": "Δ",
    "marks": "a change to a key in a form transition"
  },
  {
    "name": "fork",
    "symbol": "⑂",
    "marks": "a fork point in a form transition"
  },
  {
    "name": "head",
    "symbol": "•",
    "marks": "the head of a form's history"
  },
  {
    "name": "bullet",
    "symbol": "•",
    "marks": "a list item"
  },
  {
    "name": "dead",
    "symbol": "⊘",
    "marks": "a form or node that is gone"
  },
  {
    "name": "absent",
    "symbol": "∅",
    "marks": "the missing side of a transition: a key born has no old, a key removed has no new"
  },
  {
    "name": "head.open",
    "symbol": "∧",
    "marks": "the turn's question header, collapsed and able to open"
  },
  {
    "name": "head.shut",
    "symbol": "∨",
    "marks": "the turn's question header, open and able to shut"
  },
  {
    "name": "quote",
    "symbol": "❝",
    "marks": "a quoted passage"
  },
  {
    "name": "quote.open",
    "symbol": "╭",
    "marks": "the top corner of a quote block"
  },
  {
    "name": "quote.close",
    "symbol": "╰",
    "marks": "the bottom corner of a quote block"
  },
  {
    "name": "snake.hang",
    "symbol": "╭",
    "marks": "where the adornment snake hangs from a block"
  },
  {
    "name": "snake.body",
    "symbol": "│",
    "marks": "the spine of the adornment snake"
  },
  {
    "name": "snake.close",
    "symbol": "╰",
    "marks": "where the adornment snake ends"
  },
  {
    "name": "snake.elbow",
    "symbol": "╯",
    "marks": "where the snake joins the block's first row"
  },
  {
    "name": "rule",
    "symbol": "─",
    "marks": "the horizontal rule between transcript regions"
  },
  {
    "name": "rule.double",
    "symbol": "═",
    "marks": "the header rule once the transcript is scrolled under it"
  },
  {
    "name": "gutter",
    "symbol": "│",
    "marks": "the left gutter of tool output and quoted text"
  },
  {
    "name": "newline",
    "symbol": "⏎",
    "marks": "a line break folded out of a one-line summary"
  },
  {
    "name": "select",
    "symbol": "▸",
    "marks": "the selected row of a pit"
  },
  {
    "name": "state.running",
    "symbol": "▸",
    "marks": "an aria with a turn in flight"
  },
  {
    "name": "state.here",
    "symbol": "●",
    "marks": "the aria this shell is bound to, or the troupe selected"
  },
  {
    "name": "state.idle",
    "symbol": "○",
    "marks": "an aria at rest"
  },
  {
    "name": "queue.committing",
    "symbol": "→",
    "marks": "a queued message being committed"
  },
  {
    "name": "queue.waiting",
    "symbol": "·",
    "marks": "a queued message waiting its turn"
  },
  {
    "name": "session.idle",
    "symbol": "𝄐",
    "marks": "a session with no turn"
  },
  {
    "name": "session.disconnected",
    "symbol": "⠸",
    "marks": "the turn goes on at the daemon, this view is detached"
  },
  {
    "name": "session.interrupted",
    "symbol": "!",
    "marks": "a turn that was hung up, not failed"
  },
  {
    "name": "alert.warn",
    "symbol": "!",
    "marks": "a warning notification"
  },
  {
    "name": "transcript.call",
    "symbol": "→",
    "marks": "a tool call in an exported transcript"
  },
  {
    "name": "transcript.result",
    "symbol": "↩",
    "marks": "a tool result in an exported transcript"
  },
  {
    "name": "transcript.result.error",
    "symbol": "⚠",
    "marks": "a failed tool result in an exported transcript"
  },
  {
    "name": "decide.marker",
    "symbol": "←",
    "marks": "the option the decision chose"
  },
  {
    "name": "decide.sigil",
    "symbol": "??",
    "marks": "the line prefix that asks for a decision"
  },
  {
    "name": "pit.queue",
    "symbol": "𝄚",
    "marks": "the queue pit"
  },
  {
    "name": "pit.queue.mark",
    "symbol": "♭",
    "marks": "the selection mark in the queue, output and dropped pits"
  },
  {
    "name": "pit.notifications",
    "symbol": "𝄞",
    "marks": "the notifications pit"
  },
  {
    "name": "pit.notifications.mark",
    "symbol": "♩",
    "marks": "the selection mark in the notifications pit"
  },
  {
    "name": "pit.command",
    "symbol": "∴",
    "marks": "the command pit"
  },
  {
    "name": "pit.search",
    "symbol": "⌕",
    "marks": "the search pit"
  },
  {
    "name": "pit.help",
    "symbol": "?",
    "marks": "the help pit"
  },
  {
    "name": "pit.status",
    "symbol": "!",
    "marks": "the status pit"
  },
  {
    "name": "pit.dropped",
    "symbol": "𝄽",
    "marks": "the dropped-input pit"
  },
  {
    "name": "pit.form",
    "symbol": "웃",
    "marks": "the form pit"
  },
  {
    "name": "pit.form.mark",
    "symbol": "⌖",
    "marks": "the selection mark in the form pit"
  },
  {
    "name": "pit.models",
    "symbol": "웃",
    "marks": "the models pit"
  },
  {
    "name": "pit.models.mark",
    "symbol": "⟡",
    "marks": "the selection mark in the models pit"
  },
  {
    "name": "pit.reaped",
    "symbol": "웃",
    "marks": "the reaped pit"
  },
  {
    "name": "pit.reaped.mark",
    "symbol": "⁂",
    "marks": "the selection mark in the reaped pit"
  },
  {
    "name": "pit.troupe",
    "symbol": "웃",
    "marks": "the troupe pit"
  },
  {
    "name": "pit.troupe.mark",
    "symbol": "⌘",
    "marks": "the selection mark in the troupe pit"
  },
  {
    "name": "pit.confirm",
    "symbol": "[y/N]",
    "marks": "the confirmation pit"
  },
  {
    "name": "pit.completion.mark",
    "symbol": "♪",
    "marks": "the selection mark in the completion rows of the command pit"
  },
  {
    "name": "pit.decision",
    "symbol": "⁇",
    "marks": "the decision pit"
  },
  {
    "name": "pit.login",
    "symbol": "⚷",
    "marks": "the login pit"
  },
  {
    "name": "pit.login.mark",
    "symbol": "▸",
    "marks": "the selection mark in the login pit"
  },
  {
    "name": "pit.answer",
    "symbol": "⚷",
    "marks": "the answer box"
  },
  {
    "name": "voice",
    "symbol": "♫",
    "marks": "spoken input: the mic toggle and a composer filling from speech"
  },
  {
    "name": "attach",
    "symbol": "⊕",
    "marks": "a file or photo added to the draft, and the control that adds one"
  }
];
