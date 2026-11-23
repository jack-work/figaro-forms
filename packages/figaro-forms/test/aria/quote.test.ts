import { describe, expect, it } from "vitest";
import { formatQuote, parseQuote, QuoteError, type QuoteRange } from "../../src/aria/quote.js";

const range = (lt: number, block: number, so: number, el: number, eb: number, eo: number, hasBlock: boolean, offsets: boolean): QuoteRange => ({
  start: { lt, block, offset: so },
  end: { lt: el, block: eb, offset: eo },
  block: hasBlock,
  offsets,
});

describe("parseQuote and formatQuote, as api/quote does", () => {
  const cases: [string, QuoteRange, string][] = [
    ["<412>!", range(412, 0, 0, 412, 0, 0, false, false), ""],
    ["<412.0>!", range(412, 0, 0, 412, 0, 0, true, false), ""],
    ["<412.2>! and more", range(412, 2, 0, 412, 2, 0, true, false), "and more"],
    ["<412.0:23-1180>!", range(412, 0, 23, 412, 0, 1180, true, true), ""],
    ["<412.0:23-419.2:88>!\n\tq", range(412, 0, 23, 419, 2, 88, true, true), "q"],
    ["<412.0:5-5>!", range(412, 0, 5, 412, 0, 5, true, true), ""],
  ];
  for (const [input, want, rest] of cases) {
    it(`reads ${JSON.stringify(input)} and writes it back canonically`, () => {
      const got = parseQuote(input);
      expect(got).toEqual({ range: want, rest });
      expect(parseQuote(formatQuote(want))).toMatchObject({ range: want });
    });
  }

  it("treats an unterminated token as text", () => {
    for (const input of ["", "hello", "<412>", "<412> hello", "<412.0:23-1180> not terminated", "<3 you", "<div>hi</div>", " <412>!", "!<412>"]) {
      expect(parseQuote(input)).toBeUndefined();
    }
  });

  it("refuses a malformed token, naming it", () => {
    const cases: [string, string][] = [
      ["<>!", "empty coordinate"],
      ["<abc>!", 'lt "abc" is not a number'],
      ["<0>!", "lt 0 is not a message"],
      ["<-1>!", 'lt "-1" is not a number'],
      ["<412.>!", "missing block after '.'"],
      ["<412.x>!", 'block "x" is not a non-negative number'],
      ["<412.-1>!", 'block "-1" is not a non-negative number'],
      ["<412:23-1180>!", "offsets need a block"],
      ["<412.0:23>!", "offsets are start-end"],
      ["<412.0:-1180>!", "missing start offset"],
      ["<412.0:23->!", "missing end offset"],
      ["<412.0:a-b>!", 'start offset "a" is not a non-negative number'],
      ["<412.0:23-x>!", 'end offset "x" is not a non-negative number'],
      ["<412.0:30-20>!", "end 20 is before start 30"],
      ["<412.0:23-400:88>!", "span end needs a block"],
      ["<412.0:23-400.1:88>!", "span end is before its start"],
      ["<412.1:23-412.0:88>!", "span end is before its start"],
      ["<412.0:23-abc.1:88>!", 'span end: lt "abc" is not a number'],
      ["<412 .0>!", "no spaces"],
      ["<412.0 : 23-1180>!", "no spaces"],
    ];
    for (const [input, want] of cases) {
      expect(() => parseQuote(input), input).toThrow(QuoteError);
      expect(() => parseQuote(input), input).toThrow(want);
      expect(() => parseQuote(input), input).toThrow(/^quote: </);
    }
  });
});
