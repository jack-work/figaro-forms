const maxRun = 160;

export interface Split {
  readonly ready: string;
  readonly rest: string;
}

export function takeSentences(buffer: string, final: boolean): Split {
  if (final) return { ready: buffer, rest: "" };
  let cut = 0;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i] as string;
    if (c === "\n") {
      cut = i + 1;
      continue;
    }
    if (c !== "." && c !== "!" && c !== "?" && c !== "…") continue;
    let j = i + 1;
    while (j < buffer.length && /["')\]*_]/.test(buffer[j] as string)) j++;
    if (j < buffer.length && /\s/.test(buffer[j] as string)) {
      cut = j + 1;
      i = j;
    }
  }
  if (cut === 0 && buffer.length > maxRun) {
    const space = buffer.lastIndexOf(" ");
    if (space > 0) cut = space + 1;
  }
  return { ready: buffer.slice(0, cut), rest: buffer.slice(cut) };
}
