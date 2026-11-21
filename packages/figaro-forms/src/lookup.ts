export interface Lookup {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly pagerAliases?: readonly string[];
  readonly pagerOnly?: boolean;
}

const names = (c: Lookup): readonly string[] => [c.name, ...(c.aliases ?? [])];

export function shellLookup<T extends Lookup>(docs: readonly T[], word: string): T | undefined {
  return docs.find((c) => !c.pagerOnly && names(c).includes(word));
}

export function pagerLookup<T extends Lookup>(docs: readonly T[], word: string): T | undefined {
  return (
    docs.find((c) => c.pagerOnly === true && names(c).includes(word)) ??
    docs.find((c) => !c.pagerOnly && (names(c).includes(word) || (c.pagerAliases ?? []).includes(word)))
  );
}
