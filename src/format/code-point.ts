/** A numeric character reference's character; one no scalar value holds (0, a
 *  surrogate, past U+10FFFF) is U+FFFD, as the HTML parser reads it, so it
 *  never reaches `String.fromCodePoint`'s RangeError. Pure, chat-safe. */
export function codePointText(n: number): string {
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "�";
}
