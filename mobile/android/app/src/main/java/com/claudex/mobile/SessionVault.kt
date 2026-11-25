package com.claudex.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.claudex.core.Session
import com.claudex.core.CredentialStore
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** App-private encrypted refresh/access tokens. Backups disabled; password is never persisted. */
class SessionVault(context: Context, origin: String): CredentialStore {
    private val originKey = java.security.MessageDigest.getInstance("SHA-256").digest(origin.trimEnd('/').toByteArray()).joinToString("") { "%02x".format(it) }
    private val preferences = context.getSharedPreferences("session-$originKey", Context.MODE_PRIVATE)
    private val alias = "claudex-session-v1-$originKey"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun save(session: Session) {
        if (session.refreshToken.isBlank()) { clear(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val json = JSONObject().put("access", session.accessToken).put("refresh", session.refreshToken).put("expires", session.expiresAt).put("account", session.accountLabel).toString()
        val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(json.toByteArray()), Base64.NO_WRAP)
        check(preferences.edit().putString("encrypted", encoded).commit()) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
    }
    override fun load(): Session? = runCatching {
        val encoded = preferences.getString("encrypted", null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size))))
        Session(json.getString("access"), json.getString("refresh"), json.getLong("expires"), json.getString("account"))
    }.getOrElse { clear(); null }
    override fun clear() { preferences.edit().clear().commit() }
}
