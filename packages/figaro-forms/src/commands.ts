import { commandDocs, type CommandDoc } from "./commands.gen.js";

export * from "./commands.gen.js";
export * from "./commands-web.js";
import { pagerLookup, shellLookup } from "./lookup.js";

export const shellCommand = (word: string): CommandDoc | undefined => shellLookup(commandDocs, word);

export const pagerCommand = (word: string): CommandDoc | undefined => pagerLookup(commandDocs, word);

export function commandBounds(c: CommandDoc): { readonly min: number; readonly max: number } {
  let min = 0;
  for (const a of c.args ?? []) {
    if (!a.optional) min++;
    if (a.repeats) return { min, max: 0 };
  }
  return { min, max: (c.args ?? []).length };
}

export function readsKeyboard(c: CommandDoc, sub: string): boolean {
  return c.args?.[0]?.choices?.find((ch) => ch.name === sub)?.keyboard === true;
}
