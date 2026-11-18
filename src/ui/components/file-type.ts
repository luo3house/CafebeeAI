/**
 * File type hints (UI-layer helper).
 */
export function fileTypeDescription(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    md: "Markdown", txt: "Text", json: "JSON", yaml: "YAML", yml: "YAML",
    html: "HTML", css: "CSS", js: "JavaScript", ts: "TypeScript", py: "Python",
    javaclass: "Code", go: "Go", rs: "Rust", c: "C", cpp: "C++", sh: "Shell",
    sql: "SQL", xml: "XML", toml: "TOML", csv: "CSV",
  }
  return map[ext] ?? (ext ? `${ext.toUpperCase()} file` : "file")
}
