/**
 * Chat bottom input bar: the TextInput only handles typing; the left "+" panel toggle (shows a close icon when expanded)
 * and the right send/stop button are separate Views.
 * The bottom safe-area inset is handled by the parent container (ChatScreen's inputWrap) so the "+" panel can be inserted below the input bar.
 * The field does not use Paper TextInput: outlined mode hardcodes minHeight 56 in its internal labelContainer (TextInputOutlined.tsx, kept even without a label),
 * which adds extra vertical whitespace beyond what contentStyle defines and cannot be overridden via props (passing height locks the multiline auto-grow).
 * Instead we replicate the MD3 filled look with a native TextInput: surfaceVariant fill + 4px corner radius, no bottom indicator line (no underline on focus).
 * Auto-grow uses onContentSizeChange to measure content height then explicitly drives clamp(single-line height, 120): never set flex:1/flexGrow on a multiline TextInput —
 * flexBasis:0 makes the outer container start from 0 and the EditText stops growing with content, so the field would not gain height on line wrap.
 * Android's onContentSizeChange is unreliable for PROGRAMMATIC value clears (send clears the draft via the controlled `value`):
 * ReactEditText.maybeSetText's empty path runs TextView.setText -> checkForRelayout -> nullLayouts, and the size watcher then
 * measures the stale JS-pinned view height and dedupes it away, so the shrink never reaches JS. Therefore the empty state (and
 * a draftKey switch, which swaps the draft programmatically too) must reset contentHeight here instead of trusting the event.
 * The draft is subscribed HERE (draftStore slice, useSnapshot with {sync:true}): keystrokes re-render only this
 * component, never ChatScreen; sync notification avoids the same-tick stale-snapshot inconsistency valtio's
 * microtask-batched default notify can produce on fast typing. Stream flushes never touch draftStore, so
 * typing stays responsive while a reply is generating.
 */
import React from "react"
import { StyleSheet, TextInput, View } from "react-native"
import { IconButton, useTheme } from "react-native-paper"
import { useSnapshot } from "valtio"
import { fs } from "../../../app/app.ui.theme"
import { draftStore } from "../../../state/chat"

type ChatInputBarProps = {
  /** sessionKey(projectId, convId) of the bound session (identity key into draftStore) */
  draftKey: string
  onChangeText: (text: string) => void
  streaming: boolean
  /** Waiting on a human (this session's pending write confirmation / form to fill): the button is always send —
   *  with text, send = preempt the wait and start a new turn; with empty input, tapping does nothing;
   *  while waiting there is nothing running to stop — the stop entry only appears during network streaming/tool execution (abort = reject the card or type-and-send preempt) */
  humanWait: boolean
  moreVisible: boolean
  onToggleMore: () => void
  onSend: (text: string) => void
  onStop: () => void
}

const INPUT_LINE_HEIGHT = 21
const INPUT_MAX_HEIGHT = 120

export function ChatInputBar({ draftKey, onChangeText, streaming, humanWait, moreVisible, onToggleMore, onSend, onStop }: ChatInputBarProps) {
  const theme = useTheme()
  const draftSnap = useSnapshot(draftStore, { sync: true })
  const value = draftSnap[draftKey] ?? ""
  const [contentHeight, setContentHeight] = React.useState(0)
  // JS-side collapse fallback: after a programmatic clear (send) or a draft swap (conversation switch) Android's
  // onContentSizeChange may not deliver a smaller measurement (see header), so drop the pinned height back to natural
  React.useEffect(() => {
    if (value === "") setContentHeight(0)
  }, [value])
  React.useEffect(() => {
    setContentHeight(0)
  }, [draftKey])
  const showStop = streaming && !humanWait
  const inputFontSize = fs(theme, 15)
  const inputLineHeight = fs(theme, INPUT_LINE_HEIGHT)
  const inputMinHeight = inputLineHeight + 8 * 2

  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <IconButton icon={moreVisible ? "close" : "plus"} size={22} style={styles.icon} onPress={onToggleMore} />
      </View>
      <View style={[styles.field, { backgroundColor: theme.colors.surfaceVariant }]}>
        <TextInput
          multiline
          value={value}
          onChangeText={onChangeText}
          placeholder="Type a message…"
          placeholderTextColor={theme.colors.onSurfaceVariant}
          style={[styles.input, { fontSize: inputFontSize, lineHeight: inputLineHeight, color: theme.colors.onSurface }, contentHeight > 0 ? { height: Math.min(INPUT_MAX_HEIGHT, Math.max(inputMinHeight, contentHeight)) } : undefined]}
          onContentSizeChange={(e) => setContentHeight(e.nativeEvent.contentSize.height)}
          selectionColor={theme.colors.primary}
          cursorColor={theme.colors.primary}
          underlineColorAndroid="transparent"
          maxFontSizeMultiplier={1.5}
        />
      </View>
      <View style={styles.side}>
        <IconButton icon={showStop ? "stop" : "send"} size={22} style={styles.icon} onPress={showStop ? onStop : () => onSend(value)} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 6,
  },
  side: { justifyContent: "center" },
  icon: { margin: 0 },
  field: {
    flex: 1,
    borderRadius: 4,
    overflow: "hidden",
  },
  input: {
    fontSize: 15,
    lineHeight: INPUT_LINE_HEIGHT,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    textAlignVertical: "top",
    includeFontPadding: false,
    backgroundColor: "transparent",
    overflow: "scroll",
  },
})
