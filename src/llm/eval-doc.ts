/**
 * HTML document + runner script for `run_javascript` (pure functions, no RN dependency):
 * - The model's code runs as an async function body inside a throwaway hidden WebView document (browser DOM
 *   environment, NOT Node.js), and the return value is serialized back to JSON text.
 * - Sealed with the show_form-style CSP (default-src 'none' / connect-src 'none' - fetch/XHR/WebSocket are all dead);
 *   script-src carries 'unsafe-eval' because dynamic code execution IS the purpose of this tool - the network seal,
 *   not the script policy, is the security boundary. `alert`/`confirm`/`prompt` are replaced with no-ops: a hidden
 *   WebView must never pop native dialogs (Rule 1) and a blocked dialog would eat the 10s budget.
 * - Result serialization happens in-page: functions/DOM nodes/cycles/BigInt become descriptive placeholders, the JSON
 *   text is capped at EVAL_LIMITS.maxResultBytes (truncated flag, never an error).
 * - Like show_form, model code can also call window.ReactNativeWebView.postMessage directly - the `settled` guard is an
 *   honest boundary at the "convention + result cap" level, not a security sandbox.
 * The code literal is embedded with `<`/`>` escaped, so a `</script>` inside the code cannot break out of the script element.
 * All copy is en-US (Rule 14).
 */

export const EVAL_LIMITS = {
  /** Hard cap for the `code` parameter (UTF-8 bytes), gated before anything mounts */
  maxCodeBytes: 32757,
  /** Wall clock for one evaluation = WebView mount + execution; the FIFO queue wait is NOT counted */
  timeoutMs: 10 * 1000,
  /** Cap for the serialized result (UTF-8 bytes); larger results are truncated, never failed */
  maxResultBytes: 64 * 1024,
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "connect-src 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'"

/** JSON string literal safe to embed inside an HTML <script> element (`<`/`>` escaped so `</script>` cannot break out) */
function jsLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/**
 * The fixed runner script (not model code): compiles the code as an async function body via `new Function`
 * (CSP 'unsafe-eval'), awaits it, serializes the resolved value and posts one `done` message. ES5-level syntax
 * only - it is evaluated inside the page, not compiled by tsc.
 */
function buildRunnerScript(code: string): string {
  return `(function () {
  "use strict";
  var CODE = ${jsLiteral(code)};
  var MAX = ${EVAL_LIMITS.maxResultBytes};
  var settled = false;
  function post(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }
  function finish(msg) {
    if (settled) return;
    settled = true;
    post(msg);
  }
  function oneLine(s) {
    return String(s).split("\\r").join(" ").split("\\n").join(" ");
  }
  function errLine(e) {
    if (e && e.name) return oneLine(String(e.name) + ": " + (e.message != null ? String(e.message) : String(e)));
    return oneLine("Error: " + String(e));
  }
  window.alert = function () {};
  window.confirm = function () { return false; };
  window.prompt = function () { return null; };
  function trunc(s, n) {
    return s.length > n ? s.slice(0, n) + "..." : s;
  }
  function toPlain(v, seen, depth) {
    if (v === null) return null;
    var t = typeof v;
    if (t === "boolean" || t === "string") return v;
    if (t === "number") return isFinite(v) ? v : String(v);
    if (t === "undefined") return "undefined";
    if (t === "bigint") return String(v);
    if (t === "symbol") return String(v);
    if (t === "function") return "[Function " + (v.name || "anonymous") + "]";
    if (depth >= 8) return "[Deep]";
    if (v instanceof Error) return "[" + (v.name || "Error") + ": " + String(v.message || "") + "]";
    if (typeof Node !== "undefined" && v instanceof Node) {
      var html = "";
      try { html = v.outerHTML || String(v); } catch (e) { html = String(v.nodeName || v); }
      return trunc(String(html), 2048);
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof Map !== "undefined" && v instanceof Map) return "[Map(" + v.size + ")]";
    if (typeof Set !== "undefined" && v instanceof Set) return "[Set(" + v.size + ")]";
    if (typeof WeakMap !== "undefined" && v instanceof WeakMap) return "[WeakMap]";
    if (typeof WeakSet !== "undefined" && v instanceof WeakSet) return "[WeakSet]";
    if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) return "[ArrayBuffer(" + v.byteLength + ")]";
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
      return "[" + (v.constructor && v.constructor.name ? v.constructor.name : "TypedArray") + "(" + (v.length != null ? v.length : v.byteLength) + ")]";
    }
    if (typeof Promise !== "undefined" && v instanceof Promise) return "[Promise]";
    if (seen.indexOf(v) !== -1) return "[Circular]";
    seen.push(v);
    var out;
    if (Array.isArray(v)) {
      out = [];
      for (var i = 0; i < v.length; i++) out.push(toPlain(v[i], seen, depth + 1));
    } else {
      out = {};
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        try { out[k] = toPlain(v[k], seen, depth + 1); } catch (e) { out[k] = "[Unreadable]"; }
      }
    }
    seen.pop();
    return out;
  }
  function utf8Cut(s, max) {
    var bytes = 0;
    var i = 0;
    while (i < s.length) {
      var c = s.charCodeAt(i);
      var pair = c >= 0xd800 && c <= 0xdbff;
      var n = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      if (bytes + n > max) return i;
      bytes += n;
      i += pair ? 2 : 1;
    }
    return s.length;
  }
  function serialize(v) {
    var plain;
    try { plain = toPlain(v, [], 0); } catch (e) { plain = "[Unserializable]"; }
    var text;
    try { text = JSON.stringify(plain); } catch (e) { text = null; }
    if (typeof text !== "string") text = "null";
    var truncated = false;
    var cut = utf8Cut(text, MAX);
    if (cut < text.length) {
      text = text.slice(0, cut);
      truncated = true;
    }
    return { text: text, truncated: truncated };
  }
  try {
    var run = new Function("return (async function () {\\n" + CODE + "\\n})")();
    Promise.resolve()
      .then(run)
      .then(function (value) {
        var s = serialize(value === undefined ? null : value);
        finish({ type: "done", ok: true, result: s.text, truncated: s.truncated });
      }, function (e) {
        finish({ type: "done", ok: false, error: errLine(e) });
      });
  } catch (e) {
    finish({ type: "done", ok: false, error: errLine(e) });
  }
})()`
}

/** Turn one `code` string into a fully self-contained loadable document (CSP + runner) */
export function buildEvalDoc(code: string): string {
  return (
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    "</head><body><script>" +
    buildRunnerScript(code) +
    "</script></body></html>"
  )
}
