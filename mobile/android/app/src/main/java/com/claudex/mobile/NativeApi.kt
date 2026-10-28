package com.claudex.mobile

import com.claudex.core.*
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.currentCoroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class NativeApi(val origin: String, private val vault: CredentialStore, val client: OkHttpClient = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()) {
    val tabId = newId()
    private val refreshLock = Mutex()
    private val sessionLock = Any()
    private val generationState = MutableStateFlow(0L)
    val sessionChanges = generationState.asStateFlow()
    @Volatile private var epoch = 0L
        set(value) { field = value; generationState.value = value }
    @Volatile var session: Session? = vault.load(); private set
    private val authentication = MutableStateFlow(session != null)
    val authenticated = authentication.asStateFlow()
    /** Opaque generation only; the display bridge never receives authentication material. */
    val sessionGeneration: Long get() = epoch
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    init { if (origin.isNotBlank()) NativeAuthSecurity.validateOrigin(origin) }
    private class SessionBinding(val owner: NativeApi, val generation: Long): AbstractCoroutineContextElement(Key) { companion object Key: CoroutineContext.Key<SessionBinding> }
    /** Bind an entire multi-request upload/send workflow to its initiating account. Refresh keeps this generation. */
    suspend fun <T> withCurrentSession(block: suspend () -> T): T {
        val inherited = currentCoroutineContext()[SessionBinding]?.takeIf { it.owner === this }
        val expected = inherited?.generation ?: epoch
        if (epoch != expected) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        return withContext(SessionBinding(this, expected)) {
            val result = block()
            if (epoch != expected) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
            result
        }
    }
    suspend fun request(path: String, json: JSONObject? = null, authorized: Boolean = false, method: String = "POST", raw: ByteArray? = null, responseSequence: ((Long?) -> Unit)? = null): JSONObject {
        if (origin.isBlank()) throw ApiException("NOT_CONFIGURED", UserText.get(R.string.error_server))
        val binding = currentCoroutineContext()[SessionBinding]?.takeIf { it.owner === this }
        val expectedEpoch = if (authorized) binding?.generation ?: epoch else epoch
        val token = if (authorized) validToken(expectedEpoch) else null
        if (authorized && epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        val result = try { execute(path, json, token, method, raw, responseSequence) } catch (e: ApiException) {
            if (!authorized || e.httpStatus != 401 || epoch != expectedEpoch) throw e
            // An explicit 401 means the server rejected authentication before the mutation.
            val refreshed = validToken(expectedEpoch, forceToken = token)
            if (epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
            execute(path, json, refreshed, method, raw, responseSequence)
        }
        if (authorized && epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        return result
    }
    private suspend fun execute(path: String, json: JSONObject?, token: String?, method: String, raw: ByteArray?, responseSequence: ((Long?) -> Unit)? = null): JSONObject {
        require(path.startsWith("/api/v1/"))
        val request = Request.Builder().url(origin.trimEnd('/') + path).header("User-Agent", "Claudex-Android/0.1").header("X-Claudex-Web-Tab", tabId)
        if (token != null) request.header("Authorization", "Bearer $token")
        request.method(method, if (method == "GET") null else raw?.toRequestBody("application/octet-stream".toMediaType()) ?: (json ?: JSONObject()).toString().toRequestBody(jsonType))
        val response = client.newCall(request.build()).await()
        return withContext(Dispatchers.IO) { response.use {
            val limit = if (path.endsWith("/readGeneratedFile")) 42L * 1024 * 1024 else if (path.endsWith("/loadRemoteImage")) 14L * 1024 * 1024 else 64L * 1024 * 1024
            val body = it.body?.let { responseBody ->
                require(responseBody.contentLength() <= limit) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
                responseBody.byteStream().use { input ->
                    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(16 * 1024)
                    while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size().toLong() + count <= limit) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }; output.write(buffer, 0, count) }
                    output.toString("UTF-8")
                }
            }.orEmpty()
            val parsed = runCatching { JSONObject(body) }.getOrElse { JSONObject() }
            if (!it.isSuccessful) {
                val wireError = parsed.optJSONObject("error")
                val code = wireError?.optString("code") ?: parsed.optString("reason", "HTTP_${it.code}")
                val message = wireError?.optString("message") ?: parsed.optString("message", UserText.get(R.string.error_server))
                throw ApiException(code, CapacityErrorPresentation.message(code, message, wireError?.optJSONObject("metadata")?.optString("scope") ?: parsed.optJSONObject("metadata")?.optString("scope")), it.code)
            }
            if (parsed.has("code") && parsed.optInt("code") != 0) { val code = parsed.optString("reason", "AUTH_ERROR"); throw ApiException(code, CapacityErrorPresentation.message(code, parsed.optString("message", UserText.get(R.string.generic_error_something_went_wrong_try_again)), parsed.optJSONObject("metadata")?.optString("scope"))) }
            responseSequence?.invoke(SnapshotEventSequence.parse(it.header("X-Claudex-Event-Seq")))
            parsed
        } }
    }
    suspend fun login(email: String, password: String): JSONObject {
        val expectedEpoch = synchronized(sessionLock) { ++epoch }
        val data = request("/api/v1/auth/login", JSONObject().put("email", email).put("password", password)).getJSONObject("data")
        if (epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        if (!data.optBoolean("requires_2fa")) setSession(data, email, expectedEpoch)
        return data
    }
    suspend fun twoFactor(tempToken: String, code: String, email: String) {
        val expectedEpoch = epoch
        val data = request("/api/v1/auth/login/2fa", JSONObject().put("temp_token", tempToken).put("totp_code", code)).getJSONObject("data")
        setSession(data, email, expectedEpoch)
    }
    suspend fun register(email: String, password: String, code: String) {
        val expectedEpoch = synchronized(sessionLock) { ++epoch }
        val data = request("/api/v1/auth/register", JSONObject().put("email", email).put("password", password).put("verify_code", code)).getJSONObject("data")
        setSession(data, email, expectedEpoch)
    }
    suspend fun sendVerification(email: String): Int = request("/api/v1/auth/send-verify-code", JSONObject().put("email", email)).getJSONObject("data").optInt("countdown", 60)
    private fun setSession(data: JSONObject, fallbackEmail: String, expectedEpoch: Long) = synchronized(sessionLock) {
        if (epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.error_account_session_invalid))
        val access = data.getString("access_token")
        val ttl = data.optLong("expires_in", 0)
        val expiry = if (ttl > 0) System.currentTimeMillis() + ttl * 1000 else runCatching { JSONObject(String(java.util.Base64.getUrlDecoder().decode(access.split('.')[1]))).getLong("exp") * 1000 }.getOrDefault(System.currentTimeMillis())
        val next = Session(access, data.optString("refresh_token"), expiry, data.optJSONObject("user")?.optString("email") ?: fallbackEmail)
        vault.save(next)
        session = next
        authentication.value = true
        next
    }
    private suspend fun validToken(requestEpoch: Long, forceToken: String? = null): String = refreshLock.withLock {
        if (epoch != requestEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
        val current = session ?: throw ApiException("SIGNED_OUT", UserText.get(R.string.error_account_session_invalid))
        if ((forceToken == null && current.expiresAt > System.currentTimeMillis() + 60_000) || (forceToken != null && current.accessToken != forceToken)) return@withLock current.accessToken
        if (current.refreshToken.isBlank()) { clearIfEpoch(requestEpoch); throw ApiException("SIGNED_OUT", UserText.get(R.string.error_account_session_invalid)) }
        val expectedEpoch = requestEpoch
        try {
            val data = execute("/api/v1/auth/refresh", JSONObject().put("refresh_token", current.refreshToken), null, "POST", null).getJSONObject("data")
            if (epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
            if (data.optString("refresh_token").isBlank()) { clearIfEpoch(expectedEpoch); throw ApiException("TOKEN_ROTATION_INVALID", UserText.get(R.string.error_account_session_invalid)) }
            val refreshed = setSession(data, current.accountLabel, expectedEpoch)
            if (epoch != expectedEpoch) throw ApiException("STALE_SESSION", UserText.get(R.string.generic_error_something_went_wrong_try_again))
            refreshed.accessToken
        } catch (e: ApiException) { if (e.httpStatus == 401 || e.code.contains("401") || e.code.contains("TOKEN") || e.code.contains("SIGNED_OUT")) clearIfEpoch(expectedEpoch); throw e }
    }
    private fun clearIfEpoch(expected: Long) = synchronized(sessionLock) { if (epoch == expected) clear() }
    suspend fun logout() {
        val token = session?.refreshToken
        clear()
        if (!token.isNullOrBlank()) request("/api/v1/auth/logout", JSONObject().put("refresh_token", token))
    }
    fun cancelAuthentication() = synchronized(sessionLock) { epoch++ }
    fun clear() = synchronized(sessionLock) { epoch++; session = null; vault.clear(); authentication.value = false }
}
private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object: Callback {
        override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) { if (continuation.isActive) continuation.resume(response) else response.close() }
    })
}
