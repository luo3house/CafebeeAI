package com.cafebeeai.appnotify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject

/**
 * Local completion notifications + battery-optimization helpers (one small TurboModule, no third-party deps).
 * - One notification per conversation (id = the conversation id) so a later event replaces the earlier one;
 * - Tapping a notification launches/reuses MainActivity (singleTask) with project/conv extras; MainActivity
 *   forwards them through [captureTap], which either emits a warm JS event or stores them for cold start;
 * - POST_NOTIFICATIONS is requested JS-side (RN PermissionsAndroid); every post re-checks
 *   NotificationManager.areNotificationsEnabled() and silently no-ops when the app is not allowed.
 */
class AppNotifyModule(reactContext: ReactApplicationContext) : NativeAppNotifySpec(reactContext) {

    init {
        instance = this
    }

    override fun addListener(eventType: String?) {
        // Required by NativeEventEmitter; delivery uses DeviceEventManagerModule directly.
    }

    override fun removeListeners(count: Double) {}

    override fun postNotification(payload: String?, promise: Promise?) {
        try {
            val json = JSONObject(payload ?: "")
            val key = json.optString("id")
            val title = json.optString("title")
            val body = json.optString("body")
            val projectId = json.optString("projectId")
            val convId = json.optString("convId")
            val ctx = reactApplicationContext
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (!nm.areNotificationsEnabled()) {
                promise?.resolve(false)
                return
            }
            ensureChannel(nm)

            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
                ?: Intent(Intent.ACTION_MAIN).setPackage(ctx.packageName)
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            launch.putExtra(EXTRA_PROJECT_ID, projectId)
            launch.putExtra(EXTRA_CONV_ID, convId)

            val requestCode = key.hashCode()
            val pendingIntent = PendingIntent.getActivity(
                ctx,
                requestCode,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(ctx, CHANNEL_ID)
            } else {
                Notification.Builder(ctx).setPriority(Notification.PRIORITY_DEFAULT)
            }
            val notification = builder
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build()
            nm.notify(requestCode, notification)
            promise?.resolve(true)
        } catch (t: Throwable) {
            Log.e(TAG, "postNotification failed", t)
            promise?.reject("app_notify_failed", t.message ?: "postNotification failed")
        }
    }

    override fun cancelNotification(id: String?, promise: Promise?) {
        try {
            val ctx = reactApplicationContext
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel((id ?: "").hashCode())
            promise?.resolve(true)
        } catch (t: Throwable) {
            promise?.resolve(false)
        }
    }

    override fun cancelAll(promise: Promise?) {
        try {
            val ctx = reactApplicationContext
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancelAll()
            promise?.resolve(true)
        } catch (t: Throwable) {
            promise?.resolve(false)
        }
    }

    override fun areNotificationsEnabled(promise: Promise?) {
        try {
            val ctx = reactApplicationContext
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            promise?.resolve(nm.areNotificationsEnabled())
        } catch (t: Throwable) {
            promise?.resolve(false)
        }
    }

    override fun isIgnoringBatteryOptimizations(promise: Promise?) {
        try {
            val ctx = reactApplicationContext
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            promise?.resolve(pm.isIgnoringBatteryOptimizations(ctx.packageName))
        } catch (t: Throwable) {
            promise?.resolve(false)
        }
    }

    override fun requestIgnoreBatteryOptimizations(promise: Promise?) {
        try {
            val ctx = reactApplicationContext
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${ctx.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (intent.resolveActivity(ctx.packageManager) == null) {
                promise?.resolve(false)
                return
            }
            ctx.startActivity(intent)
            promise?.resolve(true)
        } catch (t: Throwable) {
            Log.w(TAG, "requestIgnoreBatteryOptimizations failed", t)
            promise?.resolve(false)
        }
    }

    override fun openBatteryOptimizationSettings(promise: Promise?) {
        try {
            val ctx = reactApplicationContext
            ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise?.resolve(true)
        } catch (t: Throwable) {
            try {
                val ctx = reactApplicationContext
                ctx.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                promise?.resolve(true)
            } catch (t2: Throwable) {
                promise?.resolve(false)
            }
        }
    }

    override fun getInitialTap(promise: Promise?) {
        val tap = pendingTap
        pendingTap = null
        promise?.resolve(tap?.toString() ?: "")
    }

    override fun invalidate() {
        if (instance === this) instance = null
        super.invalidate()
    }

    private fun ensureChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "General", NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    private fun emitTap(tap: JSONObject) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_TAP, tap.toString())
        } catch (t: Throwable) {
            Log.w(TAG, "emitTap failed, storing for cold start", t)
            pendingTap = tap
        }
    }

    companion object {
        private const val TAG = "AppNotify"
        private const val CHANNEL_ID = "general"
        private const val EVENT_TAP = "AppNotifyTap"

        const val EXTRA_PROJECT_ID = "cafebeeai_project_id"
        const val EXTRA_CONV_ID = "cafebeeai_conv_id"

        @Volatile
        private var instance: AppNotifyModule? = null

        @Volatile
        private var pendingTap: JSONObject? = null

        /**
         * MainActivity entry point for notification taps (cold start onCreate + warm onNewIntent).
         * Extras are consumed here so a re-delivered intent never re-navigates.
         */
        @JvmStatic
        fun captureTap(intent: Intent?) {
            if (intent == null) return
            val projectId = intent.getStringExtra(EXTRA_PROJECT_ID) ?: return
            val convId = intent.getStringExtra(EXTRA_CONV_ID) ?: return
            intent.removeExtra(EXTRA_PROJECT_ID)
            intent.removeExtra(EXTRA_CONV_ID)
            val tap = JSONObject()
                .put("projectId", projectId)
                .put("convId", convId)
            val live = instance
            if (live != null) live.emitTap(tap) else pendingTap = tap
        }
    }
}