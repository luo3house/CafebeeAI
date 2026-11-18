package com.pocketllm.pocketgit.git

import android.util.Log

/** Error taxonomy carried to JS as {code, message}; messages are en-US (app rule 14). */
object Errors {

    class GitFailure(val code: String, message: String) : Exception(message)

    class SyncConflict : Exception(
        "Local and remote histories differ, or local changes block the update.",
    )

    class PushRejected : Exception(
        "The remote branch has commits that are not in the local history. Sync first, or use force upload.",
    )

    class CancelledSignal : Exception("Operation cancelled")

    fun of(t: Throwable): Pair<String, String> {
        val chain = generateSequence<Throwable>(t) { it.cause }.toList()

        if (chain.any {
                it is CancelledSignal ||
                    it is org.eclipse.jgit.api.errors.CanceledException ||
                    it is org.eclipse.jgit.errors.CancelledException
            }
        ) {
            return Pair("cancelled", "Operation cancelled")
        }

        chain.firstOrNull { it is GitFailure }?.let {
            val f = it as GitFailure
            return Pair(f.code, f.message ?: "Git operation failed")
        }

        if (chain.any {
                it is SyncConflict ||
                    it is org.eclipse.jgit.api.errors.CheckoutConflictException ||
                    it is org.eclipse.jgit.api.errors.UnmergedPathsException ||
                    it is org.eclipse.jgit.api.errors.NotMergedException
            }
        ) {
            return Pair("sync_conflict", SyncConflict().message ?: "Sync conflict")
        }

        if (chain.any { it is PushRejected }) {
            return Pair("push_rejected", PushRejected().message ?: "Push rejected")
        }

        if (chain.any {
                it is com.jcraft.jsch.JSchHostKeyException ||
                    it is com.jcraft.jsch.JSchChangedHostKeyException
            }
        ) {
            return Pair(
                "host_key_untrusted",
                "The server host key is not trusted or has changed. Review the host key or enable skipping host verification.",
            )
        }

        val jsch = chain.firstOrNull { it is com.jcraft.jsch.JSchException }
        if (jsch != null) {
            val msg = jsch.message ?: ""
            return when {
                msg.contains("Auth", ignoreCase = true) || msg.contains("password", true) ->
                    Pair("auth_failed", "Authentication failed. Check the selected credential.")

                msg.contains("reject HostKey", true) ->
                    Pair("host_key_untrusted", "The server host key is not trusted. Review it or enable skipping host verification.")

                else -> Pair("network_error", "SSH connection failed: $msg")
            }
        }

        val transport = chain.firstOrNull {
            it is org.eclipse.jgit.errors.TransportException ||
                it is org.eclipse.jgit.api.errors.TransportException
        }
        if (transport != null) {
            val msg = transport.message ?: ""
            return when {
                msg.contains("401") || msg.contains("403") ||
                    msg.contains("Authentication", true) || msg.contains("invalid credentials", true) ->
                    Pair(
                        "auth_failed",
                        "Authentication failed. Check the selected credential (a token may be expired or lack repository scope).",
                    )

                msg.contains("404") || msg.contains("not found", true) ->
                    Pair("invalid_url", "Repository not found. Check the URL and your access.")

                else -> Pair("network_error", msg.ifBlank { "Network error while contacting the remote." })
            }
        }

        if (chain.any {
                it is org.eclipse.jgit.api.errors.InvalidRemoteException ||
                    it is java.net.URISyntaxException ||
                    it is IllegalArgumentException
            }
        ) {
            return Pair("invalid_url", "The remote URL is not valid.")
        }

        val meaningful = chain.firstOrNull { !it.message.isNullOrBlank() }?.message
        if (meaningful != null) return Pair("git_error", meaningful)
        // All chain messages blank: keep the en-US fallback but carry the exception-class trail so
        // the dialog / JS console.error / logcat reveal what actually blew up (e.g. LinkageError names).
        val trace = chain.joinToString(" <- ") { it.javaClass.simpleName }
        Log.e("PocketGit", "git_error fallback, chain=$trace", t)
        return Pair("git_error", "Git operation failed ($trace)")
    }
}
