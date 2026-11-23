import type { KeyDoc } from "./keys.js";

export const wellKnownKeys: readonly KeyDoc[] = [
  {
    "key": "duke-title",
    "short": "What this aria calls its END USER (default \"user\"); set it in an outfit and a human's prompts are attributed to that name",
    "mode": "user"
  },
  {
    "key": "target-aria",
    "short": "The figaro a role form points at: its holder. Protected: only the owner or an ancestor figaro writes it, and cast checks its target",
    "mode": "user"
  },
  {
    "key": "lifecycle.status",
    "short": "Owner-held; a role's lifecycle. routing-alias makes the role route to its holder without binding the holder's fan-out limits or quota",
    "mode": "user"
  },
  {
    "key": "succession-policy",
    "short": "Owner-held; how a role's holder hands it over: the outfit the daemon dresses a successor in as the owner, thresholds, variants, the handoff key",
    "mode": "user"
  },
  {
    "key": "system.credo",
    "short": "Credo source (string or {content,filePath,frontmatter}); providers read this as the system prompt. Fixed at birth: set by the outfit or birth patch, refused once the figaro has spoken (fork -S or succeed for another)",
    "mode": "user"
  },
  {
    "key": "system.kind",
    "short": "\"log\" makes the aria an aria log: no provider, and a send appends one entry instead of starting a turn. Fixed at birth: set in the birth patch of new --log, bind or fork, refused on set or send after",
    "mode": "user"
  },
  {
    "key": "system.provider",
    "short": "Provider this figaro talks to (anthropic, copilot, ...); switching mid-conversation is the owner's call",
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
    "short": "What to SAY at a study lifecycle event: {\"onstudy\":…,\"onupdate\":…,\"ondrop\":…}, any subset, strings; a bare string is onstudy alone",
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
    "key": "system.retirement",
    "short": "Owner-held {context_threshold, fallback_tokens, ttl, action, page, timeout, ramp, ramp_turns}: fallback_tokens is an absolute token threshold when the context capacity is unknown; otherwise context_threshold applies. At the end of a turn whose last request carried at least context_threshold input tokens (a count, or \"60%\" of the context window), the aria retires itself (system.retired = \"context\"); ttl counts from then. action = \"succeed\" hands over first: a warning at 80%, one final handoff turn, a successor minted, cast into every role the aria holds and prompted to ramp on, and the aria retires only when that first turn ends; a failure or timeout leaves it unretired and tells page (an aria or @role; default the holder of its drawn parent)",
    "mode": "user"
  },
  {
    "key": "runtime.succession_warned",
    "short": "Set once the aria has been told to start handing over (80% of its retirement threshold)",
    "mode": "system"
  },
  {
    "key": "system.succession_failed",
    "short": "Owner-held; why the aria's succession stopped. While set no new succession starts; unset it to let the next turn try again",
    "mode": "user"
  },
  {
    "key": "system.sandbox",
    "short": "Protected; the sandbox the aria's tools run in (a box name, or unset for local). A figaro cannot set its own: only the owner or an ancestor figaro of the aria ([authz] protected_keys)",
    "mode": "user"
  },
  {
    "key": "system.scopes",
    "short": "Protected; the aria's scopes as a JSON array of verb:object strings, narrowing its parent's and enforced on calls that name it. Providers read the effective set from figaro.scopes, not this key. Same writers as system.sandbox; a figaro gives only what it holds",
    "mode": "user"
  },
  {
    "key": "system.grants",
    "short": "Owner-held; what the owner grants a figaro beyond its scopes, one key per kind of grant. It was once the name of system.scopes: a list here is no longer read, and the figaro's scopes fail closed until the owner moves it",
    "mode": "user"
  },
  {
    "key": "system.grants.outfits",
    "short": "Owner-held; the outfits the figaro may name beyond default (each -O layer, at fork, new, bind, set, send and cast), as names or globs (\"opus5\", \"model-*\", \"*\"). A role form's list grants its holder too. Managed apply may set it",
    "mode": "user"
  },
  {
    "key": "system.fanout.max_children",
    "short": "Protected; how many children the figaro may fork (non-negative integer). Same writers as system.scopes",
    "mode": "user"
  },
  {
    "key": "system.child_policy",
    "short": "Protected; a template applied in the birth patch of every fork of this figaro: an object of key paths to values, applied key by key (a nested object names the key paths below it; scopes, fanout, incantations; owner-held keys such as system.model only when the owner writes them). Applied at birth, never kept linked. Unset, a fork made by a figaro gets system.scopes = [\"send:parent\", \"read:aria:self\", \"write:aria:self#@self\", \"delete:aria:self#@self\"]; a fork made by the owner inherits as before. Same writers as system.scopes",
    "mode": "user"
  },
  {
    "key": "system.fanout.quota",
    "short": "Protected; the most live figaros the subtree may hold, the figaro itself not counted (non-negative integer). A live child charges 1 plus its own quota, or 1 plus what its subtree uses when it has none; a parent grants only from its free budget. Same writers as system.scopes",
    "mode": "user"
  },
  {
    "key": "system.fanout.mint",
    "short": "Protected; true lets the figaro mint a new one with figaro new while [authz] enforce_key_grants is off. With it on the key is retired, a write is refused, and mint:* in system.scopes licenses instead. Same writers as system.scopes",
    "mode": "user"
  },
  {
    "key": "system.keep",
    "short": "Owner-held; true and `figaro gc` never chooses this aria, nor anything whose delete would take it",
    "mode": "user"
  },
  {
    "key": "runtime.checkpoint.marks",
    "short": "Logical times this form's state is checkpointed at, keyed by version: the tail mark moves with the writes, and past system.checkpoint.max_marks the least recently used goes",
    "mode": "system"
  },
  {
    "key": "system.checkpoint.every_patches",
    "short": "Move the tail checkpoint every N records (floor 64); unset takes [store] checkpoint_every_patches",
    "mode": "user"
  },
  {
    "key": "system.checkpoint.every_seconds",
    "short": "Move the tail checkpoint every N seconds when something was written (floor 5); unset takes [store] checkpoint_every_seconds",
    "mode": "user"
  },
  {
    "key": "system.checkpoint.max_marks",
    "short": "How many checkpoints the form keeps (floor 2, default 5)",
    "mode": "user"
  },
  {
    "key": "system.retention.mode",
    "short": "\"marks\" drops this form's records below its lowest live checkpoint mark, \"none\" keeps every record; unset takes [store] retention_mode, and with that unset the store-wide sweep decides. Owner-held; refused on a conversation-bound form",
    "mode": "user"
  },
  {
    "key": "system.retention.writers",
    "short": "Figaro ids or principals the owner lets set system.retention.* besides itself; only the owner sets this",
    "mode": "user"
  },
  {
    "key": "runtime.owner_made",
    "short": "Set at birth on a fork the owner made: it was admitted past every fan-out cap, still counts against them, and a capped figaro may retire it to make room",
    "mode": "system"
  },
  {
    "key": "runtime.forked_from",
    "short": "The trunk this branch was forked from (stamped at birth)",
    "mode": "system"
  },
  {
    "key": "runtime.tombstone",
    "short": "Set when a form is deleted: the record subscribers hear the death through, after which the form is sealed",
    "mode": "system"
  },
  {
    "key": "runtime.studies",
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
    "key": "runtime.failure.reason",
    "short": "Why the last turn failed, as the provider or the daemon said it; removed by the next turn that ends without error",
    "mode": "system"
  },
  {
    "key": "runtime.failure.category",
    "short": "The last failure's kind: \"rate_limited\", \"auth\", \"provider_error\", \"timeout\", \"refused\" or \"other\"",
    "mode": "system"
  },
  {
    "key": "runtime.failure.turn",
    "short": "The turn that failed",
    "mode": "system"
  },
  {
    "key": "runtime.failure.at",
    "short": "When it failed, unix millis",
    "mode": "system"
  },
  {
    "key": "datetime",
    "short": "Per-turn wall-clock time",
    "mode": "per-turn"
  },
  {
    "key": "system.ttl",
    "short": "Owner-held; a lifetime counted from creation, after which the sweep deletes the node and its subtree (Go duration plus d and w; 0 or unset means none)",
    "mode": "user"
  },
  {
    "key": "system.reap_if_empty",
    "short": "Owner-held; true and the sweep reaps a figaro that never had a message",
    "mode": "user"
  },
  {
    "key": "system.keepalive",
    "short": "Owner-held; a node whose lifetime is spent survives while it was used within this window (default one day; 0 reaps at the deadline)",
    "mode": "user"
  },
  {
    "key": "system.retired",
    "short": "Owner-held; the request to retire a figaro, with the reason (e.g. \"manual\"); a box may set it on the figaros inside it. The daemon records it at runtime.retired and never keeps it here; removing it unretires",
    "mode": "user"
  },
  {
    "key": "runtime.route",
    "short": "The route the figaro talks over, as the ordered path through the model catalog: [provider, upstream..., model], e.g. [\"rou2\",\"explabs\",\"glm-5.3\"] or [\"anthropic\",\"claude-opus-5\"]. The daemon derives it from system.provider and system.model on every write that touches them",
    "mode": "system"
  },
  {
    "key": "runtime.retired",
    "short": "Set when a figaro retires, with the reason (\"manual\", \"context\"); written by the daemon from system.retired or its own retirement",
    "mode": "system"
  },
  {
    "key": "system.forked_from",
    "short": "Old name of runtime.forked_from: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.studies",
    "short": "Old name of runtime.studies: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.tombstone",
    "short": "Old name of runtime.tombstone: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.checkpoint.marks",
    "short": "Old name of runtime.checkpoint.marks: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.succession_warned",
    "short": "Old name of runtime.succession_warned: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.failure.reason",
    "short": "Old name of runtime.failure.reason: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.failure.category",
    "short": "Old name of runtime.failure.category: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.failure.turn",
    "short": "Old name of runtime.failure.turn: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.failure.at",
    "short": "Old name of runtime.failure.at: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.reaped",
    "short": "Old name of runtime.reaped: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.reaped_until",
    "short": "Old name of runtime.reaped_until: read for one release, never written",
    "mode": "system"
  },
  {
    "key": "system.reaped_by",
    "short": "Old name of runtime.reaped_by: read for one release, never written",
    "mode": "system"
  }
];
