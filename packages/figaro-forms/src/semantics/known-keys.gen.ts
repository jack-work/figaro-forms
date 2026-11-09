import type { KeyDoc } from "./keys.js";

export const wellKnownKeys: readonly KeyDoc[] = [
  {
    "key": "duke-title",
    "short": "What this aria calls its END USER (default \"user\"); set it in an outfit and a human's prompts are attributed to that name",
    "mode": "user"
  },
  {
    "key": "system.credo",
    "short": "Credo source (string or {content,filePath,frontmatter}); providers read this as the system prompt. Fixed at birth: set by the outfit or birth patch, refused once the figaro has spoken (fork -S or succeed for another)",
    "mode": "user"
  },
  {
    "key": "system.tags",
    "short": "Per-LT annotations (e.g. system.tags[42].cache_control)",
    "mode": "user"
  },
  {
    "key": "system.cache_control",
    "short": "Auto cache-marker policy; ON by default (short). \"none\" stops SIGNALLING (implicit-caching providers cache anyway); \"5m\"/\"1h\" force a TTL",
    "mode": "user"
  },
  {
    "key": "system.cache_markers",
    "short": "How a route is marked: \"auto\" (default), \"blocks\", \"top-level\", \"none\"",
    "mode": "user"
  },
  {
    "key": "system.thinking_budget",
    "short": "Extended-thinking token budget for budget-based models (\u003e=1024 enables; unset/0 = off)",
    "mode": "user"
  },
  {
    "key": "system.model",
    "short": "Active provider model; switchable between turns",
    "mode": "user"
  },
  {
    "key": "system.max_tokens",
    "short": "Maximum output tokens for the next provider response",
    "mode": "user"
  },
  {
    "key": "system.max_request_bytes",
    "short": "Largest request body figaro sends to the provider, in bytes; over it the oldest images are elided first (default: max_request_bytes in providers/\u003cname\u003e.toml; 0 = no limit)",
    "mode": "user"
  },
  {
    "key": "system.first_byte_timeout",
    "short": "How long a provider request may wait for its first byte before it counts as a stream cut and is resent (Go duration, default \"90s\"; \"0\" turns it off)",
    "mode": "user"
  },
  {
    "key": "system.context_tier",
    "short": "Copilot context-budget tier: \"default\" or \"long_context\"",
    "mode": "user"
  },
  {
    "key": "system.max_context_tokens",
    "short": "Optional local cap for replayed prompt context tokens",
    "mode": "user"
  },
  {
    "key": "system.thinking_effort",
    "short": "Reasoning effort for models that support it",
    "mode": "user"
  },
  {
    "key": "system.reasoning_context",
    "short": "Copilot Responses reasoning retention: \"auto\", \"current_turn\", or \"all_turns\"",
    "mode": "user"
  },
  {
    "key": "system.reasoning_summary",
    "short": "Copilot Responses readable reasoning summary: \"auto\", \"concise\", or \"detailed\"",
    "mode": "user"
  },
  {
    "key": "system.verbosity",
    "short": "Copilot Responses text verbosity",
    "mode": "user"
  },
  {
    "key": "system.temperature",
    "short": "Copilot Responses sampling temperature (0 through 2; mutually exclusive with top_p)",
    "mode": "user"
  },
  {
    "key": "system.top_p",
    "short": "Copilot Responses nucleus sampling (greater than 0 through 1; mutually exclusive with temperature)",
    "mode": "user"
  },
  {
    "key": "system.parallel_tool_calls",
    "short": "Whether Copilot Responses may emit parallel function calls",
    "mode": "user"
  },
  {
    "key": "system.environment.\u003cname\u003e",
    "short": "Allowlisted env var capture",
    "mode": "user"
  },
  {
    "key": "system.study_incantation",
    "short": "What to SAY at a study lifecycle event: {\"onstudy\":…,\"onupdate\":…,\"ondrop\":…}, any subset, strings",
    "mode": "user"
  },
  {
    "key": "system.fork_incantation",
    "short": "What to say to a branch at birth: a string, or {\"onfork\":…}. Unset means silence, which is the historical behaviour",
    "mode": "user"
  },
  {
    "key": "system.decide.provider",
    "short": "The provider `figaro decide` sends through: its base_url and credential (rou2, azure, ...); set in an outfit, core.toml for every aria",
    "mode": "user"
  },
  {
    "key": "system.decide.model",
    "short": "The decision model `figaro decide` asks (openai/gpt-6-luna, explabs/jev-latest, decision-1); never a conversation model",
    "mode": "user"
  },
  {
    "key": "system.decide.base_url",
    "short": "Where decisions go when the provider's base_url serves turns elsewhere (Azure's decision-1 at .../providers/microsoft/v1); the credential stays the provider's",
    "mode": "user"
  },
  {
    "key": "system.decide.api",
    "short": "The decision API `figaro decide` speaks for this aria: systemone (jev, decision-1) or openai (luna); default inferred from the model",
    "mode": "user"
  },
  {
    "key": "system.methods.enabled",
    "short": "Master switch for methods (default true); false and no method runs",
    "mode": "user"
  },
  {
    "key": "system.methods.\u003cname\u003e",
    "short": "A method: on each inquiry the decision model picks one of {options} from the rendered {context} ({{inquiry}}, {{inquiry~N}}) and writes it to {key}; {score, default, enabled, event, keep_cache} optional; keep_cache (default true) holds a method whose change would break the prompt cache",
    "mode": "user"
  },
  {
    "key": "system.tools",
    "short": "Owner-held allowlist of tool names the aria may use; [] means none, unset means all. Owner-held does not bind an unboxed aria whose tools include bash or process (issue #57)",
    "mode": "user"
  },
  {
    "key": "system.cwd",
    "short": "Working directory the tools resolve relative paths against (`figaro cd`)",
    "mode": "user"
  },
  {
    "key": "system.keep",
    "short": "Owner-held; true and `figaro gc` never chooses this aria, nor anything whose delete would take it",
    "mode": "user"
  },
  {
    "key": "system.forked_from",
    "short": "The trunk this branch was forked from (stamped at birth)",
    "mode": "system"
  },
  {
    "key": "system.tombstone",
    "short": "Set when a form is deleted: the record subscribers hear the death through, after which the form is sealed",
    "mode": "system"
  },
  {
    "key": "system.studies",
    "short": "The forms this figaro observes. Written by the study verb only: each entry is refcounted on a shared libretto, and a hand-written one would declare a study nothing counted",
    "mode": "system"
  },
  {
    "key": "model",
    "short": "Active model ID",
    "mode": "system"
  },
  {
    "key": "token_budget",
    "short": "Context window usage indicator",
    "mode": "system"
  },
  {
    "key": "truncation",
    "short": "Last tool truncation notice",
    "mode": "system"
  },
  {
    "key": "system.failure.reason",
    "short": "Why the last turn failed, as the provider or the daemon said it; removed by the next turn that ends without error",
    "mode": "system"
  },
  {
    "key": "system.failure.category",
    "short": "The last failure's kind: \"rate_limited\", \"auth\", \"provider_error\", \"timeout\", \"refused\" or \"other\"",
    "mode": "system"
  },
  {
    "key": "system.failure.turn",
    "short": "The turn that failed",
    "mode": "system"
  },
  {
    "key": "system.failure.at",
    "short": "When it failed, unix millis",
    "mode": "system"
  },
  {
    "key": "datetime",
    "short": "Per-turn wall-clock time",
    "mode": "per-turn"
  }
];

export const intrinsicKeys: { readonly [name: string]: readonly KeyDoc[] } = {
  "queue": [
    {
      "key": "epoch",
      "short": "The generation these ids belong to; they restart with it",
      "mode": "system"
    },
    {
      "key": "len",
      "short": "How many messages are in flight",
      "mode": "system"
    },
    {
      "key": "order",
      "short": "FIFO order, as ids. A form is a map and a map has none",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.text",
      "short": "The message, verbatim",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.sender",
      "short": "Who asked",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.state",
      "short": "Where it is: \"queued\", \"committing\", \"committed\", \"merged\", \"dropped\", \"drained\"",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.at",
      "short": "Accepted-at, unix millis",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.merged",
      "short": "Ids an interrupt folded INTO this message",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.into",
      "short": "For a merged message, the surviving id",
      "mode": "system"
    },
    {
      "key": "items.\u003cid\u003e.turn",
      "short": "For a committed message, the turn it became",
      "mode": "system"
    }
  ],
  "runtime": [
    {
      "key": "turn.state",
      "short": "What the aria is DOING: \"idle\", \"accepted\", \"committing\", \"thinking\", \"tooling\"",
      "mode": "system"
    },
    {
      "key": "turn.id",
      "short": "The in-flight turn id",
      "mode": "system"
    },
    {
      "key": "turn.since",
      "short": "Unix millis of the last transition",
      "mode": "system"
    },
    {
      "key": "turn.reason",
      "short": "The verdict of the turn that just ended; carried only into idle",
      "mode": "system"
    },
    {
      "key": "inflight",
      "short": "Messages accepted and not yet answered",
      "mode": "system"
    },
    {
      "key": "epoch",
      "short": "The inbox generation queue ids belong to",
      "mode": "system"
    },
    {
      "key": "model",
      "short": "Active model id",
      "mode": "system"
    }
  ]
};
