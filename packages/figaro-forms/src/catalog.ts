import { webCommandDocs, type WebCommandDoc } from "./commands-slim.gen.js";
import { pagerLookup, shellLookup } from "./lookup.js";

export * from "./commands-slim.gen.js";
export * from "./commands-web.js";
export type { CommandName, CompletionSource, PagerMode } from "./commands.gen.js";

export const shellWebCommand = (word: string): WebCommandDoc | undefined => shellLookup(webCommandDocs, word);

export const pagerWebCommand = (word: string): WebCommandDoc | undefined => pagerLookup(webCommandDocs, word);
