package io.github.luo3house.cafebeeai

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Fix (2026-11-24): when the system recreates the activity from a saved bundle (process death + relaunch,
   * or "Don't keep activities"), the saved state carries stale react-root / react-native-screens fragment
   * references and the restore crashes the app outright (闪退). The React host is always rebuilt fresh by
   * the delegate anyway, so the bundle is dead weight: hand null to super.onCreate and boot clean.
   * onSaveInstanceState is deliberately untouched - saving is harmless once nothing restores from it.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering the component.
   */
  override fun getMainComponentName(): String = "CafebeeAI"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
