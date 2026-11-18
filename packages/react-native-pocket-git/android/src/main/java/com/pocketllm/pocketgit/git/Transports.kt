package com.pocketllm.pocketgit.git

import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import org.eclipse.jgit.api.TransportCommand
import org.eclipse.jgit.api.TransportConfigCallback
import org.eclipse.jgit.transport.JschConfigSessionFactory
import org.eclipse.jgit.transport.OpenSshConfig
import org.eclipse.jgit.transport.SshTransport
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import org.eclipse.jgit.util.FS
import org.eclipse.jgit.util.SystemReader
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64

/**
 * Transport payload application:
 * - sslVerify maps onto git's standard `http.sslVerify` user config (TransportHttp then calls
 *   HttpSupport.disableSslVerify per connection - no global SSLSocketFactory pollution).
 * - userpass -> UsernamePasswordCredentialsProvider.
 * - sshKey -> JSch (mwiede fork; rsa/ecdsa/ed25519) with TOFU host-key persistence: first unseen host
 *   is accepted and appended to the app known_hosts file; a CHANGED key is refused (policy "skip"
 *   disables verification entirely).
 */
object Transports {

    fun apply(cmd: TransportCommand<*, *>, payload: JSONObject) {
        if (payload.has("sslVerify")) {
            configureSslVerify(payload.optBoolean("sslVerify", true))
        }
        val cred = payload.optJSONObject("credential") ?: return
        when (cred.optString("type", "none")) {
            "userpass" -> cmd.setCredentialsProvider(
                UsernamePasswordCredentialsProvider(
                    cred.optString("username", ""),
                    cred.optString("password", ""),
                ),
            )

            "sshKey" -> {
                val factory = PocketJschSessionFactory(
                    privatePem = cred.optString("privatePem", "").takeIf { it.isNotBlank() },
                    passphrase = cred.optString("passphrase", "").takeIf { it.isNotBlank() },
                    hostKeyPolicy = payload.optString("hostKeyPolicy", "").takeIf { it.isNotBlank() } ?: "tofu",
                    knownHostsPath = payload.optString("knownHostsPath", "").takeIf { it.isNotBlank() },
                )
                cmd.setTransportConfigCallback(
                    TransportConfigCallback { transport ->
                        if (transport is SshTransport) {
                            transport.sshSessionFactory = factory
                        }
                    },
                )
            }
        }
    }

    /** Synchronous-ish quick op (ed25519 ms; RSA-4096 a few seconds) - resolves via the module promise. */
    fun generateKeyPair(payload: JSONObject): JSONObject {
        val type = payload.optString("type", "ed25519")
        val bits = if (payload.optInt("bits", 4096) >= 2048) payload.optInt("bits", 4096) else 4096
        val comment = payload.optString("comment", "app-android").ifBlank { "app-android" }
        if (type != "rsa") {
            // jsch's KeyPair cannot export ed25519 private keys (see Ed25519OpenSsh), generate via BC.
            val key = Ed25519OpenSsh.generate(comment)
            return JSONObject()
                .put("type", "ed25519")
                .put("privatePem", key.privatePem)
                .put("publicLine", key.publicLine)
                .put("fingerprint", key.fingerprint)
        }
        val jsch = JSch()
        val kp = KeyPair.genKeyPair(jsch, KeyPair.RSA, bits)
        try {
            kp.setPublicKeyComment(comment)
            val priv = ByteArrayOutputStream()
            kp.writePrivateKey(priv)
            val pub = ByteArrayOutputStream()
            kp.writePublicKey(pub, comment)
            return JSONObject()
                .put("type", if (type == "rsa") "rsa" else "ed25519")
                .put("privatePem", String(priv.toByteArray(), Charsets.UTF_8))
                .put("publicLine", String(pub.toByteArray(), Charsets.UTF_8).trim())
                .put("fingerprint", kp.getFingerPrint())
        } finally {
            kp.dispose()
        }
    }

    private fun configureSslVerify(verify: Boolean) {
        try {
            val cfg = SystemReader.getInstance().openUserConfig(null, FS.DETECTED)
            val current = cfg.getBoolean("http", "sslVerify", true)
            if (current != verify) {
                cfg.setBoolean("http", null, "sslVerify", verify)
                cfg.save()
            }
        } catch (_: Exception) {
            // user-config write is best effort; the TLS error path still surfaces cleanly
        }
    }

    private class PocketJschSessionFactory(
        private val privatePem: String?,
        private val passphrase: String?,
        private val hostKeyPolicy: String,
        private val knownHostsPath: String?,
    ) : JschConfigSessionFactory() {

        override fun configure(host: OpenSshConfig.Host?, session: Session?) {
            if (session == null) return
            if (hostKeyPolicy == "skip") {
                session.setConfig("StrictHostKeyChecking", "no")
            } else {
                session.setConfig("StrictHostKeyChecking", "ask")
                session.setUserInfo(TofuUserInfo)
            }
        }

        override fun createDefaultJSch(fs: FS?): JSch {
            val jsch = super.createDefaultJSch(fs)
            jsch.removeAllIdentity()
            privatePem?.let {
                jsch.addIdentity(
                    "git-key",
                    it.toByteArray(Charsets.UTF_8),
                    null,
                    passphrase?.toByteArray(Charsets.UTF_8),
                )
            }
            if (hostKeyPolicy != "skip" && knownHostsPath != null) {
                jsch.setHostKeyRepository(TofuKnownHosts(File(knownHostsPath)))
            }
            return jsch
        }
    }

    /** Auto-accept the first-contact prompt; refuse a changed host key. */
    private object TofuUserInfo : UserInfo {
        override fun promptYesNo(message: String?): Boolean {
            val m = message ?: ""
            return !m.contains("CHANGED", ignoreCase = true) && !m.contains("spoof", ignoreCase = true)
        }

        override fun showMessage(message: String?) {}
        override fun promptPassword(message: String?): Boolean = false
        override fun promptPassphrase(message: String?): Boolean = false
        override fun getPassword(): String? = null
        override fun getPassphrase(): String? = null
    }

    /** Minimal OpenSSH known_hosts reader/writer with file persistence (one host line per entry). */
    private class TofuKnownHosts(private val file: File) : HostKeyRepository {
        private val lines: MutableList<String> = mutableListOf<String>().also { l ->
            try {
                if (file.exists()) {
                    file.readLines().forEach { line ->
                        val trimmed = line.trim()
                        if (trimmed.isNotEmpty() && !trimmed.startsWith("#") && !trimmed.startsWith("@")) l.add(trimmed)
                    }
                }
            } catch (_: Exception) {
            }
        }

        override fun check(host: String?, key: ByteArray?): Int {
            if (host == null || key == null) return HostKeyRepository.NOT_INCLUDED
            val wantHosts = host.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            val alg = algOf(key) ?: return HostKeyRepository.NOT_INCLUDED
            val b64 = Base64.getEncoder().encodeToString(key)
            var sawAlg = false
            for (line in lines) {
                val parts = line.split(" ")
                if (parts.size < 3) continue
                val hostTokens = parts[0].split(",").map { it.trim() }
                val type = parts[1]
                val data = parts[2]
                val hostMatch = hostTokens.any { t -> wantHosts.any { w -> t.equals(w, ignoreCase = true) } }
                if (!hostMatch) continue
                if (type != alg) continue
                sawAlg = true
                if (data == b64) return HostKeyRepository.OK
            }
            return if (sawAlg) HostKeyRepository.CHANGED else HostKeyRepository.NOT_INCLUDED
        }

        override fun add(hostKey: HostKey?, userInfo: UserInfo?) {
            if (hostKey == null) return
            val line = "${hostKey.host} ${hostKey.type} ${hostKey.key}"
            synchronized(lines) {
                if (!lines.any { it == line }) {
                    lines.add(line)
                    persist()
                }
            }
        }

        override fun remove(host: String?, type: String?) {
            synchronized(lines) {
                val changed = lines.removeAll { line ->
                    val parts = line.split(" ")
                    parts.size >= 2 && parts[0].split(",").any { it.equals(host, ignoreCase = true) } &&
                        (type == null || parts[1] == type)
                }
                if (changed) persist()
            }
        }

        override fun remove(host: String?, type: String?, key: ByteArray?) {
            remove(host, type)
        }

        override fun getKnownHostsRepositoryID(): String = file.absolutePath

        override fun getHostKey(): Array<HostKey> {
            return try {
                synchronized(lines) {
                    lines.mapNotNull { line ->
                        val parts = line.split(" ")
                        if (parts.size >= 3) {
                            runCatching { HostKey(parts[0], Base64.getDecoder().decode(parts[2])) }.getOrNull()
                        } else null
                    }
                }.toTypedArray()
            } catch (_: Exception) {
                emptyArray()
            }
        }

        override fun getHostKey(host: String?, type: String?): Array<HostKey> {
            if (host == null || type == null) return emptyArray()
            return try {
                synchronized(lines) {
                    lines.mapNotNull { line ->
                        val parts = line.split(" ")
                        if (parts.size >= 3 && parts[1] == type &&
                            parts[0].split(",").any { it.equals(host, ignoreCase = true) }
                        ) {
                            runCatching { HostKey(parts[0], Base64.getDecoder().decode(parts[2])) }.getOrNull()
                        } else null
                    }
                }.toTypedArray()
            } catch (_: Exception) {
                emptyArray()
            }
        }

        private fun algOf(key: ByteArray): String? {
            return try {
                if (key.size < 4) return null
                val len = ((key[0].toInt() and 0xFF) shl 24) or
                    ((key[1].toInt() and 0xFF) shl 16) or
                    ((key[2].toInt() and 0xFF) shl 8) or
                    (key[3].toInt() and 0xFF)
                if (len <= 0 || len > key.size - 4) return null
                String(key, 4, len, Charsets.US_ASCII)
            } catch (_: Exception) {
                null
            }
        }

        private fun persist() {
            try {
                file.parentFile?.mkdirs()
                file.writeText(lines.joinToString("\n") + "\n")
            } catch (_: Exception) {
                // persistence is best effort: verification of the current session already passed
            }
        }
    }
}
