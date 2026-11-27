/**
 * Hidden WebView runners for `run_javascript` (evalflow): one throwaway WebView per active evaluation, mounted
 * zero-size (1x1 + opacity 0 - a display:none / hidden WebView pauses JS on iOS) and unmounted the moment the run
 * settles (result / error / timeout / abort), which destroys the renderer and anything the code leaked with it.
 * One-shot per call, never reused. Mounted inside GlobalHosts so background turns can evaluate while any screen is
 * on top. The 10s wall clock (EVAL_LIMITS.timeoutMs) is armed at mount = slot acquisition; the queue wait is not
 * counted. WebView hardening mirrors FormFullScreen (navigation blocked, no file access, no multi-window).
 */
import React, { useCallback, useEffect, useMemo, useRef } from "react"
import { StyleSheet, View } from "react-native"
import { WebView } from "react-native-webview"
import { useSnapshot } from "valtio"
import { buildEvalDoc, EVAL_LIMITS } from "../../llm/eval-doc"
import { evalflow, finishEval, getEvalJob, EVAL_TIMEOUT_ERROR, type EvalOutcome } from "../../state/evalflow"

export function EvalHost() {
  const snap = useSnapshot(evalflow)
  return (
    <View pointerEvents="none" style={styles.host}>
      {snap.activeIds.map((id) => {
        const job = getEvalJob(id)
        return job ? <EvalRunner key={id} id={id} code={job.code} /> : null
      })}
    </View>
  )
}

function EvalRunner({ id, code }: { id: string; code: string }) {
  const html = useMemo(() => buildEvalDoc(code), [code])
  const settledRef = useRef(false)

  const settle = useCallback(
    (outcome: EvalOutcome) => {
      if (settledRef.current) return
      settledRef.current = true
      finishEval(id, outcome)
    },
    [id]
  )

  // The whole budget is one wall clock: mount + execution. On fire the job settles and this component unmounts,
  // which destroys the WebView (the only way to stop a `while(true)` inside it).
  useEffect(() => {
    const timer = setTimeout(() => settle({ ok: false, error: EVAL_TIMEOUT_ERROR }), EVAL_LIMITS.timeoutMs)
    return () => clearTimeout(timer)
  }, [settle])

  const onMessage = useCallback(
    (event: any) => {
      let msg: any
      try {
        msg = JSON.parse(String(event?.nativeEvent?.data ?? ""))
      } catch {
        return
      }
      if (msg?.type !== "done") return
      if (msg.ok === true) {
        const result = String(msg.result ?? "null")
        settle(msg.truncated === true ? { ok: true, result, truncated: true } : { ok: true, result })
      } else {
        settle({ ok: false, error: String(msg.error ?? "Evaluation failed: the sandbox returned no result") })
      }
    },
    [settle]
  )

  const onError = useCallback(() => settle({ ok: false, error: "Evaluation failed: the sandbox failed to load" }), [settle])

  const onShouldStartLoadWithRequest = useCallback((req: any) => {
    const url = String(req?.url ?? "")
    return url.startsWith("about:") || url.startsWith("data:")
  }, [])

  return (
    <WebView<{}>
      source={{ html }}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onMessage={onMessage}
      onError={onError}
      javaScriptEnabled
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      style={styles.hidden}
    />
  )
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    overflow: "hidden",
  },
  hidden: {
    width: 1,
    height: 1,
  },
})
