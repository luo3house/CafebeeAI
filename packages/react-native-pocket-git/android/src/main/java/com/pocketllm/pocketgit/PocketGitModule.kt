package com.pocketllm.pocketgit

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.pocketllm.pocketgit.git.Errors
import com.pocketllm.pocketgit.git.GitSdk
import com.pocketllm.pocketgit.git.Transports
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thin RN shell over GitSdk: quick ops run straight through; clone/upload/sync/forceSync
 * start an opId-backed job resolved/rejected through PocketGitProgress/Done/Failed events.
 */
class PocketGitModule(reactContext: ReactApplicationContext) : NativePocketGitSpec(reactContext) {

    private val executor = Executors.newCachedThreadPool()
    private val running = ConcurrentHashMap<String, Op>()

    private class Op(val cancelFlag: AtomicBoolean)

    override fun addListener(eventType: String?) {
        // Required by NativeEventEmitter; delivery uses DeviceEventEmitter directly.
    }

    override fun removeListeners(count: Double) {}

    override fun ensureRepo(path: String?, initialBranch: String?, reservedSegment: String?, promise: Promise?) {
        runQuick(promise) { GitSdk.ensureRepo(path.orEmpty(), initialBranch.orEmpty(), reservedSegment.orEmpty()) }
    }

    override fun initBare(path: String?, promise: Promise?) {
        runQuick(promise) { GitSdk.initBare(path.orEmpty()) }
    }

    override fun close(handle: String?, promise: Promise?) {
        runQuick(promise) {
            GitSdk.close(handle.orEmpty())
            JSONObject()
        }
    }

    override fun status(handle: String?, promise: Promise?) {
        runQuick(promise) { GitSdk.status(handle.orEmpty()) }
    }

    override fun setRemote(handle: String?, name: String?, url: String?, promise: Promise?) {
        runQuick(promise) { GitSdk.setRemote(handle.orEmpty(), name.orEmpty("origin"), url.orEmpty()) }
    }

    override fun getRemote(handle: String?, name: String?, promise: Promise?) {
        runQuick(promise) { GitSdk.getRemote(handle.orEmpty(), name.orEmpty("origin")) }
    }

    override fun lsRemote(payload: String?, promise: Promise?) {
        runQuick(promise) { GitSdk.lsRemote(parsePayload(payload)) }
    }

    override fun cloneStart(payload: String?, promise: Promise?) {
        startOp(payload, promise) { emit, flag, json -> GitSdk.clone(json, emit, flag) }
    }

    override fun uploadStart(payload: String?, promise: Promise?) {
        startOp(payload, promise) { emit, flag, json -> GitSdk.upload(json, emit, flag) }
    }

    override fun syncStart(payload: String?, promise: Promise?) {
        startOp(payload, promise) { emit, flag, json -> GitSdk.sync(json, emit, flag) }
    }

    override fun forceSyncStart(payload: String?, promise: Promise?) {
        startOp(payload, promise) { emit, flag, json -> GitSdk.forceSync(json, emit, flag) }
    }

    override fun cancel(opId: String?, promise: Promise?) {
        val found = opId?.let { running[it] }
        found?.cancelFlag?.set(true)
        promise?.resolve(if (found != null) "true" else "false")
    }

    override fun generateSshKey(payload: String?, promise: Promise?) {
        runQuick(promise) { Transports.generateKeyPair(parsePayload(payload)) }
    }

    private fun String?.orEmpty(default: String): String = this?.takeIf { it.isNotBlank() } ?: default

    private fun runQuick(promise: Promise?, block: () -> JSONObject) {
        try {
            promise?.resolve(block().toString())
        } catch (t: Throwable) {
            Log.e(TAG, "quick op failed", t)
            val (code, message) = Errors.of(t)
            promise?.reject(code, message)
        }
    }

    private fun startOp(
        payload: String?,
        promise: Promise?,
        job: ((String) -> Unit, AtomicBoolean, JSONObject) -> JSONObject,
    ) {
        val json = parsePayload(payload)
        val opId = GitSdk.newOpId()
        val flag = AtomicBoolean(false)
        running[opId] = Op(flag)
        promise?.resolve(opId)
        executor.execute {
            val emit: (String) -> Unit = { message ->
                emitEvent("PocketGitProgress") {
                    putString("opId", opId)
                    putString("message", message)
                }
            }
            try {
                val result = job(emit, flag, json)
                if (flag.get()) {
                    emitFailed(opId, "cancelled", "Operation cancelled")
                } else {
                    emitEvent("PocketGitDone") {
                        putString("opId", opId)
                        putString("result", result.toString())
                    }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "long op failed opId=$opId", t)
                val (code, message) = if (flag.get()) {
                    Pair("cancelled", "Operation cancelled")
                } else {
                    Errors.of(t)
                }
                emitFailed(opId, code, message)
            } finally {
                running.remove(opId)
            }
        }
    }

    private fun emitFailed(opId: String, code: String, message: String) {
        emitEvent("PocketGitFailed") {
            putString("opId", opId)
            putString("code", code)
            putString("message", message)
        }
    }

    private fun emitEvent(channel: String, build: WritableMap.() -> Unit) {
        val context = reactApplicationContext
        if (!context.hasActiveReactInstance()) return
        val map = Arguments.createMap()
        map.build()
        context
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(channel, map)
    }

    companion object {
        private const val TAG = "PocketGit"

        private fun parsePayload(payload: String?): JSONObject =
            try {
                JSONObject(payload ?: "{}")
            } catch (e: Exception) {
                JSONObject()
            }
    }
}
