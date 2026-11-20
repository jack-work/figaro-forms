export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

function advance(s: string, from: number, bytes: number): number {
  let i = from;
  let spent = 0;
  while (i < s.length && spent < bytes) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      spent += 1;
      i += 1;
    } else if (c < 0x800) {
      spent += 2;
      i += 1;
    } else if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      spent += 4;
      i += 2;
    } else {
      spent += 3;
      i += 1;
    }
  }
  return i;
}

export function spliceBytes(s: string, at: number, del: number, ins: string): string {
  const start = advance(s, 0, Math.max(0, at));
  const end = advance(s, start, Math.max(0, del));
  return s.slice(0, start) + ins + s.slice(end);
}

export interface Splice {
  readonly at: number;
  readonly del: number;
  readonly ins: string;
}

export function diffText(before: string, after: string): Splice | undefined {
  if (before === after) return undefined;
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  if (head > 0 && head < before.length && isLow(before.charCodeAt(head)) && isHigh(before.charCodeAt(head - 1))) head--;
  let tail = 0;
  while (tail < max - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  if (tail > 0 && isLow(before.charCodeAt(before.length - tail)) && isHigh(before.charCodeAt(before.length - tail - 1))) tail--;
  return { at: head, del: before.length - head - tail, ins: after.slice(head, after.length - tail) };
}
