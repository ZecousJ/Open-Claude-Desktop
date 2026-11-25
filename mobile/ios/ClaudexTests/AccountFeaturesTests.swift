import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

// Synthetic fixtures derived from main 7dda489 shared/routines, memory-api and api-keys-api.
private let memoryStatusFixture: JSONValue = .object([
    "available": .bool(true), "allowed": .object(["searchChats": .bool(true), "generate": .bool(true)]),
    "prefs": .object(["searchChats": .bool(false), "generate": .bool(false)]), "synthesizing": .bool(false)])
private let documentFixture: JSONValue = .object(["content": .string("记忆"), "updatedAt": .number(10), "revision": .number(7), "source": .string("edited"), "edits": .array([])])
private let routineFixture: JSONValue = .object([
    "id": .string("routine1"), "name": .string("Task"), "prompt": .string("Review reports"), "mode": .string("cowork"),
    "providerId": .string("p"), "model": .string("m"), "frequency": .string("daily"), "nextRunAt": .number(200), "enabled": .bool(true),
    "repeat": .object(["kind": .string("weekdays"), "time": .string("09:00")]), "defaultModel": .bool(true),
    "createdAt": .number(1), "updatedAt": .number(2), "lastRunStatus": .string("completed")])
private let groupsFixture: JSONValue = .object([
    "groups": .array([.object(["id": .number(5), "name": .string("Group"), "models": .number(3), "primary": .bool(true), "platform": .string("openai"), "protocol": .string("responses")])]),
    "providers": .array([.object(["id": .string("openai"), "name": .string("OpenAI"), "selected": .number(5), "groups": .array([.object(["id": .number(5), "name": .string("Group"), "models": .number(3), "primary": .bool(true), "platform": .string("openai"), "protocol": .string("responses")])])])])])
final class AccountFeaturesTests: XCTestCase {
    func testMemoryAvailabilityAndOfflineBlockChanges() throws {
        XCTAssertTrue(try memoryStatusFixture.decode(MemoryStatus.self).canChange)
        for reason in ["offline", "unsupported", "policy", "server"] {
            var fields = memoryStatusFixture.object!; fields["reason"] = .string(reason); fields["available"] = .bool(reason == "offline")
            XCTAssertFalse(try JSONValue.object(fields).decode(MemoryStatus.self).canChange)
        }
    }
    func testMemoryScopeMatchesStrictDiscriminatedUnion() {
        XCTAssertEqual(MemoryScope.global.wire, .object(["kind": .string("global")]))
        let id = "12345678-1234-1234-1234-123456789abc"
        XCTAssertTrue(MemoryScope.project(id).valid)
        XCTAssertEqual(MemoryScope.project(id).wire, .object(["kind": .string("project"), "projectId": .string(id)]))
        XCTAssertFalse(MemoryScope.project("not-a-project-uuid").valid)
    }
    func testMemoryDocumentUsesRevisionAndPrefsSendOnlyChangedField() async throws {
        let transport = AccountTransport(values: [memoryStatusFixture, documentFixture, documentFixture, memoryStatusFixture, memoryStatusFixture, memoryStatusFixture]), remote = try accountRemote(transport)
        _ = try await remote.memoryStatus(); _ = try await remote.memoryDocument(.global)
        _ = try await remote.saveMemoryDocument(.global, content: "edited", revision: 7)
        _ = try await remote.setMemoryPreference(generate: true)
        _ = try await remote.resetMemory(.global); _ = try await remote.removeMemoryEdit("edit1")
        let calls = try await transport.calls()
        XCTAssertEqual(calls.map(\.0), ["memoryStatus", "memoryDoc", "saveMemoryDoc", "setMemoryPrefs", "resetMemory", "removeMemoryEdit"])
        XCTAssertEqual(calls[2].1, [.object(["kind": .string("global")]), .string("edited"), .number(7)])
        XCTAssertEqual(calls[3].1, [.object(["generate": .bool(true)])])
        XCTAssertEqual(calls[4].1, [.object(["kind": .string("global")])]) // Explicit scope, never reset all.
    }
    func testRememberOrForgetEditSendsOnlyTheInstructionToTheScope() async throws {
        let transport = AccountTransport(values: [documentFixture]), remote = try accountRemote(transport)
        let result = try await remote.updateMemoryEdits(.global, add: "  I like cats  ")
        XCTAssertEqual(result.document?.editChars, 500)
        // A service from before the outcome is worded by what was asked.
        XCTAssertEqual(result.outcome, MemoryEditOutcome(kind: "added"))
        let calls = try await transport.calls()
        XCTAssertEqual(calls.map(\.0), ["updateMemoryEdits"])
        XCTAssertEqual(calls[0].1, [.object(["kind": .string("global")]), .object(["add": .string("I like cats")])])
        do { _ = try await remote.updateMemoryEdits(.global, add: "  "); XCTFail("Expected blank rejection") } catch {}
        do { _ = try await remote.updateMemoryEdits(.global); XCTFail("Expected an empty change rejection") } catch {}
    }
    func testMemoryEditAnswersHowTheChangeWent() async throws {
        var fields = documentFixture.object!
        fields["outcome"] = .object(["kind": .string("added_removed"), "removed": .array([.string("Likes tea")])])
        let transport = AccountTransport(values: [.object(fields)]), remote = try accountRemote(transport)
        let result = try await remote.updateMemoryEdits(.global, add: "Likes coffee", remove: ["e1"])
        XCTAssertEqual(result.outcome, MemoryEditOutcome(kind: "added_removed", removed: ["Likes tea"]))
        XCTAssertFalse(result.outcome.refused)
        let calls = try await transport.calls()
        XCTAssertEqual(calls[0].1, [.object(["kind": .string("global")]), .object(["add": .string("Likes coffee"), "remove": .array([.string("e1")])])])
        // A scope left without memory answers an empty document; a refusal changes nothing.
        let emptyTransport = AccountTransport(values: [.object(["content": .string(""), "updatedAt": .number(0), "revision": .number(0), "source": .string("edited"), "edits": .array([]), "outcome": .object(["kind": .string("rejected")])])])
        let refused = try await accountRemote(emptyTransport).updateMemoryEdits(.global, add: "key")
        XCTAssertNil(refused.document)
        XCTAssertTrue(refused.outcome.refused)
    }
    func testMemoryUTF8LimitAndInvalidRevisionRejectBeforeNetwork() async throws {
        let transport = AccountTransport(values: []), remote = try accountRemote(transport)
        for (text, revision) in [(String(repeating: "中", count: 5462), 0), ("text", -1)] {
            do { _ = try await remote.saveMemoryDocument(.global, content: text, revision: revision); XCTFail("Expected limit rejection") } catch {}
        }
        do { _ = try await remote.memoryDocument(.project("invalid")); XCTFail("Expected scope rejection") } catch {}
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
    func testMemoryConflictReturnsErrorWithoutBlindRetry() async throws {
        let transport = AccountTransport(values: [], error: .object(["ok": .bool(false), "error": .object(["message": .string("Memory changed on another device. Reload it and try again."), "code": .string("CONFLICT")])])), remote = try accountRemote(transport)
        do { _ = try await remote.saveMemoryDocument(.global, content: "unsaved draft", revision: 7); XCTFail("Expected conflict") }
        catch { XCTAssertEqual(error as? ServiceError, .server("Memory changed on another device. Reload it and try again.", "CONFLICT")) }
        let requests = await transport.requests; XCTAssertEqual(requests.count, 1)
    }
    func testRoutineRepeatKindsValidateDaysAndClock() throws {
        XCTAssertEqual(try RoutineContract.validatedRule(kind: "manual", time: "bad", minute: -1, day: -1, days: []), .object(["kind": .string("manual")]))
        XCTAssertEqual(try RoutineContract.validatedRule(kind: "hourly", time: "", minute: 59, day: 0, days: []), .object(["kind": .string("hourly"), "minute": .number(59)]))
        XCTAssertEqual(try RoutineContract.validatedRule(kind: "custom", time: "09:05", minute: 0, day: 0, days: [5, 1, 3]), .object(["kind": .string("custom"), "time": .string("09:05"), "days": .array([.number(1), .number(3), .number(5)])]))
        for kind in ["daily", "weekdays", "weekly"] { XCTAssertNoThrow(try RoutineContract.validatedRule(kind: kind, time: "23:59", minute: 0, day: 6, days: [])) }
        for time in ["24:00", "9:00", "12:60", "00:00Z"] { XCTAssertThrowsError(try RoutineContract.validatedRule(kind: "daily", time: time, minute: 0, day: 0, days: [])) }
        XCTAssertThrowsError(try RoutineContract.validatedRule(kind: "custom", time: "09:00", minute: 0, day: 0, days: []))
        XCTAssertThrowsError(try RoutineContract.validatedRule(kind: "weekly", time: "09:00", minute: 0, day: 7, days: []))
        XCTAssertThrowsError(try RoutineContract.validatedRule(kind: "hourly", time: "", minute: 60, day: 0, days: []))
    }
    func testCustomScheduleIsACronExpressionTheServiceWouldAccept() throws {
        let rule = try RoutineContract.validatedRule(kind: "cron", time: "", minute: 0, day: 0, days: [], expression: " 30 9 * * 1,3 ")
        XCTAssertEqual(rule, .object(["kind": .string("cron"), "expression": .string("30 9 * * 1,3")]))
        let input = try RoutineContract.input(existing: nil, name: "T", description: "", prompt: "P", enabled: true, providerID: "p", model: "m", rule: rule, now: 1)
        XCTAssertEqual(input["frequency"].string, "daily")
        let hourly = try RoutineContract.validatedRule(kind: "cron", time: "", minute: 0, day: 0, days: [], expression: "15 * * * *")
        XCTAssertEqual(try RoutineContract.input(existing: nil, name: "T", description: "", prompt: "P", enabled: true, providerID: "p", model: "m", rule: hourly, now: 1)["frequency"].string, "hourly")
        XCTAssertNil(CronRule.problem("0 9 * * *")); XCTAssertEqual(CronRule.problem("0 9 * *"), .invalid); XCTAssertEqual(CronRule.problem("*/5 * * * *"), .subHourly)
        XCTAssertEqual(CronRule.problem("0 9 * * MON"), .numericOnly); XCTAssertEqual(CronRule.problem("0 9 * * 7"), .sundayIsZero); XCTAssertEqual(CronRule.problem("61 9 * * *"), .invalid)
        XCTAssertEqual(CronRule.problem(""), .invalid); XCTAssertEqual(CronRule.problem("0 9 +1 * *"), .invalid)
        XCTAssertEqual(CronRule.forDays(time: "09:30", days: [2, 1]), "30 9 * * 1,2"); XCTAssertEqual(CronRule.forDays(time: "08:00", days: Array(0...6)), "0 8 * * *")
        XCTAssertEqual(CronRule.asDays("30 9 * * 1,2")?.time, "09:30"); XCTAssertEqual(CronRule.asDays("30 9 * * 1,2")?.days, [1, 2]); XCTAssertNil(CronRule.asDays("30 9 1 * *"))
        for bad in ["*/5 * * * *", "0 9 * * 7", ""] { XCTAssertThrowsError(try RoutineContract.validatedRule(kind: "cron", time: "", minute: 0, day: 0, days: [], expression: bad)) }
    }
    func testOneTimeRuleIsAnAbsoluteMomentAndTheTaskCompletesAfterItsRun() throws {
        let at = 1_790_000_030_000.0
        let rule = try RoutineContract.validatedRule(kind: "once", time: "", minute: 0, day: 0, days: [], at: at)
        XCTAssertEqual(rule, .object(["kind": .string("once"), "at": .number(1_790_000_000_000 - 1_790_000_000_000.truncatingRemainder(dividingBy: 60_000) + 0)]))
        XCTAssertEqual(rule["at"].number!.truncatingRemainder(dividingBy: 60_000), 0)
        for bad in [nil, 0.0, .infinity] as [Double?] { XCTAssertThrowsError(try RoutineContract.validatedRule(kind: "once", time: "", minute: 0, day: 0, days: [], at: bad)) }
        let input = try RoutineContract.input(existing: nil, name: "T", description: "", prompt: "P", enabled: true, providerID: "p", model: "m", rule: rule, now: 1, permission: "default")
        XCTAssertEqual(input["frequency"].string, "daily"); XCTAssertEqual(input["nextRunAt"], rule["at"]); XCTAssertEqual(input["permission"].string, "default")
        XCTAssertThrowsError(try RoutineContract.input(existing: nil, name: "T", description: "", prompt: "P", enabled: true, providerID: "p", model: "m", rule: rule, now: 1, permission: "root"))
        XCTAssertTrue(RoutineContract.oncePast(100, now: 100)); XCTAssertFalse(RoutineContract.oncePast(101, now: 100))
        XCTAssertEqual(RoutineContract.onceMoment(Date(timeIntervalSince1970: 1_790_000_030)), rule["at"].number)
        func task(enabled: Bool, last: Double? = nil, status: String? = nil, mode: String = "cowork") throws -> Routine {
            var fields: [String: JSONValue] = ["id": .string("r"), "mode": .string(mode), "enabled": .bool(enabled), "repeat": rule]
            if let last { fields["lastRunAt"] = .number(last) }; if let status { fields["lastRunStatus"] = .string(status) }
            return try JSONValue.object(fields).decode(Routine.self)
        }
        let waiting = try task(enabled: true), running = try task(enabled: false, last: at + 1000, status: "running")
        let done = try task(enabled: false, last: at + 1000, status: "completed"), paused = try task(enabled: false), early = try task(enabled: false, last: at - 120_000, status: "completed")
        XCTAssertEqual([waiting, running, done, paused, early].map(\.completedOnce), [false, false, true, false, false])
        let sections = RoutineSections.split([waiting, running, done, paused])
        XCTAssertEqual(sections.active, [waiting]); XCTAssertEqual(sections.inactive, [running, paused]); XCTAssertEqual(sections.completed, [done])
        XCTAssertEqual(done.onceAt, rule["at"].number)
    }
    func testPermissionModeDefaultsToFullAccessForCoworkAndIsKeptByTheEditor() throws {
        func task(_ fields: [String: JSONValue]) throws -> Routine { try JSONValue.object(["id": .string("r"), "providerId": .string("p"), "model": .string("m")].merging(fields) { $1 }).decode(Routine.self) }
        XCTAssertEqual(try task(["mode": .string("cowork")]).permission, "bypass")
        XCTAssertNil(try task(["mode": .string("code")]).permission)
        XCTAssertEqual(try task(["mode": .string("code"), "permission": .string("auto")]).permission, "auto")
        XCTAssertNil(try task(["mode": .string("code"), "permission": .string("root")]).permission)
        let kept = try task(["alwaysAllowed": .array([.object(["kind": .string("command"), "tool": .string("Run command"), "pattern": .string("npm test")]), .object(["kind": .string("edit")])])])
        XCTAssertEqual(kept.allowed, [RoutineAllowed(kind: "command", tool: "Run command", pattern: "npm test")])
        // A save keeps the list and unknown fields; the permission is only written when it is chosen.
        let input = try RoutineContract.input(existing: kept, name: "T", description: "", prompt: "P", enabled: true, providerID: "p", model: "m", rule: nil, now: 1)
        XCTAssertEqual(input["alwaysAllowed"], kept.raw["alwaysAllowed"]); XCTAssertNil(input["permission"].string)
    }
    func testChosenModelReplacesTheSavedOneAndStopsFollowingTheDefault() throws {
        let original = try routineFixture.decode(Routine.self)
        let input = try RoutineContract.input(existing: original, name: "T", description: "", prompt: "P", enabled: true, providerID: "ignored", model: "ignored", rule: nil, now: 1, chosenModel: (providerID: "p2", model: "m2"))
        XCTAssertEqual(input["providerId"].string, "p2"); XCTAssertEqual(input["model"].string, "m2"); XCTAssertEqual(input["defaultModel"].bool, false)
    }
    func testRoutineEditAndPausePreserveExistingExecutionFieldsAndLegacyAnchor() throws {
        var fields = routineFixture.object!; fields["repeat"] = nil; fields["cwd"] = .string("/existing"); fields["environment"] = .object(["kind": .string("ssh"), "hostId": .string("host")])
        let original = try JSONValue.object(fields).decode(Routine.self)
        let input = try RoutineContract.input(existing: original, name: "Changed", description: "", prompt: original.prompt, enabled: false, providerID: "ignored", model: "ignored", rule: nil, now: 900)
        XCTAssertEqual(input["nextRunAt"].number, 200); XCTAssertEqual(input["cwd"].string, "/existing")
        XCTAssertEqual(input["environment"], fields["environment"]); XCTAssertEqual(input["providerId"].string, "p")
        XCTAssertEqual(original.settingEnabled(false)["repeat"], .null); XCTAssertEqual(original.settingEnabled(false)["nextRunAt"].number, 200)
    }
    func testNewRoutineDefaultsManualAndDoesNotInventTimezone() throws {
        let rule = try RoutineContract.validatedRule(kind: "manual", time: "", minute: 0, day: 0, days: [])
        let input = try RoutineContract.input(existing: nil, name: " Task ", description: "", prompt: "Do work", enabled: true, providerID: "p", model: "m", rule: rule, now: 1_000)
        XCTAssertEqual(input["repeat"], .object(["kind": .string("manual")]))
        XCTAssertEqual(input["mode"].string, "cowork"); XCTAssertEqual(input["defaultModel"].bool, true)
        XCTAssertEqual(input["timezone"], .null); XCTAssertEqual(input["nextRunAt"].number, 1_000)
    }
    func testSchedulesAndHistoryUseRealPositionalContracts() async throws {
        let run: JSONValue = .object(["id": .string("run1"), "startedAt": .number(10), "finishedAt": .number(20), "status": .string("completed"), "trigger": .string("manual"), "conversationId": .string("c1")])
        let transport = AccountTransport(values: [.array([routineFixture]), .array([run]), routineFixture, routineFixture, .null]), remote = try accountRemote(transport)
        let routines = try await remote.schedules(); XCTAssertEqual(routines.first?.id, "routine1")
        let runs = try await remote.scheduleRuns("routine1"); XCTAssertEqual(runs.first?.conversationId, "c1")
        _ = try await remote.saveSchedule(routineFixture); _ = try await remote.runSchedule("routine1"); try await remote.deleteSchedule("routine1")
        let calls = try await transport.calls()
        XCTAssertEqual(calls.map(\.0), ["listSchedules", "routineRuns", "saveSchedule", "runSchedule", "deleteSchedule"])
        XCTAssertEqual(calls[1].1, [.string("routine1")]); XCTAssertEqual(calls[2].1, [routineFixture])
    }
    func testAPIGroupSelectionIsProviderScopedAndDoesNotReadKeys() async throws {
        let transport = AccountTransport(values: [groupsFixture, groupsFixture, .array([.object(["id": .number(5), "rate_multiplier": .number(2)])]), .object(["5": .number(0.25)])]), remote = try accountRemote(transport)
        let groups = try await remote.apiGroups(); XCTAssertEqual(groups.providers.first?.selected, 5)
        _ = try await remote.setAPIGroup(providerID: "openai", groupID: 5)
        let rates = try await remote.groupRates(); XCTAssertEqual(rates["5"], 0.25)
        let calls = try await transport.calls()
        XCTAssertEqual(calls.map(\.0), ["apiGroups", "setApiGroup", "available", "rates"])
        let requests = await transport.requests
        XCTAssertEqual(requests[2].url?.path, "/api/v1/groups/available")
        XCTAssertEqual(requests[3].url?.path, "/api/v1/groups/rates")
        XCTAssertEqual(requests[2].httpMethod, "GET"); XCTAssertEqual(requests[3].httpMethod, "GET")
        XCTAssertFalse(requests.contains { $0.url?.path.hasSuffix("/rpc/groupRates") == true })
        XCTAssertEqual(calls[0].1, [.bool(false)]); XCTAssertEqual(calls[1].1, [.string("openai"), .number(5)])
    }
    func testExplicitAPIGroupRefreshRequestsFreshCatalog() async throws {
        let transport = AccountTransport(values: [groupsFixture, groupsFixture]), remote = try accountRemote(transport)
        _ = try await remote.apiGroups(); _ = try await remote.apiGroups(fresh: true)
        let calls = try await transport.calls()
        XCTAssertEqual(calls[0].1, [.bool(false)]); XCTAssertEqual(calls[1].1, [.bool(true)])
    }
    func testGroupRateNormalizationUsesValidAccountOverridesOnly() {
        let available: JSONValue = .array([.object(["id": .number(5), "rate_multiplier": .number(2)]), .object(["id": .number(6), "rate_multiplier": .number(0)]), .object(["id": .number(-1), "rate_multiplier": .number(1)]), .object(["id": .number(9_007_199_254_740_992), "rate_multiplier": .number(1)])])
        let own: JSONValue = .object(["005": .number(0.25), "bad": .number(8), "6": .number(-1), "7": .string("1.5")])
        XCTAssertEqual(APIGroupRates.normalize(available: available, own: own), ["5": 0.25, "6": 0])
    }
    func testGroupRateOverrideFailureDoesNotReturnUnconfirmedDefault() async throws {
        let transport = AccountTransport(values: [.array([.object(["id": .number(5), "rate_multiplier": .number(2)])])], ownRatesFailure: true)
        let remote = try accountRemote(transport)
        do { _ = try await remote.groupRates(); XCTFail("Must report unavailable account rate") }
        catch { XCTAssertEqual(error as? ServiceError, .server("Rates unavailable", nil)) }
        let requests = await transport.requests; XCTAssertEqual(requests.count, 2)
    }
    func testAPIGroupUnsafeIntegerFailsBeforeNetwork() async throws {
        let transport = AccountTransport(values: []), remote = try accountRemote(transport)
        do { _ = try await remote.setAPIGroup(providerID: "openai", groupID: 9_007_199_254_740_992); XCTFail("Expected safe-integer check") } catch {}
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
    func testAccountChangeBefore401RetryCannotReplayMutationUnderNewAccount() async throws {
        let session = SwitchingSession(), transport = SwitchingTransport(session: nil)
        await transport.setSession(session)
        let rpc = try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "tab", session: session, transport: transport)
        do { let _: JSONValue = try await rpc.call("saveMemoryDoc", args: [.string("old-account-draft")], as: JSONValue.self); XCTFail("Expected cancellation") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let calls = await transport.count, refreshes = await session.refreshes
        XCTAssertEqual(calls, 1); XCTAssertEqual(refreshes, 0)
    }
    func testDirectREST401CannotRefreshIntoAnotherSession() async throws {
        let session = SwitchingSession(), transport = SwitchingTransport(session: nil); await transport.setSession(session)
        let direct = DirectServiceClient(rpc: try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "tab", session: session, transport: transport))
        do { _ = try await direct.request("api/v1/claudex/status"); XCTFail("Expected cancellation") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let count = await transport.count, refreshes = await session.refreshes
        XCTAssertEqual(count, 1); XCTAssertEqual(refreshes, 0)
    }
    func testChunkUpload401CannotRefreshIntoAnotherSession() async throws {
        let session = SwitchingSession(), transport = SwitchingTransport(session: nil); await transport.setSession(session)
        let remote = RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "tab", session: session, transport: transport))
        do { _ = try await remote.upload(name: "data.bin", data: Data(repeating: 1, count: AttachmentLimits.inlineMaximum + 1)); XCTFail("Expected cancellation") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let count = await transport.count, refreshes = await session.refreshes
        XCTAssertEqual(count, 1); XCTAssertEqual(refreshes, 0)
    }
    func testAccountChangeDuringTokenAcquisitionNeverSendsRequest() async throws {
        let session = SwitchingSession(changeOnAccess: true), transport = SwitchingTransport(session: nil)
        let rpc = try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "tab", session: session, transport: transport)
        do { let _: JSONValue = try await rpc.call("setApiGroup", as: JSONValue.self); XCTFail("Expected cancellation") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let calls = await transport.count; XCTAssertEqual(calls, 0)
    }
    func testAccountChangeDuringRefreshNeverSendsRetriedMutation() async throws {
        let session = SwitchingSession(changeOnRefresh: true), transport = SwitchingTransport(session: nil)
        let rpc = try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "tab", session: session, transport: transport)
        do { let _: JSONValue = try await rpc.call("saveSchedule", as: JSONValue.self); XCTFail("Expected cancellation") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let calls = await transport.count, refreshes = await session.refreshes
        XCTAssertEqual(calls, 1); XCTAssertEqual(refreshes, 1)
    }
}
private actor AccountSession: SessionProvider {
    func accessToken() async throws -> String { "fixture" }
    func eventsTicket(tabID: String) async throws -> String { "ticket" }
    func signOut() async throws {}
}
private actor AccountTransport: HTTPTransport {
    var values: [JSONValue], error: JSONValue?
    let ownRatesFailure: Bool
    var requests: [URLRequest] = []
    init(values: [JSONValue], error: JSONValue? = nil, ownRatesFailure: Bool = false) { self.values = values; self.error = error; self.ownRatesFailure = ownRatesFailure }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        if ownRatesFailure && request.url?.path == "/api/v1/groups/rates" { return (Data("{\"code\":500,\"message\":\"Rates unavailable\"}".utf8), 500) }
        if let error { return (try JSONEncoder().encode(error), 409) }
        guard !values.isEmpty else { throw ServiceError.invalidResponse }
        let value = values.removeFirst()
        if request.url?.path.hasPrefix("/api/v1/groups/") == true { return (try JSONEncoder().encode(JSONValue.object(["code": .number(0), "data": value])), 200) }
        return (try JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "value": value])), 200)
    }
    func calls() throws -> [(String, [JSONValue])] {
        try requests.map { request in
            let payload = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data("{}".utf8))
            return (request.url!.lastPathComponent, payload["args"].array ?? [])
        }
    }
}
private func accountRemote(_ transport: AccountTransport) throws -> RemoteClaudexService { RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://fixture.test")!, tabID: "tab", session: AccountSession(), transport: transport)) }
private actor SwitchingSession: SessionProvider {
    var generation = 1, refreshes = 0
    let changeOnAccess: Bool, changeOnRefresh: Bool
    init(changeOnAccess: Bool = false, changeOnRefresh: Bool = false) { self.changeOnAccess = changeOnAccess; self.changeOnRefresh = changeOnRefresh }
    func change() { generation += 1 }
    func sessionGeneration() async -> Int? { generation }
    func accessToken() async throws -> String { if changeOnAccess { generation += 1 }; return "token" }
    func refreshAccessToken() async throws -> String { refreshes += 1; if changeOnRefresh { generation += 1 }; return "new-token" }
    func eventsTicket(tabID: String) async throws -> String { "ticket" }
    func signOut() async throws {}
}
private actor SwitchingTransport: HTTPTransport {
    var session: SwitchingSession?, count = 0
    init(session: SwitchingSession?) { self.session = session }
    func setSession(_ value: SwitchingSession) { session = value }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        count += 1; await session?.change()
        return (Data("{\"ok\":false,\"error\":{\"message\":\"expired\"}}".utf8), 401)
    }
}
