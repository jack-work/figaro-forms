import { commandDocs, type CommandDoc } from "./commands.gen.js";

export * from "./commands.gen.js";
export * from "./commands-web.js";

const names = (c: CommandDoc): readonly string[] => [c.name, ...(c.aliases ?? [])];

export function shellCommand(word: string): CommandDoc | undefined {
  return commandDocs.find((c) => !c.pagerOnly && names(c).includes(word));
}

export function pagerCommand(word: string): CommandDoc | undefined {
  return (
    commandDocs.find((c) => c.pagerOnly === true && names(c).includes(word)) ??
    commandDocs.find((c) => !c.pagerOnly && (names(c).includes(word) || (c.pagerAliases ?? []).includes(word)))
  );
}

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
