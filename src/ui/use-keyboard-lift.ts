/**
 * Android 15+ (API 35) forces edge-to-edge: adjustResize no longer shrinks the window, so keyboard height must be padded from JS.
 * All other platforms/versions always return 0 (still using native adjustResize / iOS KeyboardAvoidingView).
 * Convention matches ChatScreen's original implementation, extracted as a hook for every page/dialog with an input field to reuse.
 */
import { useEffect, useState } from "react"
import { Keyboard, Platform, type StyleProp, type ViewStyle } from "react-native"

export function useKeyboardLift(onShow?: () => void): number {
  const [lift, setLift] = useState(0)

  useEffect(() => {
    if (Platform.OS !== "android" || (Platform.Version as number) < 35) return
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setLift(e.endCoordinates.height)
      onShow?.()
    })
    const hide = Keyboard.addListener("keyboardDidHide", () => setLift(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [onShow])

  return lift
}

/** Compact width for centered Dialogs (taming the default 560's horizontal whitespace), shifted up by half the keyboard height when the keyboard shows */
export function dialogLiftStyle(lift: number): StyleProp<ViewStyle> {
  return lift > 0 ? { maxWidth: 340, transform: [{ translateY: -lift / 2 }] } : { maxWidth: 340 }
}
