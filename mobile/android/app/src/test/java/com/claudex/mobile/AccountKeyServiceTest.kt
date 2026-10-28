package com.claudex.mobile

import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AccountKeyServiceTest {
    @Test fun emptyAccountWithZeroPagesStillHasAnEmptyPersonalList() = runTest {
        val service = AccountKeyService({ 1L }) { path, _, _ -> if (path.contains("groups")) available else page("[]", 0) }
        assertTrue(service.list().isEmpty())
    }
    private val available = JSONObject().put("data", JSONArray("""[{"id":1,"name":"synthetic-group"}]"""))
    private fun page(rows: String, pages: Int = 1) = JSONObject().put("data", JSONObject().put("items", JSONArray(rows)).put("pages", pages))
    @Test fun pagesExcludeDeviceKeysAndMaskSecretsWithoutLoggingThem() = runTest {
        val calls = mutableListOf<String>()
        val service = AccountKeyService({ 1L }) { path, method, _ -> calls += "$method $path"; when {
            path.contains("groups") -> available
            path.contains("page=1&") -> page("""[{"id":1,"name":"claudex-device:fixture","key":"synthetic"},{"id":2,"name":"own","key":"sk-synthetic-abcdefgh","group_id":1}]""", 2)
            else -> page("""[{"id":3,"name":"short","key":"tiny"}]""", 2)
        } }
        val keys = service.list()
        assertEquals(listOf(2L, 3L), keys.map { it.id }); assertEquals("synthetic-group", keys.first().groupName)
        assertEquals("sk-sy…efgh", keys.first().masked); assertEquals("••••••••", keys.last().masked)
        assertFalse(keys.first().toString().contains("synthetic"))
        assertEquals(listOf("GET /api/v1/groups/available", "GET /api/v1/keys?page=1&page_size=100", "GET /api/v1/keys?page=2&page_size=100"), calls)
    }
    @Test fun createChecksFreshGroupAndReadsBackCreatedIdWithExactBody() = runTest {
        val calls = mutableListOf<String>()
        val service = AccountKeyService({ 4L }) { path, method, body ->
            calls += "$method $path"
            when { method == "POST" -> { assertEquals(setOf("name", "group_id"), body!!.keys().asSequence().toSet()); assertEquals("test", body.getString("name")); assertEquals(1L, body.getLong("group_id")); JSONObject().put("data", JSONObject().put("id", 2)) }
                path.contains("groups") -> available
                else -> page("""[{"id":2,"name":"test","key":"synthetic-created"}]""") }
        }
        assertEquals(2L, service.create(" test ", 1).id)
        assertEquals(1, calls.count { it.startsWith("POST") }); assertEquals(4, calls.size)
    }
    @Test fun reservedNamesInvalidGroupsAndDeviceDeletionNeverMutate() = runTest {
        val calls = mutableListOf<String>()
        val service = AccountKeyService({ 1L }) { path, method, _ -> calls += method; if (path.contains("groups")) available else page("""[{"id":7,"name":"claudex-web:fixture","key":"synthetic"}]""") }
        try { service.create("claudex-desktop:reserved", 1); fail() } catch (_: IllegalArgumentException) {}
        try { service.create("own", 2); fail() } catch (_: IllegalArgumentException) {}
        try { service.delete(7); fail() } catch (_: IllegalArgumentException) {}
        assertTrue(calls.all { it == "GET" })
    }
    @Test fun deleteReReadsPersonalListAndUsesOnlyExactNumericRoute() = runTest {
        val calls = mutableListOf<String>()
        val service = AccountKeyService({ 3L }) { path, method, _ -> calls += "$method $path"; if (path.contains("groups")) available else if (method == "DELETE") JSONObject().put("data", JSONObject()) else page("""[{"id":9,"name":"own","key":"synthetic"}]""") }
        service.delete(9)
        assertEquals("DELETE /api/v1/keys/9", calls.last())
        try { service.delete(-1); fail() } catch (_: IllegalArgumentException) {}
        assertEquals(1, calls.count { it.startsWith("DELETE") })
    }
    @Test fun generationChangeStopsReadBeforeAnotherAccountRequest() = runTest {
        var generation = 1L; var calls = 0
        val service = AccountKeyService({ generation }) { _, _, _ -> calls++; generation = 2; available }
        try { service.list(1); fail() } catch (_: IllegalStateException) {}
        assertEquals(1, calls)
    }
    @Test fun mutationResponseCannotTriggerReadBackIntoChangedAccount() = runTest {
        var generation = 1L; val methods = mutableListOf<String>()
        val service = AccountKeyService({ generation }) { _, method, _ -> methods += method; if (method == "POST") { generation = 2; JSONObject().put("data", JSONObject().put("id", 9)) } else available }
        try { service.create("own", 1, 1); fail() } catch (_: IllegalStateException) {}
        assertEquals(listOf("GET", "POST"), methods)
    }
    @Test fun overLimitPaginationIsNotACompleteSuccessList() = runTest {
        val service = AccountKeyService({ 1L }) { path, _, _ -> if (path.contains("groups")) available else page("[]", 51) }
        try { service.list(); fail() } catch (_: IllegalStateException) {}
        assertNotNull(AccountKeyContract.nameProblem("a".repeat(101)))
        assertNull(AccountKeyContract.id(1.5)); assertNull(AccountKeyContract.id(Double.NaN))
    }
}
