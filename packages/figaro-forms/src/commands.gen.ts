export type CommandName = "help" | "show" | "send" | "read" | "new" | "listen" | "replay" | "hup" | "cut" | "queue" | "list" | "lsh" | "recent" | "back" | "forward" | "attend" | "outfit" | "study" | "drop" | "cast" | "bind" | "fork" | "normalize" | "export" | "import" | "promote" | "adopt" | "demote" | "place" | "kill" | "succeed" | "retire" | "reaped" | "move" | "state" | "set" | "setup" | "reroute" | "get" | "pwd" | "toggle" | "cd" | "unset" | "outfits" | "gc" | "status" | "scopes" | "name" | "provider" | "troupe" | "box" | "valet" | "models" | "serve" | "stop" | "upgrade" | "version" | "keys" | "doctor" | "vault" | "update" | "completion" | "decide" | "notifications" | "history" | "login" | "comment";

export type CommandKind = "aria" | "form" | "outfit" | "patch" | "key" | "value" | "text" | "count" | "duration" | "path" | "word" | "verb";

export type CompletionSource = "arias" | "aria-flag" | "attend" | "choices" | "commands" | "dirs" | "export" | "files" | "forms" | "keys" | "providers" | "troupes" | "set" | "state" | "send" | "new" | "fork" | "succeed";

export type PagerMode = "routed" | "hosted" | "view" | "refused";

export interface CommandChoice {
  readonly name: string;
  readonly help: string;
  readonly keyboard?: boolean;
}

export interface CommandArg {
  readonly name: string;
  readonly kind: CommandKind;
  readonly optional?: boolean;
  readonly repeats?: boolean;
  readonly choices?: readonly CommandChoice[];
}

export interface CommandFlag {
  readonly long: string;
  readonly short?: string;
  readonly value?: CommandKind;
  readonly help: string;
  readonly default?: string;
  readonly subwords?: readonly string[];
  readonly repeats?: boolean;
}

export interface CommandDoc {
  readonly name: CommandName;
  readonly aliases?: readonly string[];
  readonly pagerAliases?: readonly string[];
  readonly group?: string;
  readonly help: string;
  readonly usage?: string;
  readonly args?: readonly CommandArg[];
  readonly flags?: readonly CommandFlag[];
  readonly raw?: boolean;
  readonly hidden?: boolean;
  readonly pagerOnly?: boolean;
  readonly complete?: CompletionSource;
  readonly pager: PagerMode;
  readonly refusal?: string;
  readonly switches?: boolean;
}

export const commandDocs: readonly CommandDoc[] = [
  {
    "name": "help",
    "group": "System",
    "help": "Show help for figaro or one of its commands",
    "usage": "help [\u003ccommand\u003e]",
    "args": [
      {
        "name": "command",
        "kind": "verb",
        "optional": true
      }
    ],
    "complete": "commands",
    "pager": "routed"
  },
  {
    "name": "show",
    "aliases": [
      "history"
    ],
    "group": "Prompt",
    "help": "Render an aria's message history",
    "usage": "show [\u003cid\u003e] [-n N | --from A [--to B] | --before T | -a] [--max-bytes N] [-j] [-o] [-v] [-l]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (alias for the positional)"
      },
      {
        "long": "details",
        "short": "o",
        "help": "Block addresses and timestamps, as m shows in the pager"
      },
      {
        "long": "verbose",
        "short": "v",
        "help": "Raw IR with patches, thinking, usage, transitions"
      },
      {
        "long": "literal",
        "short": "l",
        "help": "No ANSI / markdown rendering"
      },
      {
        "long": "all",
        "short": "a",
        "help": "Show every turn, not just last N"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit turns as raw JSON (the wire IR verbatim)"
      },
      {
        "long": "from",
        "value": "word",
        "help": "Start turn id (inclusive)"
      },
      {
        "long": "to",
        "value": "word",
        "help": "End turn id (inclusive)"
      },
      {
        "long": "before",
        "value": "word",
        "help": "Show N turns before this turn id (paginate backwards)"
      },
      {
        "long": "max-bytes",
        "value": "count",
        "help": "Cap the painted size; the oldest turns of the selection are dropped first"
      },
      {
        "long": "last",
        "short": "n",
        "value": "count",
        "help": "Show the last N turns (paginate backwards from the end)"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "send",
    "aliases": [
      "qua"
    ],
    "pagerAliases": [
      "s"
    ],
    "group": "Prompt",
    "help": "Send a prompt to an aria",
    "usage": "send [--id \u003cid\u003e] [-O \u003cspec\u003e] [-S \u003ck=v\u003e] [-D \u003cpaths\u003e] [-r] [-v] [-o] [-l] [-x] [-n] [-y] [-f] [-j] [--image \u003cfile\u003e]... [--stdin | -- \u003cprompt\u003e]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "prompt",
        "kind": "text",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target a specific existing aria"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Dress the aria in an outfit"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Patch the bound form in the same call: k=v; repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Remove bound form keys in the same call; repeats",
        "repeats": true
      },
      {
        "long": "raw",
        "short": "r",
        "help": "Stream verbatim to stdout: no ANSI, no markdown"
      },
      {
        "long": "verbatim",
        "short": "v",
        "help": "Dump the raw wire frames as JSON"
      },
      {
        "long": "verbose",
        "short": "o",
        "help": "Expand full tool inputs"
      },
      {
        "long": "listen",
        "short": "l",
        "help": "Open the transcript pager at startup"
      },
      {
        "long": "exec",
        "short": "x",
        "help": "Treat the prompt as a bash instruction"
      },
      {
        "long": "dry-run",
        "short": "n",
        "help": "--exec only: print the script without running it"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "--exec only: skip the confirmation prompt"
      },
      {
        "long": "forget",
        "short": "f",
        "help": "Submit the prompt and exit immediately"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit a single JSON line on stdout"
      },
      {
        "long": "stay",
        "help": "Do not move this shell"
      },
      {
        "long": "no-studies",
        "help": "fork only: the branch studies nothing"
      },
      {
        "long": "record",
        "value": "path",
        "help": "Record the wire to a tape file"
      },
      {
        "long": "stdin",
        "help": "Read the prompt from stdin, never from argv; to an aria log the entry lands byte for byte, empty included"
      },
      {
        "long": "image",
        "value": "path",
        "help": "Attach an image file to the prompt (repeatable)"
      }
    ],
    "raw": true,
    "complete": "send",
    "pager": "hosted"
  },
  {
    "name": "read",
    "group": "Prompt",
    "help": "Print an aria log's entries exactly as they were sent",
    "usage": "read [\u003cid\u003e] [--from N] [--until M] [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "from",
        "value": "count",
        "help": "First turn to print (default the first)"
      },
      {
        "long": "until",
        "value": "count",
        "help": "Stop before this turn (default the end)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "One JSON object per entry, exact bytes"
      }
    ],
    "complete": "send",
    "pager": "routed"
  },
  {
    "name": "new",
    "group": "Prompt",
    "help": "Start a fresh aria and prompt it",
    "usage": "new [-j|--json] [-O \u003cspec\u003e] [-C [\u003c@form\u003e]] [--log] [--image \u003cfile\u003e]... [--stdin | -- \u003cprompt\u003e]",
    "args": [
      {
        "name": "prompt",
        "kind": "text",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target a specific existing aria"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Dress the aria in an outfit"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Patch the bound form in the same call: k=v; repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Remove bound form keys in the same call; repeats",
        "repeats": true
      },
      {
        "long": "raw",
        "short": "r",
        "help": "Stream verbatim to stdout: no ANSI, no markdown"
      },
      {
        "long": "verbatim",
        "short": "v",
        "help": "Dump the raw wire frames as JSON"
      },
      {
        "long": "verbose",
        "short": "o",
        "help": "Expand full tool inputs"
      },
      {
        "long": "listen",
        "short": "l",
        "help": "Open the transcript pager at startup"
      },
      {
        "long": "exec",
        "short": "x",
        "help": "Treat the prompt as a bash instruction"
      },
      {
        "long": "dry-run",
        "short": "n",
        "help": "--exec only: print the script without running it"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "--exec only: skip the confirmation prompt"
      },
      {
        "long": "forget",
        "short": "f",
        "help": "Submit the prompt and exit immediately"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit a single JSON line on stdout"
      },
      {
        "long": "stay",
        "help": "Do not move this shell"
      },
      {
        "long": "no-studies",
        "help": "fork only: the branch studies nothing"
      },
      {
        "long": "record",
        "value": "path",
        "help": "Record the wire to a tape file"
      },
      {
        "long": "stdin",
        "help": "Read the prompt from stdin, never from argv; to an aria log the entry lands byte for byte, empty included"
      },
      {
        "long": "image",
        "value": "path",
        "help": "Attach an image file to the prompt (repeatable)"
      }
    ],
    "raw": true,
    "complete": "new",
    "pager": "hosted",
    "switches": true
  },
  {
    "name": "listen",
    "group": "Prompt",
    "help": "Open an aria in the pager without sending a prompt",
    "usage": "listen [\u003cid\u003e]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "record",
        "value": "path",
        "help": "Record the aria wire to a tape file (testing)"
      },
      {
        "long": "note",
        "value": "word",
        "help": "Note stored in the tape header: what you are hunting"
      }
    ],
    "complete": "arias",
    "pager": "hosted",
    "switches": true
  },
  {
    "name": "replay",
    "group": "Prompt",
    "help": "Replay a recorded aria wire tape through the real renderer",
    "usage": "replay \u003ctape\u003e [--speed \u003cx\u003e] [--summary] [--lockstep \u003csock\u003e [--fps \u003cn\u003e] [--anim-fps \u003cn\u003e]]",
    "args": [
      {
        "name": "tape",
        "kind": "path"
      }
    ],
    "flags": [
      {
        "long": "speed",
        "value": "word",
        "help": "Playback rate; 1 is real time (default 1)"
      },
      {
        "long": "summary",
        "help": "Describe the tape and exit"
      },
      {
        "long": "lockstep",
        "value": "word",
        "help": "Step on a virtual clock, driven over this unix socket"
      },
      {
        "long": "fps",
        "value": "word",
        "help": "Lockstep steps per tape second (default 60)"
      },
      {
        "long": "anim-fps",
        "value": "word",
        "help": "Lockstep animation rate, spinner included (default 12)"
      }
    ],
    "complete": "files",
    "pager": "refused",
    "refusal": "it opens a view of its own"
  },
  {
    "name": "hup",
    "group": "Prompt",
    "help": "Hang up: stop the turn, KEEP queued messages (-d discards them)",
    "usage": "hup [\u003cid\u003e] [-d|--drop-queued-messages] [-j|--json]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "drop-queued-messages",
        "short": "d",
        "help": "Discard the queued messages (they are still returned)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Print one JSON object (aria, cleared, queue) and exit"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "cut",
    "group": "Prompt",
    "help": "Shorthand for `hup -d`: stop the turn, DISCARD queued messages (returned)",
    "usage": "cut [\u003cid\u003e] [-j|--json]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "json",
        "short": "j",
        "help": "Print one JSON object (aria, cleared, the drained queue) and exit"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "queue",
    "group": "Prompt",
    "help": "Read, edit and delete the messages an aria has not answered yet",
    "usage": "queue [ls] | queue rm \u003cid\u003e... | queue rm --all | queue edit \u003cid\u003e -- \u003ctext\u003e   [--id \u003caria\u003e] [-j]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "optional": true,
        "choices": [
          {
            "name": "ls",
            "help": "list what is waiting"
          },
          {
            "name": "rm",
            "help": "drop messages by id"
          },
          {
            "name": "edit",
            "help": "rewrite one message"
          }
        ]
      },
      {
        "name": "message",
        "kind": "word",
        "optional": true,
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Address a specific aria (default: the attended one)"
      },
      {
        "long": "all",
        "help": "queue rm: drop every queued message"
      },
      {
        "long": "watch",
        "short": "w",
        "help": "Follow the queue live (the \u003caria\u003e/queue intrinsic)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Print one JSON object and exit"
      }
    ],
    "complete": "choices",
    "pager": "routed"
  },
  {
    "name": "list",
    "aliases": [
      "ls"
    ],
    "group": "Session",
    "help": "List arias: scoped to where you're attended (attend is `cd`)",
    "usage": "list [\u003cid\u003e|^N|/] [-H|--home | -g|--global] [-a|--all | -n \u003ccount\u003e] [-j|--json]",
    "args": [
      {
        "name": "scope",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "home",
        "short": "H",
        "help": "Home view: all top-level arias, without unbinding (-h is help)"
      },
      {
        "long": "global",
        "short": "g",
        "help": "Full hierarchy incl. the null + outfit anchors"
      },
      {
        "long": "all",
        "short": "a",
        "help": "Show all (remove the 10-row cap)"
      },
      {
        "long": "limit",
        "short": "n",
        "value": "count",
        "help": "Cap to N rows (default 10)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Pro/dev: all arias (incl. anchors) as JSON; no other flags"
      }
    ],
    "complete": "arias",
    "pager": "view"
  },
  {
    "name": "lsh",
    "group": "Session",
    "help": "List arias from home: `ls -H`, spelled shorter",
    "usage": "lsh [\u003cid\u003e] [-g|--global] [-a|--all | -n \u003ccount\u003e] [-j|--json]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "home",
        "short": "H",
        "help": "Home view: all top-level arias, without unbinding (-h is help)"
      },
      {
        "long": "global",
        "short": "g",
        "help": "Full hierarchy incl. the null + outfit anchors"
      },
      {
        "long": "all",
        "short": "a",
        "help": "Show all (remove the 10-row cap)"
      },
      {
        "long": "limit",
        "short": "n",
        "value": "count",
        "help": "Cap to N rows (default 10)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Pro/dev: all arias (incl. anchors) as JSON; no other flags"
      }
    ],
    "complete": "arias",
    "pager": "view"
  },
  {
    "name": "recent",
    "group": "Session",
    "help": "Every figaro, most recently active first, one row each",
    "usage": "recent [-n \u003ccount\u003e] [-j|--json]",
    "flags": [
      {
        "long": "limit",
        "short": "n",
        "value": "count",
        "help": "The newest N rows"
      },
      {
        "long": "json",
        "short": "j",
        "help": "The rows as JSON"
      }
    ],
    "pager": "view"
  },
  {
    "name": "back",
    "pagerAliases": [
      "aria-back"
    ],
    "group": "Session",
    "help": "Attend the figaro this shell attended before (ctrl+o in the pager)",
    "usage": "back [\u003cn\u003e]",
    "args": [
      {
        "name": "n",
        "kind": "count",
        "optional": true
      }
    ],
    "pager": "hosted"
  },
  {
    "name": "forward",
    "pagerAliases": [
      "aria-forward"
    ],
    "group": "Session",
    "help": "Undo a back: attend the next figaro in this shell's history (Tab in the pager)",
    "usage": "forward [\u003cn\u003e]",
    "args": [
      {
        "name": "n",
        "kind": "count",
        "optional": true
      }
    ],
    "pager": "hosted"
  },
  {
    "name": "attend",
    "aliases": [
      "at"
    ],
    "group": "Session",
    "help": "Bind this shell to an existing aria (optionally at a turn)",
    "usage": "attend \u003cid\u003e | \u003cid\u003e:\u003cturn\u003e | \u003cid\u003e.\u003clt\u003e | :\u003cturn\u003e | :head | null",
    "args": [
      {
        "name": "aria",
        "kind": "aria"
      }
    ],
    "complete": "attend",
    "pager": "hosted",
    "switches": true
  },
  {
    "name": "outfit",
    "group": "State",
    "help": "Outfit lifecycle: reload flags the default form for recomputation",
    "usage": "outfit reload",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "choices": [
          {
            "name": "reload",
            "help": "flag the default form for recomputation"
          }
        ]
      }
    ],
    "complete": "choices",
    "pager": "routed"
  },
  {
    "name": "study",
    "group": "Session",
    "help": "Subscribe this figaro to a form or another figaro (see its changes)",
    "usage": "study [\u003caria\u003e] \u003c@form-id | figaro-id\u003e [--keys \u003cprefix,...\u003e] | study [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "form",
        "kind": "form",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "keys",
        "short": "k",
        "value": "key",
        "help": "Mirror only keys under these comma-separated prefixes"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "complete": "forms",
    "pager": "routed"
  },
  {
    "name": "drop",
    "group": "Session",
    "help": "Unsubscribe this figaro from a studied form",
    "usage": "drop [\u003caria\u003e] \u003c@form-id | figaro-id\u003e",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "form",
        "kind": "form"
      }
    ],
    "flags": [
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "complete": "forms",
    "pager": "routed"
  },
  {
    "name": "cast",
    "group": "Session",
    "help": "Cast a figaro into a role (point target-aria here, and study it)",
    "usage": "cast [\u003caria\u003e] \u003c@form-id\u003e | cast [\u003caria\u003e] -O \u003cnames\u003e [-S \u003ck=v\u003e] [-j] | cast (attending a form)",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "form",
        "kind": "form",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Mint the role from these outfit NAMES (occupies the form slot)"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Mint the role with these keys (occupies the form slot); repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Key paths the minted role's birth patch removes; repeats",
        "repeats": true
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      },
      {
        "long": "stay",
        "help": "Do not attend the role this call mints"
      },
      {
        "long": "under",
        "value": "aria",
        "help": "Mint the role as a fork of this role, the one it reports to (occupies the form slot)"
      }
    ],
    "complete": "forms",
    "pager": "routed"
  },
  {
    "name": "bind",
    "group": "Session",
    "help": "Birth a figaro from an unbound form (dormant; never rebinds this shell)",
    "usage": "bind [\u003c@form-id\u003e | null] [-O \u003cnames\u003e] [-S \u003ck=v\u003e] [-j]",
    "args": [
      {
        "name": "form",
        "kind": "form",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Outfit NAMES folded into the birth patch"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Birth keys: k=v or a JSON literal; repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Key paths the birth patch removes; repeats",
        "repeats": true
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "complete": "forms",
    "pager": "routed"
  },
  {
    "name": "fork",
    "group": "Session",
    "help": "Branch a conversation: keep this id, mint an alternative",
    "usage": "fork [--id \u003cid\u003e | \u003cid\u003e[:\u003cturn\u003e[.\u003cnode\u003e]]] [--stay] [--no-studies] [-r|-v|-o|-l|-x|-n|-y|-f|-j] [-- \u003cprompt\u003e]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "prompt",
        "kind": "text",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target a specific existing aria"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Dress the aria in an outfit"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Patch the bound form in the same call: k=v; repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Remove bound form keys in the same call; repeats",
        "repeats": true
      },
      {
        "long": "raw",
        "short": "r",
        "help": "Stream verbatim to stdout: no ANSI, no markdown"
      },
      {
        "long": "verbatim",
        "short": "v",
        "help": "Dump the raw wire frames as JSON"
      },
      {
        "long": "verbose",
        "short": "o",
        "help": "Expand full tool inputs"
      },
      {
        "long": "listen",
        "short": "l",
        "help": "Open the transcript pager at startup"
      },
      {
        "long": "exec",
        "short": "x",
        "help": "Treat the prompt as a bash instruction"
      },
      {
        "long": "dry-run",
        "short": "n",
        "help": "--exec only: print the script without running it"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "--exec only: skip the confirmation prompt"
      },
      {
        "long": "forget",
        "short": "f",
        "help": "Submit the prompt and exit immediately"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit a single JSON line on stdout"
      },
      {
        "long": "stay",
        "help": "Do not move this shell"
      },
      {
        "long": "no-studies",
        "help": "fork only: the branch studies nothing"
      },
      {
        "long": "record",
        "value": "path",
        "help": "Record the wire to a tape file"
      },
      {
        "long": "stdin",
        "help": "Read the prompt from stdin, never from argv; to an aria log the entry lands byte for byte, empty included"
      },
      {
        "long": "image",
        "value": "path",
        "help": "Attach an image file to the prompt (repeatable)"
      }
    ],
    "raw": true,
    "complete": "fork",
    "pager": "hosted",
    "switches": true
  },
  {
    "name": "normalize",
    "help": "",
    "flags": [
      {
        "long": "dry-run",
        "short": "n",
        "help": "Report what would change; touch nothing"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit the report as JSON"
      }
    ],
    "hidden": true,
    "pager": "routed"
  },
  {
    "name": "export",
    "group": "Session",
    "help": "Write an aria to a portable file",
    "usage": "export [\u003cid\u003e] [-o \u003cfile\u003e]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "raw": true,
    "complete": "export",
    "pager": "routed"
  },
  {
    "name": "import",
    "group": "Session",
    "help": "Restore an exported aria into this store",
    "usage": "import \u003cfile\u003e",
    "args": [
      {
        "name": "file",
        "kind": "path",
        "optional": true
      }
    ],
    "complete": "files",
    "pager": "refused",
    "refusal": "it reads standard input for -"
  },
  {
    "name": "promote",
    "group": "Session",
    "help": "Raise an aria in the tree ls draws",
    "usage": "promote [--id \u003cid\u003e | \u003cid\u003e] [levels]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "levels",
        "kind": "count",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (defaults to this shell's)"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "adopt",
    "group": "Session",
    "help": "List, accept or refuse moves waiting on an aria",
    "usage": "adopt \u003cparent\u003e [-j] | adopt accept \u003cparent\u003e \u003cid\u003e | adopt refuse \u003cparent\u003e \u003cid\u003e",
    "args": [
      {
        "name": "parent",
        "kind": "aria"
      },
      {
        "name": "parent",
        "kind": "aria",
        "optional": true
      },
      {
        "name": "child",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "json",
        "short": "j",
        "help": "JSON output (list)"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "demote",
    "group": "Session",
    "help": "Sink an aria to a leaf so deleting it takes nothing else",
    "usage": "demote [--id \u003cid\u003e | \u003cid\u003e] [--under \u003cchild\u003e] [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Aria to demote (defaults to this shell's)"
      },
      {
        "long": "under",
        "value": "aria",
        "help": "The child that takes its place"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "place",
    "group": "Session",
    "help": "Draw a figaro under another figaro or form",
    "usage": "place [--id \u003cid\u003e | \u003cid\u003e] --under \u003cparent\u003e [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Figaro to place (defaults to this shell's)"
      },
      {
        "long": "under",
        "value": "aria",
        "help": "The figaro or form to draw it under"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "kill",
    "group": "Session",
    "help": "Stop a trunk and reap it; purged after a grace",
    "usage": "kill [--id \u003ctrunk\u003e | \u003ctrunk\u003e] [-r | --keep-children] [--when \u003cduration\u003e | --now]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target trunk id"
      },
      {
        "long": "recursive",
        "short": "r",
        "help": "Also take everything drawn under it"
      },
      {
        "long": "keep-children",
        "help": "Take it alone and lift its children to its parent, or to the top"
      },
      {
        "long": "when",
        "value": "duration",
        "help": "Grace before the purge (90m, 6h, 2d, 1w; 0 deletes now); default [memory] kill_grace_hours, 3 days"
      },
      {
        "long": "now",
        "help": "Delete at once instead of reaping"
      }
    ],
    "complete": "arias",
    "pager": "hosted"
  },
  {
    "name": "succeed",
    "group": "Session",
    "help": "Hand a role to a successor and wind the old aria down",
    "usage": "succeed \u003c@role\u003e [--turn \u003cn\u003e|head | --successor \u003caria\u003e] [--no-studies] [--title \u003ct\u003e] [-O \u003coutfits\u003e] [-S \u003ck=v\u003e] [-D \u003ckeys\u003e] [--ttl \u003cd\u003e] [--abdication retire|linger] [--stay] [-j] -- \u003cprompt\u003e",
    "args": [
      {
        "name": "role",
        "kind": "form",
        "optional": true
      },
      {
        "name": "prompt",
        "kind": "text",
        "optional": true,
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "turn",
        "value": "word",
        "help": "Fork the predecessor at this turn, or head to keep every turn (default 2)"
      },
      {
        "long": "successor",
        "value": "aria",
        "help": "An existing aria to take the role, instead of a fork"
      },
      {
        "long": "title",
        "value": "word",
        "help": "The successor's mantra"
      },
      {
        "long": "ttl",
        "value": "duration",
        "help": "Reap the predecessor this long from now; 0 kills it (default 10m)"
      },
      {
        "long": "abdication",
        "value": "word",
        "help": "retire (refuse prompts) or linger (keep taking them)"
      },
      {
        "long": "stay",
        "help": "In the pager, keep showing the predecessor"
      },
      {
        "long": "no-studies",
        "help": "The successor studies what the predecessor studied at --turn, not what it studies now"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Outfit NAMES folded into the successor's birth patch"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Successor birth keys: k=v or a JSON literal; repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Key paths the successor's birth patch removes; repeats",
        "repeats": true
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON report"
      }
    ],
    "complete": "succeed",
    "pager": "hosted"
  },
  {
    "name": "retire",
    "group": "Session",
    "help": "Stop an aria taking prompts, and dress it on the way out",
    "usage": "retire [--id \u003caria\u003e | \u003caria\u003e] [--ttl \u003cd\u003e] [-O \u003coutfits\u003e] [-S \u003ckeys\u003e] [-D \u003cpaths\u003e] [--undo] [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Aria to retire"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Outfit NAMES folded in with the retirement"
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "Keys set with the retirement: k=v or a JSON literal; repeats",
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "Key paths removed with the retirement; repeats",
        "repeats": true
      },
      {
        "long": "ttl",
        "value": "duration",
        "help": "Reap the aria this long from now (sets system.ttl from its age)"
      },
      {
        "long": "undo",
        "help": "Let the aria take prompts again"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "reaped",
    "group": "Session",
    "help": "Arias kill, gc and the ttl sweep reaped: list, restore or purge them",
    "usage": "reaped [ls | restore \u003cid\u003e [--keep] | purge \u003cid\u003e] [-j]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "optional": true,
        "choices": [
          {
            "name": "ls",
            "help": "the arias reaped and kept"
          },
          {
            "name": "restore",
            "help": "bring a reaped aria back"
          },
          {
            "name": "purge",
            "help": "delete a reaped aria for good"
          }
        ]
      },
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "keep",
        "help": "restore: also unset system.ttl on the root"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "pager": "view"
  },
  {
    "name": "move",
    "group": "Session",
    "help": "Move an aria and its whole fork tree to another node",
    "usage": "move [--id \u003caria\u003e | \u003caria\u003e] --to \u003cnode\u003e [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Aria to move (defaults to this shell's)"
      },
      {
        "long": "to",
        "value": "word",
        "help": "Node id, or a unique prefix of one"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Print the result as one JSON object"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "state",
    "aliases": [
      "form"
    ],
    "group": "State",
    "help": "Show the form, or shape it",
    "usage": "state [show] [\u003cid\u003e] | state set \u003ck\u003e \u003cv\u003e | state delete \u003cpaths\u003e | state new [-O \u003cnames\u003e] [-S \u003ck=v\u003e] | state outfit \u003cnames\u003e",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "optional": true,
        "choices": [
          {
            "name": "show",
            "help": "print the form"
          },
          {
            "name": "set",
            "help": "patch one path, or several in the -S grammar"
          },
          {
            "name": "delete",
            "help": "remove key paths, comma-separated"
          },
          {
            "name": "unset",
            "help": "remove key paths, as delete"
          },
          {
            "name": "outfit",
            "help": "fold outfits onto the form"
          },
          {
            "name": "apply",
            "help": "fold a patch onto the form"
          },
          {
            "name": "new",
            "help": "mint an unbound form"
          },
          {
            "name": "fork",
            "help": "copy a form into a new unbound one"
          },
          {
            "name": "ls",
            "help": "list forms"
          },
          {
            "name": "rm",
            "help": "remove an unbound form"
          },
          {
            "name": "listen",
            "help": "follow the form as it changes"
          },
          {
            "name": "help",
            "help": "the form and outfit grammar"
          }
        ]
      },
      {
        "name": "arg",
        "kind": "word",
        "optional": true,
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (overrides pid binding)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output (new/fork/ls emit machine-readable ids)"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "new/fork/apply: outfit NAMES",
        "subwords": [
          "new",
          "fork",
          "apply"
        ]
      },
      {
        "long": "managed",
        "value": "word",
        "help": "apply: comma-separated paths managed by the outfit",
        "subwords": [
          "apply"
        ]
      },
      {
        "long": "check",
        "help": "apply: report changes without writing",
        "subwords": [
          "apply"
        ]
      },
      {
        "long": "manifest",
        "value": "word",
        "help": "apply: TOML file of declared roles; replaces --id, --outfit and --managed",
        "subwords": [
          "apply"
        ]
      },
      {
        "long": "set",
        "short": "S",
        "value": "patch",
        "help": "new/fork: birth keys, k=v or a JSON literal; repeats",
        "subwords": [
          "new",
          "fork"
        ],
        "repeats": true
      },
      {
        "long": "delete",
        "short": "D",
        "value": "key",
        "help": "new/fork: key paths the birth patch removes; repeats",
        "subwords": [
          "new",
          "fork"
        ],
        "repeats": true
      },
      {
        "long": "list",
        "help": "outfit: list available outfits and exit",
        "subwords": [
          "outfit"
        ]
      },
      {
        "long": "tree",
        "help": "outfit: print the layer closure and exit; applies nothing",
        "subwords": [
          "outfit"
        ]
      },
      {
        "long": "refresh",
        "help": "outfit: re-read outfits and config from disk",
        "subwords": [
          "outfit"
        ]
      },
      {
        "long": "recursive",
        "help": "rm: also remove the form's live branches",
        "subwords": [
          "rm"
        ]
      }
    ],
    "complete": "state",
    "pager": "view"
  },
  {
    "name": "set",
    "group": "State",
    "help": "Patch a form key (no LLM round-trip)",
    "usage": "set [--id \u003cid\u003e] \u003ckey\u003e \u003cvalue\u003e",
    "args": [
      {
        "name": "key",
        "kind": "key"
      },
      {
        "name": "value",
        "kind": "value"
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (overrides pid binding)"
      }
    ],
    "complete": "set",
    "pager": "routed"
  },
  {
    "name": "setup",
    "group": "State",
    "help": "Deprecated: the first-run wizard; sign in with :login in the pager",
    "usage": "setup",
    "pager": "routed"
  },
  {
    "name": "reroute",
    "group": "State",
    "help": "Put a figaro back on the provider and model its outfits name",
    "usage": "reroute [--id \u003cid|@role\u003e] [-O \u003coutfits\u003e]",
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria or role (overrides pid binding)"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Outfit NAMES to read the route from instead"
      }
    ],
    "complete": "aria-flag",
    "pager": "routed"
  },
  {
    "name": "get",
    "group": "State",
    "help": "Print form values by path",
    "usage": "get [--id \u003cid\u003e] [-j] \u003cpath\u003e [\u003cpath\u003e...]",
    "args": [
      {
        "name": "key",
        "kind": "key",
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target figaro or form id (overrides pid binding)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON for every value; several paths make one object"
      }
    ],
    "complete": "keys",
    "pager": "routed"
  },
  {
    "name": "pwd",
    "group": "State",
    "help": "Print the directory a figaro's tools run in",
    "usage": "pwd [--id \u003cid\u003e] [-j]",
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target figaro id (overrides pid binding)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "The directory as a JSON string"
      }
    ],
    "complete": "aria-flag",
    "pager": "routed"
  },
  {
    "name": "toggle",
    "group": "State",
    "help": "Flip a true/false form key; absent reads the default outfit's, else false",
    "usage": "toggle [--id \u003cid\u003e] \u003ckey\u003e",
    "args": [
      {
        "name": "key",
        "kind": "key"
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (overrides pid binding)"
      }
    ],
    "complete": "set",
    "pager": "routed"
  },
  {
    "name": "cd",
    "group": "State",
    "help": "Change an aria's working directory",
    "usage": "cd [--id \u003cid\u003e] [\u003cpath\u003e]",
    "args": [
      {
        "name": "key",
        "kind": "key",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (overrides pid binding)"
      }
    ],
    "complete": "dirs",
    "pager": "routed"
  },
  {
    "name": "unset",
    "group": "State",
    "help": "Remove form key(s)",
    "usage": "unset [--id \u003cid\u003e] \u003ckey\u003e [\u003ckey\u003e...]",
    "args": [
      {
        "name": "key",
        "kind": "key",
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id (overrides pid binding)"
      }
    ],
    "complete": "keys",
    "pager": "routed"
  },
  {
    "name": "outfits",
    "group": "State",
    "help": "The outfit syntax (a help topic)",
    "usage": "help outfits",
    "hidden": true,
    "pager": "routed"
  },
  {
    "name": "gc",
    "group": "System",
    "help": "Choose figaros nobody uses and reap them, after a plan you confirm",
    "usage": "gc [--idle \u003cd\u003e] [--empty] [--older \u003cd\u003e] [--outfit \u003cname\u003e] [--under \u003cid\u003e] [--match \u003cquery\u003e] [--box \u003cname\u003e] [--yes | --dry-run] [-j] | gc --undo \u003crun\u003e",
    "flags": [
      {
        "long": "idle",
        "value": "duration",
        "help": "Choose figaros unused for at least this long (30d, 12h, 2w)"
      },
      {
        "long": "empty",
        "help": "Choose figaros that never had a message"
      },
      {
        "long": "older",
        "value": "duration",
        "help": "Choose figaros born at least this long ago"
      },
      {
        "long": "outfit",
        "value": "outfit",
        "help": "Choose figaros born under this outfit"
      },
      {
        "long": "under",
        "value": "aria",
        "help": "Choose figaros presented under this aria or form"
      },
      {
        "long": "match",
        "value": "word",
        "help": "Choose figaros whose mantra, handle, id or cwd hold every term (fzf syntax, no spread letters)"
      },
      {
        "long": "box",
        "value": "word",
        "help": "Choose figaros in this box"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "Apply the plan without asking"
      },
      {
        "long": "dry-run",
        "help": "Print the plan only"
      },
      {
        "long": "undo",
        "value": "word",
        "help": "Restore every figaro one run reaped"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Print the plan (or with --yes, the result) as JSON"
      }
    ],
    "pager": "routed"
  },
  {
    "name": "status",
    "aliases": [
      "info"
    ],
    "group": "Session",
    "help": "Show a focused view of one aria",
    "usage": "status [\u003cid\u003e | --id \u003cid\u003e] [-m] [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id"
      },
      {
        "long": "more",
        "short": "m",
        "help": "Surface derived/extra detail"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit the full status as JSON"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "scopes",
    "aliases": [
      "grants"
    ],
    "group": "Session",
    "help": "Show what an aria may do",
    "usage": "scopes [\u003cid\u003e | --id \u003cid\u003e] [-j]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit the answer as JSON"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "name",
    "group": "Session",
    "help": "Print an aria's name the way this CLI shows it",
    "usage": "name [\u003cid\u003e | --id \u003cid\u003e] [-m]",
    "args": [
      {
        "name": "aria",
        "kind": "aria",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Target aria id"
      },
      {
        "long": "more",
        "short": "m",
        "help": "Add the other spelling"
      }
    ],
    "complete": "arias",
    "pager": "routed"
  },
  {
    "name": "provider",
    "group": "System",
    "help": "Sign in to, sign out of, and list model providers",
    "usage": "provider \u003clogin | logout | ls\u003e [\u003cname\u003e] [-j]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "choices": [
          {
            "name": "login",
            "help": "sign in to a provider",
            "keyboard": true
          },
          {
            "name": "logout",
            "help": "remove figaro's credential for a provider",
            "keyboard": true
          },
          {
            "name": "ls",
            "help": "where each provider's credential comes from"
          }
        ]
      },
      {
        "name": "provider",
        "kind": "word",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "json",
        "short": "j",
        "help": "JSON for ls and logout"
      }
    ],
    "complete": "providers",
    "pager": "routed"
  },
  {
    "name": "troupe",
    "group": "System",
    "help": "Sign in to a troupe's door, list troupes, and hold this node's troupe keys",
    "usage": "troupe \u003clogin \u003cname\u003e | ls | join \u003cname\u003e | leave \u003cname\u003e | revoke \u003cname\u003e \u003cnode\u003e | renewer \u003cname\u003e \u003cnode\u003e \u003crenewer\u003e | keygen --out \u003cdir\u003e | leaf \u003cname\u003e --for \u003cnode-id\u003e --public-key \u003chex\u003e --door \u003chost:port\u003e --out \u003cdir\u003e [--ttl \u003cdays\u003e] | policy show \u003cname\u003e | policy set \u003cname\u003e \u003cfile|-\u003e | apikey mint|ls|revoke \u003cname\u003e ... | create \u003cname\u003e | intermediate \u003cname\u003e [--for \u003cnode-id\u003e --out \u003cdir\u003e]\u003e [-j]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "choices": [
          {
            "name": "login",
            "help": "sign in to a troupe's door",
            "keyboard": true
          },
          {
            "name": "ls",
            "help": "the troupes this CLI knows"
          },
          {
            "name": "join",
            "help": "sign this node into a troupe",
            "keyboard": true
          },
          {
            "name": "leave",
            "help": "sign this node out of its troupe for good",
            "keyboard": true
          },
          {
            "name": "revoke",
            "help": "with the root, revoke a node"
          },
          {
            "name": "renewer",
            "help": "with the root, name a node's renewer"
          },
          {
            "name": "keygen",
            "help": "a node key for a credential"
          },
          {
            "name": "leaf",
            "help": "with the root, issue another node's leaf for its key"
          },
          {
            "name": "policy",
            "help": "show or set the troupe policy"
          },
          {
            "name": "apikey",
            "help": "mint, list or revoke api keys"
          }
        ]
      },
      {
        "name": "troupe",
        "kind": "word",
        "optional": true
      },
      {
        "name": "node",
        "kind": "word",
        "optional": true
      },
      {
        "name": "renewer",
        "kind": "word",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "json",
        "short": "j",
        "help": "JSON for ls and policy show"
      },
      {
        "long": "delegate",
        "value": "word",
        "help": "join: all or none, what this node lends the troupe policy (required unless asked)"
      },
      {
        "long": "door",
        "value": "word",
        "help": "join: host:port other nodes dial (default [door.tls] advertise)"
      },
      {
        "long": "listen",
        "value": "word",
        "help": "join: host:port the node door listens on (default the door)"
      },
      {
        "long": "root-sha256",
        "value": "word",
        "help": "join: trust the troupe root only if its sha256 is this"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "join: trust the root shown without asking; leave: do not ask"
      },
      {
        "long": "for",
        "value": "word",
        "help": "intermediate: the node id to issue for, instead of this node"
      },
      {
        "long": "out",
        "value": "path",
        "help": "intermediate --for: the directory (a tmpfs) that receives the keys"
      },
      {
        "long": "allow-disk",
        "help": "intermediate --for: allow an --out that is not a tmpfs"
      },
      {
        "long": "root",
        "help": "policy set: sign with the root key on stdin (the first version needs it)"
      },
      {
        "long": "public-key",
        "value": "word",
        "help": "leaf: the node's Ed25519 public key in hex, as troupe keygen prints it"
      },
      {
        "long": "ttl",
        "value": "duration",
        "help": "apikey mint: how long the key lives, like 7d or 12h (default 90d, at most 365d; keep everyday keys short). leaf: the leaf's life (default 7d, at most [troupe] max_leaf_ttl)"
      },
      {
        "long": "nodes",
        "value": "word",
        "help": "apikey mint: the node ids the key is good on, comma-separated, or all (default: the minting node)"
      },
      {
        "long": "static",
        "help": "apikey mint: print the key and a config stanza; no daemon"
      }
    ],
    "complete": "troupes",
    "pager": "view"
  },
  {
    "name": "box",
    "group": "System",
    "help": "Serve a sandbox over a unix socket, or run one command through it",
    "usage": "box serve --socket \u003cpath\u003e --workspace \u003cdir\u003e [--door \u003cpath\u003e] | box exec --socket \u003cpath\u003e [--cwd \u003cdir\u003e] [--scope \u003cs\u003e] -- \u003ccommand\u003e",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "choices": [
          {
            "name": "serve",
            "help": "serve a sandbox over a unix socket"
          },
          {
            "name": "exec",
            "help": "run one command through a box"
          }
        ]
      },
      {
        "name": "arg",
        "kind": "word",
        "optional": true,
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "socket",
        "short": "s",
        "value": "word",
        "help": "the box's unix socket"
      },
      {
        "long": "workspace",
        "short": "w",
        "value": "word",
        "help": "serve: the directory every relative path and cwd resolves against"
      },
      {
        "long": "door",
        "value": "word",
        "help": "serve: the daemon's door socket for this box, as a path inside it"
      },
      {
        "long": "cwd",
        "value": "word",
        "help": "exec: working directory, relative to the workspace"
      },
      {
        "long": "scope",
        "value": "word",
        "help": "exec: session scope (default: this pid)"
      }
    ],
    "pager": "routed"
  },
  {
    "name": "valet",
    "group": "System",
    "help": "Grant figaros paths for the tools your valet runs as you",
    "usage": "valet grant \u003cfigaro|*\u003e \u003cpath\u003e ro|rw [--for 8h] | valet grants [-j] | valet revoke \u003cfigaro|*\u003e [\u003cpath\u003e] | valet serve [--peer \u003cuser\u003e] [--door \u003cpath\u003e] [--hide \u003cpath\u003e]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "choices": [
          {
            "name": "grant",
            "help": "let a figaro see a path"
          },
          {
            "name": "grants",
            "help": "the grants in force"
          },
          {
            "name": "revoke",
            "help": "take a grant back"
          },
          {
            "name": "serve",
            "help": "run the valet"
          }
        ]
      },
      {
        "name": "arg",
        "kind": "word",
        "optional": true,
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "for",
        "value": "word",
        "help": "grant: how long the grant lasts (default 8h; d and w suffixes work)"
      },
      {
        "long": "max-grant",
        "value": "word",
        "help": "grant, serve: the longest grant to accept or honour (default 7d)"
      },
      {
        "long": "state",
        "value": "word",
        "help": "the valet's state directory (default ~/.local/state/figaro-valet)"
      },
      {
        "long": "json",
        "short": "j",
        "help": "grants: machine-readable output"
      },
      {
        "long": "peer",
        "value": "word",
        "help": "serve: a user or uid that may call the valet; repeats",
        "repeats": true
      },
      {
        "long": "door",
        "value": "word",
        "help": "serve: the daemon's door socket for this box, bound into the fence"
      },
      {
        "long": "hide",
        "value": "word",
        "help": "serve: a path no tool sees; a grant overlapping it is dropped; repeats",
        "repeats": true
      }
    ],
    "pager": "routed"
  },
  {
    "name": "models",
    "group": "System",
    "help": "List the models every provider offers, from the daemon's catalog",
    "usage": "models [--refresh] [-j]",
    "flags": [
      {
        "long": "refresh",
        "help": "ask the daemon to list every provider now, and wait"
      },
      {
        "long": "json",
        "short": "j",
        "help": "JSON output"
      }
    ],
    "pager": "view"
  },
  {
    "name": "serve",
    "group": "System",
    "help": "Relay model requests to configured providers over loopback HTTP",
    "usage": "serve [-l \u003caddr\u003e] [-p \u003cprovider,...\u003e]",
    "flags": [
      {
        "long": "listen",
        "short": "l",
        "value": "word",
        "help": "loopback address to listen on (default 127.0.0.1:8788)"
      },
      {
        "long": "provider",
        "short": "p",
        "value": "word",
        "help": "comma-separated providers to serve (default: every one with a credential)"
      }
    ],
    "pager": "routed"
  },
  {
    "name": "stop",
    "aliases": [
      "rest"
    ],
    "group": "System",
    "help": "Shut down the angelus daemon and its hush agent",
    "usage": "stop [-f] [-k] [--forget-bindings] [--hup]",
    "flags": [
      {
        "long": "force",
        "short": "f",
        "help": "SIGKILL instead of graceful shutdown"
      },
      {
        "long": "keep-agent",
        "short": "k",
        "help": "A restart is coming: keep the unlocked hush agent"
      },
      {
        "long": "forget-bindings",
        "help": "The next angelus starts with no shell attended"
      },
      {
        "long": "hup",
        "help": "Hang up every running turn first, so none resumes after the restart"
      }
    ],
    "pager": "routed"
  },
  {
    "name": "upgrade",
    "group": "System",
    "help": "Restart the angelus on a build already installed, and the tmux panes that cannot reconnect",
    "usage": "upgrade --to \u003cfigaro\u003e [-n] [--if-changed] [--wait \u003cseconds\u003e] [--force] [--tmux-socket \u003cname\u003e]",
    "flags": [
      {
        "long": "to",
        "value": "word",
        "help": "The installed figaro binary to move to"
      },
      {
        "long": "dry-run",
        "short": "n",
        "help": "Print the plan and change nothing"
      },
      {
        "long": "if-changed",
        "help": "Do nothing when the running build is already this one"
      },
      {
        "long": "wait",
        "value": "word",
        "help": "Seconds to wait for running turns (default 120)"
      },
      {
        "long": "force",
        "help": "Interrupt turns still running after --wait"
      },
      {
        "long": "tmux-socket",
        "value": "word",
        "help": "The tmux server's socket name (tmux -L)"
      }
    ],
    "hidden": true,
    "pager": "routed"
  },
  {
    "name": "version",
    "aliases": [
      "v"
    ],
    "group": "System",
    "help": "Print build identity (revision, exe path, Go version) and the reachable daemon's node id",
    "usage": "version [-j]",
    "flags": [
      {
        "long": "json",
        "short": "j",
        "help": "One line of JSON"
      }
    ],
    "pager": "routed"
  },
  {
    "name": "keys",
    "group": "System",
    "help": "Show and edit the pager's keybindings (~/.config/figaro/keys.toml)",
    "usage": "keys [layers | actions | init | bind \u003ckeys\u003e \u003caction\u003e [\u003clayer\u003e] | unbind \u003ckeys\u003e [\u003clayer\u003e] | reset [\u003ckeys\u003e [\u003clayer\u003e]] | path]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "optional": true,
        "choices": [
          {
            "name": "layers",
            "help": "every layer, its modes, its bindings"
          },
          {
            "name": "actions",
            "help": "every verb, and where it means something"
          },
          {
            "name": "init",
            "help": "start a keys.toml from the shipped recipes"
          },
          {
            "name": "bind",
            "help": "bind keys to an action"
          },
          {
            "name": "unbind",
            "help": "unbind keys"
          },
          {
            "name": "reset",
            "help": "back to the defaults"
          },
          {
            "name": "path",
            "help": "where keys.toml lives"
          }
        ]
      },
      {
        "name": "arg",
        "kind": "word",
        "optional": true
      },
      {
        "name": "layer",
        "kind": "word",
        "optional": true
      }
    ],
    "pager": "routed"
  },
  {
    "name": "doctor",
    "group": "System",
    "help": "Store and provider health: gc removes dead channels; schema reports channel versions; mem reports the daemon's footprint; pprof arms the profiler on the running daemon; provider shows recent provider round-trips (including in-flight) and the decision routes methods have stopped asking; librettos recounts derived-form observers; normalize makes every aria own its history and drops the overrides its history now agrees with, and with --from opens a stopped store to move daemon-written keys under runtime.* (--revert moves them back); skills lists what the binary ships; outfits names the overlay files a managed .locked refuses; ttl lists the nodes carrying a lifetime and when it is spent; residents lists live agents, open endpoints and _meta sidecars whose id the store no longer holds; admission compares the daemon's cached fan-out counts with the tree; snapshot copies the most recently active arias, with their history and every form, into a new store; misread-lineage lists, read-only, the nodes whose stored chain has a falling fork base and what a translations v4 to v5 open does to them (clears their derived channels, refolds their _meta counters); quarantine lists the segments a corrupt frame keeps closed and releases one by cutting it at the bad frame, after copying it aside (owner only); unit says whether the daemon on the socket is the systemd unit's; mode says home or house, whether user namespaces let a valet fence tools, and whether the valet and each box answer",
    "usage": "doctor \u003cgc [--dry-run] | schema | term | mem [-j] [--gc] | pprof \u003con | off\u003e | provider [--id \u003caria\u003e] [-c N] [-j] | librettos [--dry-run] | normalize [--dry-run] [-j] [--from \u003cstore\u003e [--revert]] | prune-channel-dirs [-n|--dry-run] [-j] | skills [-j] | keys | form-keys [--audit] [-j] | outfits | ttl [-j] | tombstones [-j] [-n|--dry-run] [--reap] | residents [-j] | admission [-j] | unit [-j] | mode [-j] | snapshot \u003cdir\u003e [--from \u003cstore\u003e] [--arias N] [--max-mb M] [-j] | misread-lineage [--from \u003cstore\u003e] [-j] | quarantine [ls | release \u003cfigaro\u003e --at \u003coffset\u003e [--channel \u003cname\u003e] [--yes]]\u003e",
    "args": [
      {
        "name": "check",
        "kind": "word",
        "optional": true,
        "choices": [
          {
            "name": "gc",
            "help": "remove dead channels"
          },
          {
            "name": "schema",
            "help": "channel versions"
          },
          {
            "name": "term",
            "help": "terminal capabilities"
          },
          {
            "name": "mem",
            "help": "the daemon's footprint"
          },
          {
            "name": "pprof",
            "help": "arm or disarm the live profiler"
          },
          {
            "name": "provider",
            "help": "recent provider round-trips"
          },
          {
            "name": "librettos",
            "help": "recount derived-form observers"
          },
          {
            "name": "normalize",
            "help": "detach promoted arias, drop overrides history agrees with"
          },
          {
            "name": "prune-channel-dirs",
            "help": "remove channel directories that hold no rows"
          },
          {
            "name": "skills",
            "help": "what the binary ships"
          },
          {
            "name": "form-keys",
            "help": "the form key registry: writer, shape, doc; --audit checks every form"
          },
          {
            "name": "outfits",
            "help": "overlay files a managed .locked refuses"
          },
          {
            "name": "ttl",
            "help": "nodes carrying a lifetime"
          },
          {
            "name": "tombstones",
            "help": "listed arias whose bound form is tombstoned"
          },
          {
            "name": "residents",
            "help": "agents, endpoints and sidecars the store no longer holds"
          },
          {
            "name": "admission",
            "help": "the cached fan-out counts against the tree, and the enforcement switches with their would-refuse counts"
          },
          {
            "name": "unit",
            "help": "whether the daemon on the socket is the systemd unit's"
          },
          {
            "name": "mode",
            "help": "home or house, user namespaces, and whether the valet answers"
          },
          {
            "name": "snapshot",
            "help": "copy recent arias into a new store"
          },
          {
            "name": "misread-lineage",
            "help": "nodes whose stored chain falls, read-only"
          },
          {
            "name": "quarantine",
            "help": "segments a corrupt frame keeps closed, and releasing one"
          }
        ]
      },
      {
        "name": "arg",
        "kind": "word",
        "optional": true,
        "repeats": true
      }
    ],
    "flags": [
      {
        "long": "dry-run",
        "short": "n",
        "help": "Report what would be removed without touching the store"
      },
      {
        "long": "reap",
        "help": "tombstones: reap listed tombstoned arias through kill"
      },
      {
        "long": "audit",
        "help": "form-keys: read every form through the daemon and name the values that fail their shape"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Machine-readable output (mem, provider, form-keys, normalize, prune-channel-dirs, tombstones, residents, misread-lineage)"
      },
      {
        "long": "id",
        "value": "aria",
        "help": "Restrict to one aria (provider)"
      },
      {
        "long": "count",
        "short": "c",
        "value": "word",
        "help": "How many rows to show (provider); default 20"
      },
      {
        "long": "gc",
        "help": "mem: collect first, then report -- the only honest live-set reading (stops the world)"
      },
      {
        "long": "from",
        "value": "word",
        "help": "snapshot, misread-lineage: the store to read (default: this one); normalize: open that store offline, which moves daemon-written keys under runtime.*"
      },
      {
        "long": "revert",
        "help": "normalize --from: move runtime.* keys back to their system.* names, for a figaro from before runtime.*"
      },
      {
        "long": "arias",
        "value": "count",
        "help": "snapshot: how many of the most recently active arias (default 50, 0 = all)"
      },
      {
        "long": "max-mb",
        "value": "word",
        "help": "snapshot: the size cap in MB (default 500, 0 = none)"
      },
      {
        "long": "at",
        "value": "word",
        "help": "quarantine release: the corrupt frame's byte offset, as ls prints it"
      },
      {
        "long": "channel",
        "value": "word",
        "help": "quarantine release: the channel, when several hold a bad frame at that offset"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "quarantine release: release without asking"
      }
    ],
    "complete": "choices",
    "pager": "routed"
  },
  {
    "name": "vault",
    "aliases": [
      "hush"
    ],
    "group": "System",
    "help": "Inspect and repair figaro's embedded secrets vault",
    "usage": "vault \u003cstatus | init | reset | forget | unlock | lock\u003e [--file | --passphrase] [--yes]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "choices": [
          {
            "name": "status",
            "help": "whether the vault exists and is unlocked"
          },
          {
            "name": "init",
            "help": "create the vault identity",
            "keyboard": true
          },
          {
            "name": "reset",
            "help": "replace the vault identity",
            "keyboard": true
          },
          {
            "name": "forget",
            "help": "drop the remembered passphrase"
          },
          {
            "name": "unlock",
            "help": "unlock the vault for the daemon",
            "keyboard": true
          },
          {
            "name": "lock",
            "help": "lock the vault"
          }
        ]
      }
    ],
    "flags": [
      {
        "long": "file",
        "help": "Unlock from a 0600 passphrase file: no prompt, ever"
      },
      {
        "long": "passphrase",
        "help": "Unlock from a passphrase you type"
      },
      {
        "long": "yes",
        "short": "y",
        "help": "Skip the reset confirmation"
      }
    ],
    "complete": "choices",
    "pager": "routed"
  },
  {
    "name": "update",
    "group": "System",
    "help": "Check for a newer figaro release",
    "usage": "update [--check] [--json] [--apply]",
    "raw": true,
    "pager": "routed"
  },
  {
    "name": "completion",
    "group": "System",
    "help": "Generate or install a shell completion script",
    "usage": "completion \u003cbash|zsh|fish|powershell\u003e  |  completion install [\u003cshell\u003e]",
    "args": [
      {
        "name": "shell",
        "kind": "word",
        "choices": [
          {
            "name": "bash",
            "help": "print the bash script"
          },
          {
            "name": "zsh",
            "help": "print the zsh script"
          },
          {
            "name": "fish",
            "help": "print the fish script"
          },
          {
            "name": "powershell",
            "help": "print the powershell script"
          },
          {
            "name": "install",
            "help": "write it where the shell autoloads it"
          }
        ]
      },
      {
        "name": "shell",
        "kind": "word",
        "optional": true
      }
    ],
    "complete": "choices",
    "pager": "routed"
  },
  {
    "name": "decide",
    "group": "Prompt",
    "help": "Ask a decision model a yes/no or multiple-choice question",
    "usage": "decide [--id \u003cid\u003e | -O \u003coutfit\u003e] [-C \u003ca,b,...\u003e] [--provider \u003cname\u003e] [-m \u003cmodel\u003e] [--api systemone|openai] [--context \u003ctext|-\u003e] [--score] [-j] -- \u003cquestion\u003e",
    "args": [
      {
        "name": "question",
        "kind": "text",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "id",
        "value": "aria",
        "help": "Read this aria's conversation and form (default: the one bound to this shell)"
      },
      {
        "long": "outfit",
        "short": "O",
        "value": "outfit",
        "help": "Decide in this outfit's [system.decide] instead of an aria's, unbound"
      },
      {
        "long": "choices",
        "short": "C",
        "value": "word",
        "help": "Options, comma separated: -C=\"option 1\",\"option 2\"; @key names a form key"
      },
      {
        "long": "provider",
        "value": "word",
        "help": "Provider to send the decision through, for this call (default: system.decide.provider)"
      },
      {
        "long": "model",
        "short": "m",
        "value": "word",
        "help": "Decision model for this call (default: system.decide.model)"
      },
      {
        "long": "api",
        "value": "word",
        "help": "Decision API: systemone (jev, decision-1) or openai (luna); default inferred from the model"
      },
      {
        "long": "context",
        "value": "text",
        "help": "Text to decide over; - reads stdin"
      },
      {
        "long": "budget",
        "value": "count",
        "help": "Cap the context tokens sent"
      },
      {
        "long": "score",
        "help": "Treat the options as a scale, lowest first, and answer with the probability-weighted level"
      },
      {
        "long": "json",
        "short": "j",
        "help": "Emit the response as JSON"
      }
    ],
    "raw": true,
    "pager": "hosted"
  },
  {
    "name": "notifications",
    "aliases": [
      "no"
    ],
    "group": "Session",
    "help": "What figaro said, and what went wrong (space n)",
    "usage": "notifications [clear]",
    "args": [
      {
        "name": "verb",
        "kind": "word",
        "optional": true,
        "choices": [
          {
            "name": "clear",
            "help": "forget every notification"
          }
        ]
      }
    ],
    "pagerOnly": true,
    "complete": "choices",
    "pager": "hosted"
  },
  {
    "name": "history",
    "group": "Session",
    "help": "The figaros this shell attended, newest first",
    "usage": "history",
    "pagerOnly": true,
    "pager": "hosted"
  },
  {
    "name": "login",
    "group": "System",
    "help": "Sign in to or out of model providers, in a pit",
    "usage": "login [\u003cprovider\u003e]",
    "args": [
      {
        "name": "provider",
        "kind": "word",
        "optional": true
      }
    ],
    "pagerOnly": true,
    "pager": "hosted"
  },
  {
    "name": "comment",
    "group": "Session",
    "help": "Comment on the selected passage, reply to a comment, or delete one",
    "usage": "comment [#\u003cid\u003e[.\u003cn\u003e]] [-X] [-- \u003ctext\u003e]",
    "args": [
      {
        "name": "comment",
        "kind": "word",
        "optional": true
      },
      {
        "name": "text",
        "kind": "text",
        "optional": true
      }
    ],
    "flags": [
      {
        "long": "delete",
        "short": "X",
        "help": "Delete the comment named"
      }
    ],
    "raw": true,
    "pagerOnly": true,
    "pager": "hosted"
  }
];
