# Comments on forms

Two layouts live on forms. Transcript comments (layout B) are the contract for
the web and the pager. The keel review mirror (layout A) is written by
`paperd notify` only; figaro-forms reads it and never writes it.

## Transcript comments (layout B, the contract)

Written and read by the pager (`internal/cli/comments.go`, `comment_verb.go`)
and by `src/aria/comments.ts` on the web, on the aria's bound form, under one
key.

```
comments.<id>.at                 string  quote token, e.g. <412.0:23-1180>!
comments.<id>.turn               int     optional, omitted when 0
comments.<id>.thread.<k>.by      string  optional, omitted when empty
comments.<id>.thread.<k>.text    string
```

- `<id>`: 3 or more characters from `abcdefghijkmnpqrstuvwxyz23456789`; longer
  only when 64 short draws collide.
- `<k>`: base-36 millisecond timestamp (8 characters today); when it would not
  sort after the thread's last key, the last key plus `0`. The thread is its
  entries sorted by `<k>`.
- `at`: `api/quote` grammar, ported in `src/aria/quote.ts` with the Go test
  cases. An `at` that does not parse hides the comment.
- `turn`: the pager derives it from the start LT when the turn is loaded; the
  web passes it. The pager wrote none for `<5>!` in a real capture, so readers
  must not rely on it.
- New: set `comments.<id>` to the whole record. Reply: set
  `comments.<id>.thread.<new k>`. Delete: unset `comments.<id>` (the `comments`
  object stays, possibly empty). Empty text is refused. No edit, resolve,
  unread or cursor.
- Order: comments by start coordinate of `at` (lt, block, offset), then id.
- Pager verbs, all covered: `:comment -- <quote> text` (new), `:comment #id --
  text` (reply; `#id.N` names a reply but the reply goes to the end),
  `:comment -X #id` (delete, whole comment).
- `comments` is reserved: `figaro form apply` never manages it.

Helpers: `foldComments`, `commentsByTurn`, `endBlockOf`, `addComment`,
`replyToComment`, `deleteComment`, through `BoundFormWriter.set/unset` only.
Deliberate differences from the pager: it drops every comment when one record
has a mistyped field, the fold drops only that record; new ids avoid every
existing key, not only those that parse.

## Review mirror (layout A, keel, read-only here)

Written only by `paperd notify` (keel `viewer/notify.go`), the sidecar that mirrors
a keel review into a form and wakes the seat the form points at. Read by the
seat (and by figaro-forms through `foldReview`). Flat top-level keys, always
written whole.

### Keys

`comment_<id>`: one comment. All fields always present.

| field  | type   | meaning |
|--------|--------|---------|
| thread | string | id of the thread it belongs to (no prefix) |
| kind   | string | `thread` (the thread's first comment), `comment` (a reply), or `edit`. The notifier also emits `resolved` and `reopened` events but writes no comment key for them |
| repo   | string | keel repository id |
| file   | string | path the thread is anchored to |
| line   | int    | anchor start line |
| quote  | string | the anchored text, one line, cut at 120 chars plus `...` |
| by     | string | author as the server renders it, `alias ⟩ account` when aliased |
| at     | string | RFC 3339 UTC, second precision, `Z` suffix |
| body   | string | the comment text |

`thread_<id>`: one thread's index entry. All fields always present.

| field    | type   | meaning |
|----------|--------|---------|
| repo     | string | as above |
| file     | string | as above |
| line     | int    | as above |
| quote    | string | as above |
| n        | int    | comments in the thread on the server, not the number of `comment_` keys |
| by       | string | author of the newest comment |
| last     | string | RFC 3339 time of the newest comment |
| resolved | bool   | thread state |
| unread   | int    | deliverable events for this thread not yet delivered to the seat |

Scalars on the same form:

| key          | type   | meaning |
|--------------|--------|---------|
| repo         | string | the watched repository |
| cursor       | string | newest comment time, RFC 3339, or `none`. For a human reading the board; the notifier's authority on what is new is its on-disk snapshot keyed by comment id |
| unread       | int    | sum over threads of `unread` (the length of the notifier's delivery debt) |
| threads_open | int    | threads not resolved |
| updated      | string | RFC 3339 time of the last notifier round |

`thread_` and `comment_` are runtime-owned: `figaro form apply` refuses them
(`internal/formapply/managed.go`). Neither the pager nor anything else in
figaro core reads or writes them.

### Who writes what

- `paperd notify`: all of the above, per round. A thread key is rewritten for
  every changed thread, deliverable or not. A comment key is written only for
  events that are deliverable, so a comment the seat itself wrote has a `n`
  count but no `comment_` key. Scalars are rewritten after the threads.
- `figaro-forms`: reads only (`foldReview`). It never writes these keys.

### Ordering

Not specified by the writer. `foldReview` uses: threads by file, line,
then id; comments inside a thread by `at`, then id. `at` has second precision,
so replies within one second tie and fall back to id.

### Write semantics that shape the layout

- A studied form's delta cuts a value past about 2046 characters. Hence one key
  per comment.
- `figaro set <key> <json-object>` from the CLI merges into an existing object
  (measured by the notifier's author). Field omission is therefore not erasure,
  and every field is always written. Through the form door
  (`Replica.set`) setting an existing key replaces the value whole; a CLI-driven
  rewrite of `resolved` and `unread` was checked against a live daemon on
  2026-11-23 and replaced as expected.
- Nested paths against an existing key write a flat decoy sibling from the
  CLI, so the layout has no nesting.

## Notes for keel (layout A)

The layout question is settled: transcript comments are B and the web writes B. These remain on the keel side.

1. (settled, see above) Two layouts, no reader in common. The pager marks and threads only
   `comments.<id>`; it reads nothing under `comment_` or `thread_`, so a review
   comment written to a form shows in the pager as raw keys in the state tree,
   with no mark in a transcript. A comment written by the web in layout A does
   not appear in the pager's comment view, and a pager comment is invisible to
   anything that folds layout A. The lane goal "a comment written on the web
   shows in the pager and back" needs a decision: which layout the web writes,
   or a mapping between them. Anchors differ in kind (file and line against a
   transcript quote range), so a mapping is not mechanical.
2. `threads_open` on the real role form disagrees with its thread keys: the
   scalar says 2, nine thread keys are unresolved. The notifier counts the live
   threads of one scoped monitor; thread keys from an earlier or wider scope
   are never removed. The helpers recompute the scalar from the keys they see,
   so their first write corrects it to 9. Which is authoritative is open.
3. A comment the seat itself wrote has no `comment_` key, so a folded thread
   can hold fewer comments than `n`. The fold reports both.
4. `kind` values: the notifier's event kinds are `thread`, `comment`, `edit`,
   `resolved`, `reopened`, but only the first three reach a comment key. `edit`
   writes a new `comment_<id>` under the same comment id as the original, which
   replaces it in place; the form then holds the edited text and nothing marks
   it as edited.
5. Unread is a count of the notifier's debt, which clears on a successful send,
   not on the seat reading. Whether `markRead` from a reader should be a
   distinct state from "woken" is open.
6. `at` is second precision, so ordering inside one second falls back to the
   comment id, which is random. Replies in the same second can fold out of
   order.
7. No deletion in layout A: nothing removes a `comment_` or `thread_` key when
   keel deletes the comment (the notifier records deletions and emits nothing).
   Stale keys accumulate; this is also how question 2 arises.
