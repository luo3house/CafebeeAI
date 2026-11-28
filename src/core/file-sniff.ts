/**
 * Content-based "can these contents be fed to the model as text" probe.
 *
 * This replaced the extension whitelist as the read/edit/search/show_form gate: a whitelist can
 * never be complete, so it rejected real text (Makefile, extension-less scripts, `.conf`, and - a
 * genuine bug - `.svg`) while happily passing a PNG renamed to `.md`. The gate now looks at content.
 *
 * HOW IT RUNS: every caller has to read the file anyway (`readText`), so this takes the ALREADY
 * DECODED string and costs zero extra native calls. That is exactly why there is no magic-number
 * table, no MIME sniffing and no magika here: byte-level identification answers a different
 * question ("which decoder should receive these bytes" - what Chromium's mime_sniffer solves), and
 * magic bytes are not even recoverable from a decoded string (the PNG signature byte 0x89 decodes
 * to U+FFFD), so a mislabelled image cannot be named retroactively anyway. In this app nothing
 * hands bytes to a decoder; the only question is whether they may enter the prompt.
 *
 * THE RULE: a U+0000 anywhere in the decoded text means binary - the same test git's
 * `buffer_is_binary` and VS Code's text-buffer gate use. Two deliberate deviations:
 *  - the scan covers the WHOLE string, not git's 8000-byte window (git pays for that window on
 *    every blob in a repository; here the read already happened, and the entry points are
 *    size-capped at 8 MB / 512 KB / 256 KB + an 8 MB search total);
 *  - a UTF-8 BOM is skipped before scanning, so a BOM-prefixed file is never judged on it.
 *
 * WHAT IS NOT DETECTED, on purpose: 8-bit legacy encodings (GBK / latin-1 / Shift-JIS) contain no
 * NUL, so they pass and the model sees mojibake - precisely the behaviour before this change, i.e.
 * no newly-invented rejection. UTF-16 without an ASCII run is equally invisible: a Chinese-only
 * UTF-16LE byte pair decodes to ordinary Latin characters, not U+FFFD, so no string-level verdict
 * can recover it. Only ASCII-heavy UTF-16 is recognisable, and there it is REFUSED rather than
 * decoded: `readText` already destroyed the content, and "convert it to UTF-8" is the actionable
 * advice. Calling that file binary would be a wrong answer to the user's real problem.
 */

/** Verdict of a content probe. Anything other than `"text"` is a refusal. */
export type ContentKind = "text" | "binary" | "utf16le" | "utf16be"

const UTF8_BOM = 0xfeff
const NUL = "\u0000"
/** Sampling window for the UTF-16 endianness guess (the NUL verdict has already fired by then). */
const UTF16_SAMPLE_CHARS = 8192
/** Below this many sampled characters an endianness guess is noise, not a verdict. */
const UTF16_MIN_SAMPLE_CHARS = 8
/** ASCII-heavy UTF-16 read as UTF-8 is at least ~25% NUL. */
const UTF16_MIN_NUL_RATIO = 0.25
/** ...and those NULs alternate positions (LE: odd indices, BE: even) by this margin. */
const UTF16_ALTERNATION = 4

export function detectContentKind(text: string): ContentKind {
  if (text.length === 0) return "text"
  // No reassignment/slice: skipping one char beats copying a multi-MB string.
  const start = text.charCodeAt(0) === UTF8_BOM ? 1 : 0
  if (text.indexOf(NUL, start) === -1) return "text"
  return utf16Endianness(text, start) ?? "binary"
}

/**
 * Distinguish "a UTF-16 file we cannot decode" from "binary junk" - both contain NUL, and the two
 * deserve different error copy. A wrong guess only changes the wording, never the refusal.
 */
function utf16Endianness(text: string, start: number): "utf16le" | "utf16be" | null {
  const n = Math.min(text.length - start, UTF16_SAMPLE_CHARS)
  if (n < UTF16_MIN_SAMPLE_CHARS) return null
  let zeroEven = 0
  let zeroOdd = 0
  for (let i = start; i < start + n; i++) {
    if (text.charCodeAt(i) !== 0) continue
    if (i % 2 === 0) zeroEven++
    else zeroOdd++
  }
  const nuls = zeroEven + zeroOdd
  if (nuls < n * UTF16_MIN_NUL_RATIO) return null
  // "H\u0000e\u0000l\u0000l\u0000o\u0000" (UTF-16LE read as UTF-8) puts every NUL on an odd index; BE mirrors it.
  if (zeroOdd >= zeroEven * UTF16_ALTERNATION) return "utf16le"
  if (zeroEven >= zeroOdd * UTF16_ALTERNATION) return "utf16be"
  return null
}

/**
 * en-US refusal text for a probe that did not return `"text"` (Rule 14). UTF-16 gets its own
 * wording because the remedy is an encoding conversion, not "this file is not text".
 */
export function contentRejectionMessage(kind: Exclude<ContentKind, "text">, path: string, verb: "read" | "edit"): string {
  if (kind === "utf16le") return `Unsupported text encoding (UTF-16LE): ${path}`
  if (kind === "utf16be") return `Unsupported text encoding (UTF-16BE): ${path}`
  return `Cannot ${verb} binary file: ${path}`
}