/**
 * dev-sandbox-server - online debugger for the app's private sandbox directory.
 *
 * Serves <filesDir>/${SANDBOX_ROOT} (the app data root, dotenv DATA_DIR_BASEPATH) of a DEBUGGABLE Android build over HTTP:
 *   pull:  adb exec-out run-as <pkg> tar c -C files .   -> host mirror at .debug-fs/sandbox
 *   write: adb push <hostTmp> /data/local/tmp/stage.bin, then
 *          adb shell run-as <pkg> sh -c "cat stage.bin > files/<rel>"
 *          (piping stdin through adb exec-out deadlocks adbd on macOS hosts)
 *   del:   adb shell run-as <pkg> sh -c "rm -rf files/<rel>"
 *
 * Because the app flushes memory state with debounce/forced persistNow (AGENTS
 * rules 8/28), ANY mutation force-stops the running app first so nothing edits
 * it back; restart the app from the UI to let it cold-reload from disk.
 *
 * Usage:
 *   npx tsx scripts/dev-sandbox-server.ts [--port 8788] [--pkg <id>] [--serial <sn>]
 *                                         [--lan] [--mirror <dir>]
 *   Prefer: npm run debug:fs
 *
 * Host requirement: macOS/Linux. Note writes go through a /data/local/tmp
 * staging file because exec-out stdin piping hangs on this Mac's adbd.
 * Requires exactly one reachable adb device with the debug build installed.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** Minimal KEY=VALUE dotenv reader: identity comes from the same source of truth the app builds with (Rule 32). */
function readDotEnv(file: string): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    const text = fs.readFileSync(path.resolve(process.cwd(), file), "utf8")
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  } catch {
    return {}
  }
}

const envGithub = readDotEnv(".env.github")
const DEFAULT_PKG = envGithub.APP_ID || "io.github.luo3house.cafebeeai";
const SANDBOX_ROOT = envGithub.DATA_DIR_BASEPATH || "cafebeeai";
const DEFAULT_PORT = 8788;
const PULL_MAX_BUFFER = 256 * 1024 * 1024;
const WRITE_MAX_BODY = 32 * 1024 * 1024;
const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;
const TREE_MAX_ENTRIES = 20000;

interface Options {
  pkg: string;
  port: number;
  serial: string | null;
  mirrorDir: string;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    pkg: DEFAULT_PKG,
    port: DEFAULT_PORT,
    serial: process.env.ANDROID_SERIAL ?? null,
    mirrorDir: path.resolve(process.cwd(), ".debug-fs", "sandbox"),
    host: "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === "--pkg") opts.pkg = next()
    else if (a === "--port") opts.port = Number(next())
    else if (a === "--serial") opts.serial = next()
    else if (a === "--mirror") opts.mirrorDir = path.resolve(next())
    else if (a === "--lan") opts.host = "0.0.0.0"
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: dev-sandbox-server [--pkg <appId>] [--port 8788] [--serial <adbSerial>] [--mirror <dir>] [--lan]",
      )
      process.exit(0)
    } else throw new Error(`unknown arg: ${a}`)
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    throw new Error(`bad --port: ${opts.port}`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(opts.pkg)) throw new Error(`bad --pkg: ${opts.pkg}`)
  if (opts.serial !== null && !/^[A-Za-z0-9._:-]+$/.test(opts.serial)) {
    throw new Error(`bad --serial: ${opts.serial}`)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

class SandboxError extends Error {
  detail?: string
  status: number
  constructor(message: string, status = 502, detail?: string) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

// ---------------------------------------------------------------- adb layer

function adbArgs(args: string[]): string[] {
  return opts.serial ? ["-s", opts.serial, ...args] : args
}

function adb(args: string[], input?: Buffer): { status: number; stdout: Buffer; stderr: Buffer } {
  const r = spawnSync("adb", adbArgs(args), {
    input,
    maxBuffer: PULL_MAX_BUFFER,
    timeout: 120000,
    killSignal: "SIGKILL",
  })
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOBUFS") {
      throw new SandboxError("adb output exceeded buffer limit - sandbox snapshot too large for this tool")
    }
    if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new SandboxError(`adb command timed out: adb ${args.join(" ")}`)
    }
    throw new SandboxError(`failed to spawn adb: ${r.error.message}`)
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) }
}

function stdoutText(r: { stdout: Buffer; stderr: Buffer }): string {
  return (r.stdout.length > 0 ? r.stdout.toString("utf8") : r.stderr.toString("utf8")).trim()
}

function friendlyAdbError(action: string, r: { status: number; stdout: Buffer; stderr: Buffer }): never {
  const text = stdoutText(r)
  if (/no devices|device unauthorized|more than one device/i.test(text)) {
    throw new SandboxError(`${action}: ${text}`, 502, text)
  }
  if (/not found| inaccessible|No such file|Package \S+ is unknown|run-as: /i.test(text)) {
    throw new SandboxError(
      `${action}: app package '${opts.pkg}' has no accessible data (install the debug build first?)`,
      502,
      text,
    )
  }
  throw new SandboxError(`${action}: adb exited ${r.status} - ${text || "(no output)"}`, 502, text)
}

function mustOk(action: string, r: { status: number; stdout: Buffer; stderr: Buffer }): Buffer {
  const softFail = /^error:/.test(stdoutText(r)) && r.status === 0
  if (r.status !== 0 || softFail) friendlyAdbError(action, r)
  return r.stdout
}

function runAsShell(innerShCmd: string): { status: number; stdout: Buffer; stderr: Buffer } {
  // innerShCmd only ever embeds validated rel paths (charset [A-Za-z0-9._/-]),
  // quoted with single quotes for the *device* shell; no injection surface.
  return adb(["shell", `run-as ${opts.pkg} sh -c ${JSON.stringify(innerShCmd)}`])
}

function listDevices(): { serial: string; state: string }[] {
  const r = adb(["devices"])
  if (r.status !== 0) friendlyAdbError("adb devices", r)
  const out: { serial: string; state: string }[] = []
  for (const line of r.stdout.toString("utf8").split("\n").slice(1)) {
    const m = line.trim().split(/\s+/)
    if (m.length >= 2 && m[1] !== "offline") out.push({ serial: m[0], state: m[1] })
  }
  return out
}

function appPid(): string | null {
  const r = adb(["shell", `pidof ${opts.pkg}`])
  if (r.status !== 0) return null
  const m = r.stdout.toString("utf8").trim().match(/^\d+/)
  return m ? m[0] : null
}

function startApp(): void {
  const r = adb(["shell", `am start -n ${opts.pkg}/.MainActivity`])
  if (r.status !== 0 || /^Error/i.test(stdoutText(r))) friendlyAdbError("am start", r)
}

function stopApp(): void {
  mustOk("am force-stop", adb(["shell", `am force-stop ${opts.pkg}`]))
}

// ------------------------------------------------------------ rel path layer

export interface TreeNode {
  rel: string
  dir: boolean
  size: number
  mtime: number
}

function validateRel(rel: string, forWrite: boolean): string[] {
  const parts = rel.split("/")
  if (parts.length < 1 || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === "." || p === "..")) {
    throw new SandboxError(`invalid sandbox path: ${JSON.stringify(rel)}`, 400)
  }
  if (parts[0] !== SANDBOX_ROOT) {
    throw new SandboxError(`only paths under ${SANDBOX_ROOT}/ may be ${forWrite ? "modified" : "accessed"} here`, 403)
  }
  if (forWrite && parts.length === 1) {
    throw new SandboxError(`refusing to touch the ${SANDBOX_ROOT} root directory`, 403)
  }
  return parts
}

function mirrorPath(relParts: string[]): string {
  const abs = path.resolve(opts.mirrorDir, ...relParts)
  const root = path.resolve(opts.mirrorDir)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new SandboxError(`path escapes mirror root: ${relParts.join("/")}`, 403)
  }
  return abs
}

// --------------------------------------------------------------- mirror ops

let lastPullAt: number | null = null

// pull: app files/ dir must exist, so a fresh install without any project yet
// is staged with the canonical data root first (files/${SANDBOX_ROOT} is the
// documented layout and what read/write paths are relative to).
function pullMirror(): { nodes: TreeNode[]; bytes: number } {
  const r = adb(["exec-out", `run-as ${opts.pkg} tar c -C files .`])
  // modern Android may route run-as failures into exec-out's stdout with status 0;
  // first install (no files/ dir yet) -> seed an empty data root and retry once
  if (/No such file or directory/.test(stdoutText(r))) {
    mustOk("seed data root", runAsShell(`mkdir -p files/${SANDBOX_ROOT}`))
  } else if (r.status !== 0 || r.stdout.length < 512) {
    friendlyAdbError("snapshot pull", r)
  }
  const r2 = r.status === 0 && r.stdout.length >= 512 ? r : adb(["exec-out", `run-as ${opts.pkg} tar c -C files .`])
  if (r2.status !== 0 || r2.stdout.length < 512) friendlyAdbError("snapshot pull", r2)
  fs.rmSync(opts.mirrorDir, { recursive: true, force: true })
  fs.mkdirSync(opts.mirrorDir, { recursive: true })
  const x = spawnSync("tar", ["-x", "-C", opts.mirrorDir, "-f", "-"], {
    input: r2.stdout,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (x.status !== 0) {
    throw new SandboxError(
      "pulled data is not a valid tar stream",
      502,
      x.stderr.toString("utf8") + "\n-- device said --\n" + r2.stdout.subarray(0, 400).toString("utf8"),
    )
  }
  lastPullAt = Date.now()
  return { nodes: walkMirror(), bytes: r2.stdout.length }
}

function walkMirror(): TreeNode[] {
  const nodes: TreeNode[] = []
  const stack: string[] = [opts.mirrorDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (nodes.length >= TREE_MAX_ENTRIES) throw new SandboxError("sandbox mirror has too many entries", 507)
      const abs = path.join(dir, e.name)
      const rel = path.relative(opts.mirrorDir, abs).split(path.sep).join("/")
      let size = 0
      let mtime = 0
      if (e.isDirectory()) stack.push(abs)
      else {
        try {
          const st = fs.statSync(abs)
          size = st.size
          mtime = st.mtimeMs
        } catch {
          /* file vanished mid-walk */
        }
      }
      nodes.push({ rel, dir: e.isDirectory(), size, mtime })
    }
  }
  nodes.sort((a, b) => (a.dir === b.dir ? a.rel.localeCompare(b.rel) : a.dir ? -1 : 1))
  return nodes
}

function ensureFreshMirror(): void {
  if (!fs.existsSync(opts.mirrorDir)) pullMirror()
}

// write / delete: the app must not be alive, otherwise its debounced persist
// (registry flush, config pendingDebounce) overwrites the external edit.
function editStep(fn: () => void): { wasRunning: boolean } {
  const pidBefore = appPid()
  if (pidBefore) stopApp()
  fn()
  pullMirror()
  return { wasRunning: pidBefore !== null }
}

let stageSeq = 0

function writeRemoteFile(rel: string, data: Buffer): { wasRunning: boolean } {
  const parts = validateRel(rel, true)
  const remote = `files/${parts.join("/")}`
  const parent = parts.slice(0, -1).join("/")
  const stageRemote = `/data/local/tmp/${SANDBOX_ROOT}-debug-stage.${process.pid}.${stageSeq++}.bin`
  const stageHost = path.join(os.tmpdir(), `${SANDBOX_ROOT}-debug-stage.${process.pid}.${stageSeq}.bin`)
  try {
    fs.writeFileSync(stageHost, data)
    const { wasRunning } = editStep(() => {
      mustOk(`adb push ${stageHost}`, adb(["push", stageHost, stageRemote]))
      const inner: string[] = []
      if (parent.length > 0) inner.push(`mkdir -p 'files/${parent}'`)
      inner.push(`cat '${stageRemote}' > '${remote}'`)
      // match the 0600 the app itself gives its sandbox files (stage is 0666 by default)
      inner.push(`chmod 600 '${remote}'`)
      mustOk(`stage copy into ${rel}`, runAsShell(inner.join(" && ")))
    })
    return { wasRunning }
  } finally {
    try { fs.unlinkSync(stageHost) } catch { /* best effort */ }
    adb(["shell", `rm -f ${stageRemote}`])  // shell owns the stage file; ignore result
  }
}

function deleteRemotePath(rel: string): { wasRunning: boolean } {
  const parts = validateRel(rel, true)
  const { wasRunning } = editStep(() => {
    mustOk(`rm -r files/${rel}`, runAsShell(`rm -r -f 'files/${parts.join("/")}'`))
  })
  return { wasRunning }
}

// ------------------------------------------------------------------ http api

const MIME: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".xml": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".db": "application/octet-stream",
  ".zip": "application/zip",
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", c => {
      size += (c as Buffer).length
      if (size > WRITE_MAX_BODY) {
        reject(new SandboxError(`request body larger than ${WRITE_MAX_BODY} bytes`, 413))
        req.destroy()
        return
      }
      chunks.push(c as Buffer)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const b = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length })
  res.end(b)
}

class HttpFail extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// UI html is re-read per request so the page can be edited without restart.
function uiHtmlPath(): string {
  const dir = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(new URL(import.meta.url).pathname)
  return path.join(dir, "dev-sandbox-ui.html")
}

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const route = `${req.method} ${url.pathname}`
  switch (route) {
    case "GET /api/status": {
      sendJson(res, 200, {
        pkg: opts.pkg,
        port: opts.port,
        devices: listDevices(),
        pid: appPid(),
        lastPullAt,
        mirrorDir: opts.mirrorDir,
        mirrorExists: fs.existsSync(opts.mirrorDir),
      })
      return
    }
    case "POST /api/pull": {
      const { nodes, bytes } = pullMirror()
      sendJson(res, 200, { ok: true, files: nodes.length, tarBytes: bytes, lastPullAt })
      return
    }
    case "POST /api/app/start": {
      startApp()
      sendJson(res, 200, { ok: true, pid: appPid() })
      return
    }
    case "POST /api/app/stop": {
      stopApp()
      sendJson(res, 200, { ok: true, pid: null })
      return
    }
    case "GET /api/tree": {
      if (url.searchParams.get("refresh") === "1") pullMirror()
      else ensureFreshMirror()
      sendJson(res, 200, { nodes: walkMirror(), lastPullAt, pkg: opts.pkg, pid: appPid() })
      return
    }
    case "GET /api/file": {
      const rel = url.searchParams.get("rel")
      if (!rel) throw new HttpFail(400, "missing ?rel=")
      const parts = validateRel(rel, false)
      ensureFreshMirror()
      const abs = mirrorPath(parts)
      if (!fs.existsSync(abs)) throw new HttpFail(404, `not found in mirror: ${rel} (try Pull)`)
      const st = fs.statSync(abs)
      if (st.isDirectory()) throw new HttpFail(400, `${rel} is a directory`)
      const buf = fs.readFileSync(abs)
      const meta = { rel, size: st.size, mtime: st.mtimeMs }
      if (buf.length > TEXT_PREVIEW_MAX) {
        sendJson(res, 200, { ...meta, binary: false, tooLarge: true })
        return
      }
      if (looksBinary(buf)) {
        sendJson(res, 200, { ...meta, binary: true })
        return
      }
      sendJson(res, 200, { ...meta, binary: false, tooLarge: false, content: buf.toString("utf8") })
      return
    }
    case "GET /raw": {
      const rel = url.searchParams.get("rel")
      if (!rel) throw new HttpFail(400, "missing ?rel=")
      const parts = validateRel(rel, false)
      ensureFreshMirror()
      const abs = mirrorPath(parts)
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new HttpFail(404, `not found: ${rel}`)
      const buf = fs.readFileSync(abs)
      res.writeHead(200, {
        "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
        "content-length": buf.length,
        "content-disposition": `attachment; filename="${path.basename(abs)}"`,
      })
      res.end(buf)
      return
    }
    default:
      break
  }

  if (req.method === "PUT" && url.pathname === "/api/file") {
    const rel = url.searchParams.get("rel")
    if (!rel) throw new HttpFail(400, "missing ?rel=")
    const restart = url.searchParams.get("restart") === "1"
    const data = BODY_CACHE.get(req)
    if (data === undefined) throw new HttpFail(400, "empty body")
    const { wasRunning } = writeRemoteFile(rel, data)
    if (restart) startApp()
    sendJson(res, 200, { ok: true, rel, bytes: data.length, wasRunning, restarted: restart })
    return
  }
  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const rel = url.searchParams.get("rel")
    if (!rel) throw new HttpFail(400, "missing ?rel=")
    const restart = url.searchParams.get("restart") === "1"
    const { wasRunning } = deleteRemotePath(rel)
    if (restart) startApp()
    sendJson(res, 200, { ok: true, rel, wasRunning, restarted: restart })
    return
  }
  throw new HttpFail(404, `no such route: ${route}`)
}

// spawnSync work happens after the async body read completed, so a simple
// WeakMap hands the parsed body to the synchronous route handler.
const BODY_CACHE = new WeakMap<http.IncomingMessage, Buffer>()

const server = http.createServer((req, res) => {
  const done = (fn: () => void) => {
    try {
      fn()
    } catch (e) {
      const err = e as SandboxError | HttpFail | Error
      const status = "status" in err && typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500
      sendJson(res, status >= 400 && status <= 599 ? status : 500, {
        error: err.message,
        ...((err as SandboxError).detail ? { detail: (err as SandboxError).detail } : {}),
      })
    }
  }
  if (req.method === "GET" && ((req.url ?? "") === "/" || (req.url ?? "").startsWith("/?"))) {
    try {
      const text = fs
        .readFileSync(uiHtmlPath(), "utf8")
        .replaceAll("__SANDBOX_ROOT__", SANDBOX_ROOT)
        .replaceAll("__APP_NAME__", envGithub.APP_NAME || "CafebeeAI")
      const buf = Buffer.from(text, "utf8")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": buf.length })
      res.end(buf)
    } catch (e) {
      done(() => {
        throw e
      })
    }
    return
  }
  const wantBody = req.method === "PUT"
  if (!wantBody) {
    done(() => handleApi(req, res, new URL(req.url ?? "/", "http://localhost")))
    return
  }
  readBody(req)
    .then(buf => {
      BODY_CACHE.set(req, buf)
      done(() => handleApi(req, res, new URL(req.url ?? "/", "http://localhost")))
    })
    .catch(err => done(() => { throw err }))
})

// --------------------------------------------------------------------- boot

const startup = pullMirror()
console.log(`[dev-sandbox] package    : ${opts.pkg}`)
console.log(`[dev-sandbox] mirror     : ${opts.mirrorDir}`)
console.log(`[dev-sandbox] snapshot   : ${startup.nodes.length} entries, ${startup.bytes} bytes tar`)
console.log(`[dev-sandbox] app        : ${appPid() ? "RUNNING (writes will force-stop it)" : "stopped"}`)
server.listen(opts.port, opts.host, () => {
  console.log(`[dev-sandbox] serving    : http://${opts.host === "0.0.0.0" ? "<host-ip>" : opts.host}:${opts.port}`)
})
