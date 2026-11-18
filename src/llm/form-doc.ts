/**
 * HTML document processing for show_form (pure functions, no RN dependency):
 * - Preprocessing: wrap fragments / insert CSP (default-src 'none', sealing off external links, CDN and the network) + theme base styles;
 * - Injected script: submit interception and serialization (isTrusted) / file-picking guard / snapshot and restore;
 * - No-JS fallback for app:///submit: parse the GET query.
 * User-visible copy inside the injected script (the note bar) is en-US, as everywhere in the project; error text returned to the model is also en-US, at the formflow/tools layer.
 */

export const FORM_LIMITS = {
  /** Cap for the inline `html` parameter */
  maxInlineHtmlBytes: 128 * 1024,
  /** Cap for the `html_path` file */
  maxHtmlFileBytes: 2 * 1024 * 1024,
  /** Cap for the submit-result JSON (prevents flooding the chat history and tokens) */
  maxResultBytes: 64 * 1024,
  /** Per-file cap for in-page file picking (the injected guard clears the selection outright when exceeded) */
  maxPickFileBytes: 50 * 1024 * 1024,
}

export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

export function hasFileInputTag(html: string): boolean {
  return /<input\b[^>]*\btype\s*=\s*["']?file/i.test(html)
}

export interface FormDocTheme {
  dark: boolean
  background: string
  onSurface: string
  inverseSurface: string
  inverseOnSurface: string
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "media-src data: blob:; font-src data:; connect-src 'none'; form-action app:; base-uri 'none'; " +
  "frame-src 'none'; object-src 'none'"

function baseStyle(theme: FormDocTheme): string {
  return (
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style data-form="base">` +
    `:root{color-scheme:${theme.dark ? "dark" : "light"}}` +
    `html,body{margin:0;padding:0;background:${theme.background};color:${theme.onSurface};` +
    `font-family:system-ui,-apple-system,Roboto,"Helvetica Neue",sans-serif;` +
    `font-size:15px;line-height:1.5;word-break:break-word}` +
    `input,textarea,select,button{font:inherit;color:inherit}` +
    `textarea{white-space:pre-wrap}` +
    `</style>`
  )
}

/** Turn raw HTML (a fragment or a full document) into a loadable document: inject CSP/theme base styles, wrap fragments in a shell */
export function prepareFormDoc(rawHtml: string, theme: FormDocTheme): string {
  const inject = baseStyle(theme)
  if (!/<html[\s>]/i.test(rawHtml)) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${inject}</head><body>${rawHtml}</body></html>`
  }
  const headOpen = /<head[^>]*>/i.exec(rawHtml)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return rawHtml.slice(0, at) + inject + rawHtml.slice(at)
  }
  const htmlOpen = /<html[^>]*>/i.exec(rawHtml)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return rawHtml.slice(0, at) + `<head>${inject}</head>` + rawHtml.slice(at)
  }
  return inject + rawHtml
}

/** JSON safe to embed as a JS literal (U+2028/2029 are still line terminators in some JS parsers) */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

export interface InjectedScriptOpts {
  hasFileInput: boolean
  /** Field snapshot saved when the form was collapsed; always null for forms with a file input (reopen = fresh form) */
  restore: unknown
  pickLimitBytes: number
  noteBackground: string
  noteColor: string
  /** Window-property prefix for the bridge functions (dotenv `TOOL_CALL_FORM_BRIDGE_PREFIX`); this module stays brand-free */
  bridgePrefix: string
}

/**
 * The injected script (fixed, not model code): runs once at document-end.
 * Note: model JS can also call window.ReactNativeWebView.postMessage directly — the isTrusted interception is
 * an honest boundary at the "convention + 64KB result cap" level, not a security sandbox (see the design final).
 */
export function buildInjectedScript(opts: InjectedScriptOpts): string {
  return `(function () {
  if (window.${opts.bridgePrefix}_form__) return;
  window.${opts.bridgePrefix}_form__ = true;
  var PICK_LIMIT = ${opts.pickLimitBytes};
  function post(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }
  function showNote(text) {
    var n = document.getElementById("${opts.bridgePrefix}_note");
    if (!n) {
      n = document.createElement("div");
      n.id = "${opts.bridgePrefix}_note";
      n.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;" +
        "padding:10px 14px;font-size:13px;line-height:1.4;background:${opts.noteBackground};color:${opts.noteColor};";
      document.body.appendChild(n);
      setTimeout(function () { if (n && n.parentNode) n.parentNode.removeChild(n); }, 4000);
    }
    n.textContent = text;
  }
  function typeOf(el) {
    return ((el.type || "") || el.tagName.toLowerCase()).toLowerCase();
  }
  function eachControl(fn) {
    var list = document.querySelectorAll("input[name], textarea[name], select[name]");
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }
  function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function pushField(fields, name, value) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      var cur = fields[name];
      if (isArray(cur)) {
        if (isArray(value)) { for (var i = 0; i < value.length; i++) cur.push(value[i]); }
        else cur.push(value);
      } else {
        fields[name] = [cur].concat(isArray(value) ? value : [value]);
      }
    } else {
      fields[name] = isArray(value) ? value.slice() : value;
    }
  }
  function collectFields() {
    var fields = {};
    eachControl(function (el) {
      if (el.disabled) return;
      var name = el.getAttribute("name");
      var t = typeOf(el);
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return;
      if (t === "file") {
        var metas = [];
        var fs = el.files || [];
        for (var i = 0; i < fs.length; i++) metas.push({ name: fs[i].name, size: fs[i].size, type: fs[i].type || "" });
        if (metas.length) pushField(fields, name, metas);
        return;
      }
      if (t === "checkbox") {
        if (el.checked) pushField(fields, name, el.hasAttribute("value") ? el.value : true);
        return;
      }
      if (t === "radio") {
        if (el.checked) pushField(fields, name, el.value);
        return;
      }
      if (el.tagName.toLowerCase() === "select" && el.multiple) {
        for (var j = 0; j < el.options.length; j++) {
          if (el.options[j].selected) pushField(fields, name, el.options[j].value);
        }
        return;
      }
      pushField(fields, name, el.value);
    });
    return fields;
  }
  function submitForm(submitter) {
    post({ type: "submit", payload: { fields: collectFields(), submitter: submitter || "" } });
  }
  document.addEventListener("submit", function (e) {
    if (!e.isTrusted) return;
    if (e.preventDefault) e.preventDefault();
    var form = e.target;
    try { if (form && form.reportValidity && !form.reportValidity()) return; } catch (err) {}
    var label = "";
    var sub = e.submitter;
    if (sub) label = sub.getAttribute("value") || (sub.textContent || "").replace(/^\\s+|\\s+$/g, "");
    submitForm(label);
  }, true);
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || el.tagName.toLowerCase() !== "input" || typeOf(el) !== "file") return;
    var fs = el.files || [];
    var bad = false;
    for (var i = 0; i < fs.length; i++) if (fs[i].size > PICK_LIMIT) bad = true;
    if (bad) {
      try { el.value = ""; } catch (err) {}
      showNote("Selected file exceeds 50 MB — ignored");
    }
  }, true);
  window.${opts.bridgePrefix}_snapshot = function () {
    var snap = [];
    eachControl(function (el) {
      var t = typeOf(el);
      if (t === "file") return;
      var rec = { k: el.getAttribute("name") + "\\u0000" + t, v: null, c: false };
      if (t === "checkbox" || t === "radio") {
        rec.c = !!el.checked;
        rec.v = el.hasAttribute("value") ? el.value : null;
      } else if (el.tagName.toLowerCase() === "select" && el.multiple) {
        var vals = [];
        for (var j = 0; j < el.options.length; j++) if (el.options[j].selected) vals.push(el.options[j].value);
        rec.v = vals;
      } else {
        rec.v = el.value;
      }
      snap.push(rec);
    });
    post({ type: "snapshot", payload: snap });
  };
  window.${opts.bridgePrefix}_restore = function (snap) {
    if (!isArray(snap) || !snap.length) return;
    var counters = {};
    eachControl(function (el) {
      var t = typeOf(el);
      if (t === "file") return;
      var key = el.getAttribute("name") + "\\u0000" + t;
      var idx = counters[key] || 0;
      counters[key] = idx + 1;
      var entry = null;
      var seen = 0;
      for (var j = 0; j < snap.length; j++) {
        if (snap[j].k !== key) continue;
        if (seen === idx) { entry = snap[j]; break; }
        seen++;
      }
      if (!entry) return;
      try {
        if (t === "checkbox" || t === "radio") el.checked = !!entry.c;
        else if (el.tagName.toLowerCase() === "select" && el.multiple) {
          var vals = isArray(entry.v) ? entry.v : [];
          for (var o = 0; o < el.options.length; o++) {
            el.options[o].selected = vals.indexOf(el.options[o].value) !== -1;
          }
        } else el.value = entry.v == null ? "" : entry.v;
      } catch (err) {}
    });
  };
  window.${opts.bridgePrefix}_restore(${jsLiteral(opts.restore)});
  true;
})()`
}

/**
 * Fallback parsing for no-JS form GET submissions `app:///submit?...` (called from the navigation-interception layer).
 * Every query param goes into fields (same-name params aggregate into arrays); the `submitter` param is extracted separately.
 */
export function parseAppSubmitUrl(url: string): { fields: Record<string, unknown>; submitter: string } | null {
  if (!/^app:(?:\/\/)*\/?submit/i.test(url)) return null
  const qIdx = url.indexOf("?")
  const query = qIdx >= 0 ? url.slice(qIdx + 1) : ""
  const fields: Record<string, unknown> = {}
  let submitter = ""
  for (const pair of query.split("&")) {
    if (!pair) continue
    const eq = pair.indexOf("=")
    const rawK = eq >= 0 ? pair.slice(0, eq) : pair
    const rawV = eq >= 0 ? pair.slice(eq + 1) : ""
    let k = rawK
    let v = rawV
    try {
      k = decodeURIComponent(rawK.replace(/\+/g, " "))
      v = decodeURIComponent(rawV.replace(/\+/g, " "))
    } catch {}
    if (!k) continue
    if (k === "submitter") {
      submitter = v
      continue
    }
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      const cur = fields[k]
      if (Array.isArray(cur)) cur.push(v)
      else fields[k] = [cur, v]
    } else {
      fields[k] = v
    }
  }
  return { fields, submitter }
}
