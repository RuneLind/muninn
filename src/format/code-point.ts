/** windows-1252's characters for U+0080–U+009F; a space marks a hole, which
 *  stays its own code point (the HTML standard's table). */
const C1 = "€ ‚ƒ„…†‡ˆ‰Š‹Œ Ž  ‘’“”•–—˜™š›œ žŸ";

/** A numeric character reference's character, as the HTML parser reads it: one
 *  no scalar value holds (0, a surrogate, past U+10FFFF) is U+FFFD, so it never
 *  reaches `String.fromCodePoint`'s RangeError, and U+0080–U+009F read as
 *  windows-1252. Pure, chat-safe. */
export function codePointText(n: number): string {
  if (n >= 0x80 && n <= 0x9f && C1[n - 0x80] !== " ") return C1[n - 0x80]!;
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "�";
}
