/**
 * Lightweight Markdown rendering (paragraphs/headings/lists/quotes/rules/code blocks/tables/inline styles).
 * Component version: parses down to inline sequences.
 * With compact=true (AI answer article) code blocks/tables shrink to the tool-card font size and padding; tables measure against the screen width by content:
 * if they fit, columns split evenly with no horizontal scroll; if not (long URLs/code or other unbreakable content), columns take natural width + horizontal scroll.
 */
import React, { useCallback, useMemo, useState } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { useTheme } from "react-native-paper"
import { fs } from "../../app/app.ui.theme"
import { CodeBlock } from "./code-block"

const CELL_FONT_SIZE = 12
const CELL_LINE_HEIGHT = 18
const CELL_PAD_X = 8
const CELL_PAD_Y = 4
const BODY_FONT_SIZE = 14

export interface InlineToken {
  key: string
  kind: "text" | "bold" | "italic" | "code"
  text: string
}

/** Inline parsing: `code`, **bold**, *italic* */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push("text", text.slice(last, m.index))
    const raw = m[0]
    if (raw.startsWith("`")) push("code", raw.slice(1, -1))
    else if (raw.startsWith("**")) push("bold", raw.slice(2, -2))
    else push("italic", raw.slice(1, -1))
    last = m.index + raw.length
  }
  if (last < text.length) push("text", text.slice(last))
  if (tokens.length === 0) tokens.push({ key: "0", kind: "text", text })
  return tokens

  function push(kind: InlineToken["kind"], text: string) {
    if (!text) return
    tokens.push({ key: `${kind}_${i++}`, kind, text })
  }
}

export function InlineText({
  text,
  color,
  selectable = true,
  fontSize,
  lineHeight,
}: {
  text: string
  color?: string
  selectable?: boolean
  fontSize?: number
  lineHeight?: number
}) {
  const theme = useTheme()
  const base = { color: color ?? theme.colors.onSurface, fontSize, lineHeight }
  const parts = parseInline(text)
  return (
    <Text style={base} selectable={selectable}>
      {parts.map((t) => {
        if (t.kind === "bold")
          return (
            <Text key={t.key} selectable={selectable} style={{ fontWeight: "700" }}>
              {t.text}
            </Text>
          )
        if (t.kind === "italic")
          return (
            <Text key={t.key} selectable={selectable} style={{ fontStyle: "italic" }}>
              {t.text}
            </Text>
          )
        if (t.kind === "code") {
          return (
            <Text
              key={t.key}
              selectable={selectable}
              style={{
                fontFamily: "monospace",
                backgroundColor: theme.colors.surfaceVariant,
                borderRadius: 4,
                paddingHorizontal: 4,
                overflow: "hidden",
              }}
            >
              {t.text}
            </Text>
          )
        }
        return (
          <Text key={t.key} selectable={selectable}>
            {t.text}
          </Text>
        )
      })}
    </Text>
  )
}

// ---------------- Tables ----------------

export type TableAlign = "left" | "center" | "right"

export interface MarkdownTable {
  header: string[]
  rows: string[][]
  aligns: TableAlign[]
}

function splitTableCells(line: string): string[] | null {
  if (!line.includes("|")) return null
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const parts: string[] = []
  let cur = ""
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|"
      i++
    } else if (s[i] === "|") {
      parts.push(cur)
      cur = ""
    } else {
      cur += s[i]
    }
  }
  parts.push(cur)
  return parts.map((c) => c.trim())
}

function parseTableAligns(cells: string[]): TableAlign[] | null {
  const aligns: TableAlign[] = []
  for (const raw of cells) {
    const c = raw.trim()
    if (!/^:?-+:?$/.test(c)) return null
    const left = c.startsWith(":")
    const right = c.endsWith(":")
    aligns.push(left && right ? "center" : right ? "right" : "left")
  }
  return aligns
}

function matchTable(lines: string[], start: number): { table: MarkdownTable; next: number } | null {
  const headerCells = splitTableCells(lines[start])
  if (!headerCells || headerCells.length < 1) return null
  const sepLine = lines[start + 1]
  if (sepLine === undefined || !sepLine.includes("|")) return null
  const sepCells = splitTableCells(sepLine)
  if (!sepCells || sepCells.length === 0 || sepCells.some((c) => c === "")) return null
  const aligns = parseTableAligns(sepCells)
  if (!aligns || aligns.length !== headerCells.length) return null
  const rows: string[][] = []
  let next = start + 2
  while (next < lines.length && lines[next].trim() !== "") {
    const cells = splitTableCells(lines[next])
    if (!cells || cells.length < headerCells.length) break
    rows.push(cells.slice(0, headerCells.length))
    next++
  }
  return { table: { header: headerCells, rows, aligns }, next }
}

/** Approximate single-cell width: ASCII half-width + CJK/emoji full-width (monospace uses 0.6, estimated at 0.62) */
function approxCellWidth(text: string, fontSize: number, monospace: boolean): number {
  let units = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x2e80) units += 1
    else units += monospace ? 0.62 : code >= 0x3000 ? 1 : 0.55
  }
  return Math.ceil(units * fontSize)
}

function cellTextAlign(align: TableAlign): "left" | "center" | "right" {
  return align
}

function MarkdownTableBlock({ table, color, selectable }: { table: MarkdownTable; color?: string; selectable?: boolean }) {
  const theme = useTheme()
  const [containerWidth, setContainerWidth] = useState(0)
  const cellSize = fs(theme, CELL_FONT_SIZE)
  const cellLine = fs(theme, CELL_LINE_HEIGHT)
  const onContainerLayout = useCallback((e: { nativeEvent: { layout: { width: number } } }) => {
    const width = e?.nativeEvent?.layout?.width ?? 0
    if (width <= 0) return
    setContainerWidth((w) => (Math.abs(w - width) > 1 ? width : w))
  }, [])

  const measured = useMemo(() => {
    const colCount = table.header.length
    const flexMin = Array<number>(colCount).fill(0)
    const natMin = Array<number>(colCount).fill(0)
    const natMax = Array<number>(colCount).fill(0)
    const maxChars = Array<number>(colCount).fill(0)
    const linesCount = (cells: string[]) => cells.reduce((mx, c) => Math.max(mx, Math.ceil((c.length || 1) / 14)), 1)
    const scan = (cells: string[]) => {
      for (let k = 0; k < colCount; k++) {
        const c = cells[k] ?? ""
        const hasCode = /`[^`]+`/.test(c)
        const w = approxCellWidth(c, cellSize, hasCode) + CELL_PAD_X * 2 + 2
        natMax[k] = Math.max(natMax[k], w)
        natMin[k] = Math.max(natMin[k], Math.min(w, cellSize * 5 + CELL_PAD_X * 2))
        flexMin[k] = Math.max(flexMin[k], cellSize * 6 + CELL_PAD_X * 2)
        maxChars[k] = Math.max(maxChars[k], c.length)
      }
    }
    scan(table.header)
    table.rows.forEach(scan)
    const wrapLines = table.rows.reduce((s, r) => s + linesCount(r), linesCount(table.header))
    const anyWide = maxChars.some((n) => n > 40)
    return { flexMin, natMin, natMax, wrapLines, anyWide }
  }, [table, cellSize])

  const cols = useMemo(() => {
    const n = table.header.length
    if (!containerWidth) return { widths: null as number[] | null, scroll: false }
    const { flexMin, natMin, natMax, wrapLines, anyWide } = measured
    const fit = containerWidth - 4
    const base = flexMin.reduce((a, b) => a + b, 0)
    // Few rows and narrow columns: split the screen width evenly; long URLs/code or many rows: even splitting can't contain them, use natural width + horizontal scroll
    const scroll = anyWide || wrapLines > 14 || base > fit
    if (!scroll) return { widths: null, scroll: false }
    const widths: number[] = []
    for (let k = 0; k < n; k++) {
      const nat = Math.max(natMin[k] ?? 60, natMax[k] ?? 80)
      // lower bound spreads evenly to fill the screen width, upper bound caps one column at 2× screen width (prevents extremely long content from blowing it up), natural width in between — column widths must be able to exceed the screen width or horizontal scrolling is impossible
      widths.push(Math.min(Math.max(fit / n, nat), fit * 2))
    }
    return { widths, scroll: true }
  }, [containerWidth, table.header.length, measured])

  const renderRow = (cells: string[], isHeader: boolean, rowIdx: number) => (
    <View
      key={`r_${rowIdx}`}
      style={[
        styles.tableRow,
        isHeader ? { backgroundColor: theme.colors.surfaceVariant } : undefined,
        rowIdx === 0 ? undefined : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outlineVariant },
      ]}
    >
      {cells.map((c, k) => {
        const width = cols.widths ? cols.widths[k] : undefined
        const align = isHeader ? "left" : table.aligns[k] ?? "left"
        return (
          <View
            key={k}
            style={{
              paddingVertical: CELL_PAD_Y,
              paddingHorizontal: CELL_PAD_X,
              borderRightWidth: k < cells.length - 1 ? StyleSheet.hairlineWidth : 0,
              borderRightColor: theme.colors.outlineVariant,
              ...(width ? { width } : { flex: 1, minWidth: 0 }),
            }}
          >
            {width ? (
              <Text
                numberOfLines={1}
                selectable={selectable}
                style={{
                  fontSize: cellSize,
                  lineHeight: cellLine,
                  color: isHeader ? theme.colors.onSurfaceVariant : color ?? theme.colors.onSurface,
                  fontWeight: isHeader ? "600" : "400",
                  textAlign: cellTextAlign(align),
                }}
              >
                {c}
              </Text>
            ) : (
              <Text
                selectable={selectable}
                style={{
                  fontSize: cellSize,
                  lineHeight: cellLine,
                  color: isHeader ? theme.colors.onSurfaceVariant : color ?? theme.colors.onSurface,
                  fontWeight: isHeader ? "600" : "400",
                  textAlign: cellTextAlign(align),
                  flexShrink: 1,
                }}
              >
                <InlineText text={c} color={isHeader ? theme.colors.onSurfaceVariant : color} selectable={selectable} />
              </Text>
            )}
          </View>
        )
      })}
    </View>
  )

  const content = (
    <View style={[styles.table, { borderColor: theme.colors.outlineVariant }, cols.scroll ? { minWidth: containerWidth || undefined } : undefined]}>
      {renderRow(table.header, true, 0)}
      {table.rows.map((r, idx) => renderRow(r, false, idx + 1))}
    </View>
  )

  return (
    <View style={styles.tableWrap} onLayout={onContainerLayout}>
      {cols.scroll && containerWidth > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={{ width: containerWidth }}>
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </View>
  )
}

// ---------------- Block-level rendering ----------------

export function MarkdownBlock({
  content,
  compact,
  color,
  selectable = true,
  lineHeightScale,
  wrap,
}: {
  content: string
  compact?: boolean
  color?: string
  selectable?: boolean
  lineHeightScale?: number
  wrap?: boolean
}) {
  const theme = useTheme()
  // Explicit font size (instead of inheriting the RN default) so the app-wide font scale applies on every block path
  const bodySize = fs(theme, BODY_FONT_SIZE)
  const bodyLineHeight = lineHeightScale ? Math.round(bodySize * lineHeightScale) : undefined
  const bodyFontStyle = { fontSize: bodySize, lineHeight: bodyLineHeight }
  const lines = String(content ?? "").split("\n")
  const blocks: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith("```")) {
      const fence = [line]
      let j = i + 1
      while (j < lines.length && !lines[j].trim().startsWith("```")) {
        fence.push(lines[j])
        j++
      }
      const lang = line.slice(3).trim()
      const code = fence.slice(1).join("\n")
      blocks.push(<CodeBlock key={`code_${i}`} code={code} language={lang} compact={compact} wrap={wrap} />)
      i = j + 1
      continue
    }

    const tableMatch = matchTable(lines, i)
    if (tableMatch) {
      blocks.push(<MarkdownTableBlock key={`table_${i}`} table={tableMatch.table} color={color} selectable={selectable} />)
      i = tableMatch.next
      continue
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      const level = trimmed.match(/^(#{1,6})\s(.*)$/)!
      const hSize = fs(theme, compact ? Math.max(13, 16 - (level[1].length - 1) * 1) : Math.max(15, 20 - (level[1].length - 1) * 2))
      blocks.push(
        <Text
          key={`h_${i}`}
          selectable={selectable}
          style={{
            fontSize: hSize,
            lineHeight: lineHeightScale ? Math.round(hSize * lineHeightScale) : undefined,
            fontWeight: "700",
            marginTop: compact ? 4 : 12,
            marginBottom: compact ? 2 : 8,
          }}
        >
          <InlineText text={level[2]} color={color} selectable={selectable} />
        </Text>
      )
      i++
      continue
    }

    if (trimmed === "---" || trimmed === "***") {
      blocks.push(<View key={`hr_${i}`} style={{ height: 1, backgroundColor: theme.colors.outlineVariant, marginVertical: compact ? 6 : 12 }} />)
      i++
      continue
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""))
        i++
      }
      blocks.push(
        <View key={`q_${i}`} style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.outlineVariant, paddingLeft: compact ? 8 : 10, marginVertical: 4 }}>
          <InlineText text={quoteLines.join("\n")} color={color} selectable={selectable} fontSize={bodyFontStyle.fontSize} lineHeight={bodyFontStyle.lineHeight} />
        </View>
      )
      continue
    }

    if (/^[-*]\s/.test(trimmed) || /^\d+[.、]\s/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && (/^[-*]\s/.test(lines[i].trim()) || /^\d+[.、]\s/.test(lines[i].trim()))) {
        items.push(
          lines[i]
            .trim()
            .replace(/^[-*]\s/, "• ")
            .replace(/^\d+[.、]\s/, "• ")
        )
        i++
      }
      blocks.push(
        <View key={`ul_${i}`} style={{ marginVertical: 2 }}>
          {items.map((item, idx) => (
            <Text key={idx} selectable={selectable} style={{ paddingLeft: 8, marginBottom: 2, ...bodyFontStyle }}>
              <InlineText text={item} color={color} selectable={selectable} />
            </Text>
          ))}
        </View>
      )
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("```") && !/^#{1,6}\s/.test(lines[i].trim()) && !matchTable(lines, i)) {
      para.push(lines[i])
      i++
    }
    if (para.length) {
      blocks.push(
        <InlineText key={`p_${i}`} text={para.join("\n")} color={color} selectable={selectable} fontSize={bodyFontStyle.fontSize} lineHeight={bodyFontStyle.lineHeight} />
      )
    }
    if (i < lines.length && lines[i].trim() === "") i++
  }
  return (
    <View>
      {blocks.map((b, idx) => (
        <View key={`b_${idx}`}>{b}</View>
      ))}
    </View>
  )
}

/**
 * Source-level splitter with exactly the same block boundary rules as MarkdownBlock's parser loop:
 * each returned unit is one block and renders identically when passed back through MarkdownBlock.
 * Paragraphs/lists/quotations are additionally chunked at MAX_UNIT_LINES so FlashList can virtualize multi-MB files;
 * fenced code and tables stay whole (their own maxHeight / horizontal scroll already bounds the cell height).
 */
const MAX_UNIT_LINES = 100

export function splitMarkdownBlocks(content: string): string[] {
  const lines = String(content ?? "").split("\n")
  const units: string[] = []
  const pushWhole = (from: number, to: number) => {
    const chunk = lines.slice(from, to).join("\n")
    if (chunk.trim() !== "") units.push(chunk)
  }
  const pushChunked = (from: number, to: number) => {
    for (let start = from; start < to; ) {
      pushWhole(start, Math.min(start + MAX_UNIT_LINES, to))
      start += MAX_UNIT_LINES
    }
  }
  let i = 0
  while (i < lines.length) {
    const start = i
    const trimmed = lines[i].trim()
    let chunked = false
    if (trimmed.startsWith("```")) {
      let j = i + 1
      while (j < lines.length && !lines[j].trim().startsWith("```")) j++
      i = Math.min(j + 1, lines.length)
    } else if (matchTable(lines, i)) {
      i = matchTable(lines, i)!.next
    } else if (/^#{1,6}\s/.test(trimmed) || trimmed === "---" || trimmed === "***") {
      i++
    } else if (trimmed.startsWith(">")) {
      chunked = true
      while (i < lines.length && lines[i].trim().startsWith(">")) i++
    } else if (/^[-*]\s/.test(trimmed) || /^\d+[.、]\s/.test(trimmed)) {
      chunked = true
      while (i < lines.length && (/^[-*]\s/.test(lines[i].trim()) || /^\d+[.、]\s/.test(lines[i].trim()))) i++
    } else if (trimmed === "") {
      i++
    } else {
      chunked = true
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !lines[i].trim().startsWith("```") &&
        !/^#{1,6}\s/.test(lines[i].trim()) &&
        !matchTable(lines, i)
      ) {
        i++
      }
    }
    if (i > start) (chunked ? pushChunked : pushWhole)(start, i)
  }
  return units
}

const styles = StyleSheet.create({
  tableWrap: {
    marginVertical: 4,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
})
