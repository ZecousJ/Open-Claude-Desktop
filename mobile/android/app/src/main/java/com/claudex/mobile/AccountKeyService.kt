package com.claudex.mobile

import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

internal class AccountKey(val id: Long, val name: String, private val secret: String, val groupId: Long?, val groupName: String,
    val status: String, val createdAt: String?, val lastUsedAt: String?) {
    val masked get() = AccountKeyContract.mask(secret)
    internal fun secretForGesture() = secret
    override fun toString() = "AccountKey(id=$id)"
}
internal object AccountKeyContract {
    fun id(value: Any?): Long? = (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 1 && it <= 9_007_199_254_740_991.0 && it % 1 == 0.0 }?.toLong()
    fun device(name: String) = listOf("claudex-web:", "claudex-device:", "claudex-desktop:").any(name::startsWith)
    fun nameProblem(value: String): String? = when {
        value.trim().isEmpty() -> UserText.get(R.string.claudex_key_name_empty)
        value.trim().length > 100 -> UserText.get(R.string.claudex_key_name_long)
        device(value.trim()) -> UserText.get(R.string.claudex_key_name_reserved)
        else -> null
    }
    fun mask(value: String) = if (value.length <= 12) "•".repeat(maxOf(8, value.length)) else value.take(5) + "…" + value.takeLast(4)
    fun groups(value: Any?) = (value as? JSONArray)?.objects().orEmpty().mapNotNull { row -> id(row.opt("id"))?.let { it to row.optString("name").take(200) } }.toMap()
    fun rows(value: JSONArray, groups: Map<Long, String>): List<AccountKey> = value.objects().mapNotNull { row ->
        val id = id(row.opt("id")) ?: return@mapNotNull null
        val name = row.opt("name") as? String ?: return@mapNotNull null
        val key = row.opt("key") as? String ?: return@mapNotNull null
        if (device(name) || key.isEmpty() || key.length > 8192) return@mapNotNull null
        val group = id(row.opt("group_id"))
        AccountKey(id, name.take(200), key, group, row.optJSONObject("group")?.optString("name")?.takeIf(String::isNotBlank)?.take(200) ?: groups[group].orEmpty(),
            when (row.optString("status")) { "inactive", "expired" -> row.optString("status"); "quota_exhausted" -> "exhausted"; else -> "active" },
            row.opt("created_at") as? String, row.opt("last_used_at") as? String)
    }.sortedByDescending { runCatching { java.time.OffsetDateTime.parse(it.createdAt).toInstant().toEpochMilli() }.getOrDefault(0) }
    fun status(value: String) = when (value) { "active" -> UserText.get(R.string.claudex_key_status_active); "inactive" -> UserText.get(R.string.claudex_key_status_inactive); "expired" -> UserText.get(R.string.claudex_key_status_expired); "exhausted" -> UserText.get(R.string.claudex_key_status_exhausted); else -> UserText.get(R.string.claudex_key_status_unknown) }
}

/** Browser-owned account routes, never arbitrary runner RPCs. One generation owns every step. */
internal class AccountKeyService(private val generation: () -> Long, private val transport: suspend (String, String, JSONObject?) -> JSONObject) {
    constructor(api: NativeApi): this({ api.sessionGeneration }, { path, method, body -> api.request(path, body, authorized = true, method = method) })
    fun requireCurrent(expected: Long) { check(generation() == expected) { UserText.get(R.string.claudex_key_account_changed) } }
    private suspend fun request(expected: Long, path: String, method: String = "GET", body: JSONObject? = null): Any? {
        requireCurrent(expected)
        val response = transport(path, method, body)
        requireCurrent(expected)
        return if (response.has("data")) response.opt("data") else response
    }
    private suspend fun groups(expected: Long) = AccountKeyContract.groups(request(expected, "/api/v1/groups/available"))
    suspend fun list(expected: Long = generation()): List<AccountKey> {
        val names = groups(expected)
        val rows = JSONArray(); var page = 1; var pages = 1
        do {
            val read = request(expected, "/api/v1/keys?page=$page&page_size=100") as? JSONObject ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
            val items = read.optJSONArray("items") ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
            val count = read.opt("pages")
            pages = if (count == null || count == JSONObject.NULL) 1 else (count as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..50.0 && it % 1 == 0.0 }?.toInt()?.coerceAtLeast(1) ?: error(UserText.get(R.string.claudex_key_too_many))
            for (i in 0 until minOf(items.length(), 100)) rows.put(items.opt(i))
            page++
        } while (page <= pages)
        requireCurrent(expected)
        return AccountKeyContract.rows(rows, names).distinctBy { it.id }
    }
    suspend fun create(name: String, groupId: Long, expected: Long = generation()): AccountKey {
        require(AccountKeyContract.nameProblem(name) == null) { AccountKeyContract.nameProblem(name).orEmpty() }
        require(AccountKeyContract.id(groupId) != null) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        require(groupId in groups(expected)) { UserText.get(R.string.claudex_key_group_gone) }
        val created = try { request(expected, "/api/v1/keys", "POST", JSONObject().put("name", name.trim()).put("group_id", groupId)) as? JSONObject }
            catch (e: CancellationException) { throw e } catch (e: Exception) { throw IllegalStateException(UserText.get(R.string.claudex_key_create_unconfirmed), e) }
        val id = AccountKeyContract.id(created?.opt("id")) ?: error(UserText.get(R.string.claudex_key_create_unconfirmed))
        return try { list(expected).find { it.id == id } ?: error(UserText.get(R.string.claudex_key_create_unconfirmed)) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { throw IllegalStateException(UserText.get(R.string.claudex_key_create_unconfirmed), e) }
    }
    suspend fun delete(id: Long, expected: Long = generation()) {
        require(AccountKeyContract.id(id) != null) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
        require(list(expected).any { it.id == id && !AccountKeyContract.device(it.name) }) { UserText.get(R.string.claudex_key_gone) }
        try { request(expected, "/api/v1/keys/$id", "DELETE") }
        catch (e: CancellationException) { throw e } catch (e: Exception) { throw IllegalStateException(UserText.get(R.string.claudex_key_delete_unconfirmed), e) }
    }
}
