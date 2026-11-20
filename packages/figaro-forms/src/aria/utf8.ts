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
