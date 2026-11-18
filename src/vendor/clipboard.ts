/**
 * Clipboard wrapper (avoids depending directly on RN Permissions/EGD tricks).
 */
import { Clipboard as RNClipboard } from "react-native"

const Clipboard = {
  async setString(text: string): Promise<void> {
    // @ts-ignore react-native 0.85 Clipboard API
    const impl = RNClipboard?.setString as ((t: string) => void) | undefined
    if (impl) {
      impl(text)
      return
    }
    // @ts-ignore
    const compat = RNClipboard as { setStringAsync?: (t: string) => Promise<void> }
    await compat.setStringAsync?.(text)
  },
}

export default Clipboard