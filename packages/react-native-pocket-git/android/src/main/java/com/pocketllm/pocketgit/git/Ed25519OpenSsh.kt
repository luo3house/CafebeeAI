package com.pocketllm.pocketgit.git

import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import org.bouncycastle.crypto.KeyGenerationParameters
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * OpenSSH ("openssh-key-v1") ed25519 key generation + private-key serialization.
 *
 * Why not jsch: KeyPairEdDSA.getPrivateKey() throws UnsupportedOperationException in jsch 0.2.2x,
 * so writePrivateKey() can never export an ed25519 pair. BouncyCastle is already the mandatory
 * ed25519 backend of the jsch fork, so the pair is generated with BC directly and packed per
 * OpenSSH PROTOCOL.key with cipher/kdf "none" (generated keys carry no passphrase). The output is
 * parseable by jsch itself (KeyPair.load used by addIdentity) - covered by the host roundtrip check.
 */
object Ed25519OpenSsh {

    data class Generated(val privatePem: String, val publicLine: String, val fingerprint: String)

    private const val ALG = "ssh-ed25519"

    fun generate(comment: String): Generated {
        val generator = Ed25519KeyPairGenerator()
        generator.init(KeyGenerationParameters(SecureRandom(), 256))
        val pair: AsymmetricCipherKeyPair = generator.generateKeyPair()
        val seed = (pair.private as Ed25519PrivateKeyParameters).encoded
        val pub = (pair.public as Ed25519PublicKeyParameters).encoded

        val blob = out {
            string(ALG.toByteArray())
            string(pub)
        }
        val publicLine = "$ALG ${Base64.getEncoder().encodeToString(blob)} $comment".trim()
        val fingerprint = "MD5:" + MessageDigest.getInstance("MD5").digest(blob)
            .joinToString(":") { "%02x".format(it) }

        val check = SecureRandom().nextInt()
        // PROTOCOL.key (current OpenSSH): after the LE checkints the ed25519 section carries
        // string keytype, string pubkey(32), string sk(seed||pub = 64), string comment, then 8-byte pad.
        val sk = ByteArray(seed.size + pub.size).also {
            seed.copyInto(it)
            pub.copyInto(it, seed.size)
        }
        val section = out {
            le32(check)
            le32(check)
            string(ALG.toByteArray())
            string(pub)
            string(sk)
            string(comment.toByteArray())
            val pad = 8 - size % 8
            raw((1..pad).map { it.toByte() }.toByteArray())
        }
        val file = out {
            raw("openssh-key-v1".toByteArray())
            raw(byteArrayOf(0))
            string("none".toByteArray())
            string("none".toByteArray())
            string(ByteArray(0))
            be32(1)
            string(blob)
            be32(section.size)
            raw(section)
        }
        return Generated(toPem(Base64.getEncoder().encodeToString(file)), publicLine, fingerprint)
    }

    private fun toPem(body: String): String {
        val wrapped = body.chunked(70).joinToString("\n")
        return "-----BEGIN OPENSSH PRIVATE KEY-----\n$wrapped\n-----END OPENSSH PRIVATE KEY-----\n"
    }

    /** Little builder around a growing byte buffer so length prefixes can use the current size. */
    private class Builder {
        private val buf = java.io.ByteArrayOutputStream()

        fun raw(bytes: ByteArray) { buf.write(bytes) }

        fun string(bytes: ByteArray) {
            be32(bytes.size)
            raw(bytes)
        }

        fun be32(v: Int) {
            raw(byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte()))
        }

        fun le32(v: Int) {
            raw(byteArrayOf(v.toByte(), (v ushr 8).toByte(), (v ushr 16).toByte(), (v ushr 24).toByte()))
        }

        val size: Int get() = buf.size()

        fun toBytes(): ByteArray = buf.toByteArray()
    }

    private fun out(block: Builder.() -> Unit): ByteArray = Builder().apply(block).toBytes()
}
