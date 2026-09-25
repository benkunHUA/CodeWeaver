/** Python's len() counts code points, not UTF-16 code units. */
export function charCount(text: string): number {
  return Array.from(text).length;
}
