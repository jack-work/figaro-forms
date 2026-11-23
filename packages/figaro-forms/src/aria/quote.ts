export interface QuoteCoord {
  readonly lt: number;
  readonly block: number;
  readonly offset: number;
}

export interface QuoteRange {
  readonly start: QuoteCoord;
  readonly end: QuoteCoord;
  readonly block: boolean;
  readonly offsets: boolean;
}

export class QuoteError extends Error {}

export const spans = (r: QuoteRange): boolean => r.offsets && (r.start.lt !== r.end.lt || r.start.block !== r.end.block);

export function formatQuote(r: QuoteRange): string {
  let s = `<${r.start.lt}`;
  if (r.block) s += `.${r.start.block}`;
  if (r.offsets) {
    s += `:${r.start.offset}-`;
    if (spans(r)) s += `${r.end.lt}.${r.end.block}:`;
    s += `${r.end.offset}`;
  }
  return `${s}>!`;
}

export function parseQuote(text: string): { readonly range: QuoteRange; readonly rest: string } | undefined {
  if (!text.startsWith("<")) return undefined;
  const end = text.indexOf(">");
  if (end < 0 || text[end + 1] !== "!") return undefined;
  const body = text.slice(1, end);
  try {
    return { range: parseBody(body), rest: text.slice(end + 2).replace(/^[ \t\r\n]+/, "") };
  } catch (e) {
    if (e instanceof QuoteError) throw new QuoteError(`quote: <${body}>: ${e.message}`);
    throw e;
  }
}

function parseBody(body: string): QuoteRange {
  if (body === "") throw new QuoteError("empty coordinate");
  if (/[ \t\r\n]/.test(body)) throw new QuoteError("a coordinate has no spaces");
  const colon = body.indexOf(":");
  const head = colon < 0 ? body : body.slice(0, colon);
  const tail = colon < 0 ? "" : body.slice(colon + 1);
  const first = parseCoord(head);
  const start = { lt: first.lt, block: first.block, offset: 0 };
  if (colon < 0) return { start, end: start, block: first.hasBlock, offsets: false };
  if (!first.hasBlock) throw new QuoteError("offsets need a block: write lt.block:start-end");
  const dash = tail.indexOf("-");
  if (dash < 0) throw new QuoteError("offsets are start-end");
  const startOffset = parseOffset(tail.slice(0, dash), "start");
  let endS = tail.slice(dash + 1);
  let endLt = start.lt;
  let endBlock = start.block;
  const spanColon = endS.indexOf(":");
  if (spanColon >= 0) {
    let e: ReturnType<typeof parseCoord>;
    try {
      e = parseCoord(endS.slice(0, spanColon));
    } catch (err) {
      if (err instanceof QuoteError) throw new QuoteError(`span end: ${err.message}`);
      throw err;
    }
    if (!e.hasBlock) throw new QuoteError("span end needs a block: write lt.block:end");
    endLt = e.lt;
    endBlock = e.block;
    endS = endS.slice(spanColon + 1);
  }
  const endOffset = parseOffset(endS, "end");
  const range: QuoteRange = {
    start: { ...start, offset: startOffset },
    end: { lt: endLt, block: endBlock, offset: endOffset },
    block: true,
    offsets: true,
  };
  if (!spans(range) && endOffset < startOffset) throw new QuoteError(`end ${endOffset} is before start ${startOffset}`);
  if (spans(range) && (endLt < start.lt || (endLt === start.lt && endBlock < start.block))) throw new QuoteError("span end is before its start");
  return range;
}

function parseCoord(s: string): { lt: number; block: number; hasBlock: boolean } {
  const dot = s.indexOf(".");
  const ltS = dot < 0 ? s : s.slice(0, dot);
  if (ltS === "") throw new QuoteError("missing lt");
  if (!/^\d+$/.test(ltS) || !Number.isSafeInteger(Number(ltS))) throw new QuoteError(`lt "${ltS}" is not a number`);
  const lt = Number(ltS);
  if (lt === 0) throw new QuoteError("lt 0 is not a message");
  if (dot < 0) return { lt, block: 0, hasBlock: false };
  const blockS = s.slice(dot + 1);
  if (blockS === "") throw new QuoteError("missing block after '.'");
  if (!/^\d+$/.test(blockS) || !Number.isSafeInteger(Number(blockS))) throw new QuoteError(`block "${blockS}" is not a non-negative number`);
  return { lt, block: Number(blockS), hasBlock: true };
}

function parseOffset(s: string, which: string): number {
  if (s === "") throw new QuoteError(`missing ${which} offset`);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) throw new QuoteError(`${which} offset "${s}" is not a non-negative number`);
  return Number(s);
}
