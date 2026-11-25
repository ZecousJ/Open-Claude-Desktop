import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

final class DiagnosticPolicyTests: XCTestCase {
    private let client = DiagnosticClient(appVersion: "0.5.0", platform: "ios", arch: "arm64", osVersion: "iOS 27")

    func testAFailedTurnKeepsTheCategoryNotTheOriginalText() {
        let queue = DiagnosticQueue(newID: { "11111111-1111-4111-8111-111111111111" }, now: { Date(timeIntervalSince1970: 10) })
        let secret = "timeout talking to user@example.com about sk-secretkey and /Users/a/secret.txt"
        queue.observe([FailedTurn(id: "turn-1", error: secret, model: "sol")], consent: true, client: client)
        let body = queue.payload(consent: true, serviceEnabled: true)
        let report = body?["reports"].array?.first
        XCTAssertEqual(report?["kind"].string, "turn_error")
        XCTAssertEqual(report?["code"].string, "TURN_TIMEOUT")
        XCTAssertEqual(report?["message"].string, "timeout")
        let encoded = String(describing: body)
        XCTAssertFalse(encoded.contains("user@example.com"))
        XCTAssertFalse(encoded.contains("sk-secretkey"))
        XCTAssertFalse(encoded.contains("/Users/a"))
        XCTAssertEqual(body?["consent"].bool, true)
    }

    func testNothingIsOfferedWithoutConsentOrCollection() {
        let queue = DiagnosticQueue(newID: { "11111111-1111-4111-8111-111111111111" }, now: { Date(timeIntervalSince1970: 10) })
        queue.observe([FailedTurn(id: "turn-1", error: "connection reset", model: "sol")], consent: true, client: client)
        XCTAssertNil(queue.payload(consent: true, serviceEnabled: false))
        XCTAssertEqual(queue.pendingIDs, ["11111111-1111-4111-8111-111111111111"])
        XCTAssertNil(queue.payload(consent: false, serviceEnabled: true))
        XCTAssertTrue(queue.pendingIDs.isEmpty)
    }

    func testAnOldFailureIsNotUploadedAfterConsent() {
        let queue = DiagnosticQueue(newID: { "22222222-2222-4222-8222-222222222222" }, now: { Date(timeIntervalSince1970: 10) })
        queue.observe([FailedTurn(id: "old", error: "overloaded", model: "sol")], consent: false, client: client)
        queue.observe([
            FailedTurn(id: "old", error: "overloaded", model: "sol"),
            FailedTurn(id: "new", error: "429 too many requests", model: "sol"),
        ], consent: true, client: client)
        let rows = queue.payload(consent: true, serviceEnabled: true)?["reports"].array
        XCTAssertEqual(rows?.count, 1)
        XCTAssertEqual(rows?.first?["code"].string, "TURN_RATE_LIMITED")
    }

    func testCollectionIsOnlyABooleanTrue() {
        XCTAssertTrue(DiagnosticPolicy.serviceCollectsDiagnostics(.object(["data": .object(["features": .object(["diagnostics": .bool(true)])])])))
        XCTAssertFalse(DiagnosticPolicy.serviceCollectsDiagnostics(.object(["features": .object(["diagnostics": .string("true")])])))
        XCTAssertFalse(DiagnosticPolicy.serviceCollectsDiagnostics(.object([:])))
    }

    func testAPathIsRemovedFromAMessage() {
        XCTAssertEqual(DiagnosticPolicy.describeTurnError("The Claudex service is unreachable.")?.code, "TURN_CLIENT")
        XCTAssertEqual(DiagnosticPolicy.redactMessage("see src/app/file.ts"), "see [path]")
    }

    func testARatingCarriesNoConversation() {
        let queue = DiagnosticQueue(newID: { "33333333-3333-4333-8333-333333333333" }, now: { Date(timeIntervalSince1970: 10) })
        queue.recordFeedback("cleared", model: "the prompt stays on the phone", client: client)
        XCTAssertTrue(queue.pendingFeedbackIDs.isEmpty)
        queue.recordFeedback("up", model: "sol", client: client)
        XCTAssertNil(queue.feedbackPayload(consent: true, serviceEnabled: false))
        let body = queue.feedbackPayload(consent: true, serviceEnabled: true)
        XCTAssertEqual(body?["rating"].string, "up")
        XCTAssertEqual(body?["conversation_excerpt"], .null)
        XCTAssertEqual(body?["comment"].string, "")
        XCTAssertFalse(String(describing: body).contains("prompt"))
        XCTAssertNil(queue.feedbackPayload(consent: false, serviceEnabled: true))
        XCTAssertTrue(queue.pendingFeedbackIDs.isEmpty)
        XCTAssertTrue(DiagnosticPolicy.serviceCollectsFeedback(.object(["data": .object(["features": .object(["feedback": .bool(true)])])])))
        XCTAssertFalse(DiagnosticPolicy.serviceCollectsFeedback(.object(["features": .object(["feedback": .string("true")])])))
    }

    func testAQueuedReportSurvivesARestartWithoutTheOriginalText() throws {
        let secret = "timeout talking to user@example.com about sk-secretkey and /Users/a/secret.txt"
        let queue = DiagnosticQueue(newID: { "11111111-1111-4111-8111-111111111111" }, now: { Date(timeIntervalSince1970: 10) })
        queue.observe([FailedTurn(id: "turn-1", error: secret, model: "sol")], consent: true, client: client)
        queue.recordFeedback("up", model: "sol", client: client)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let account = "person@example.com"
        let file = DiagnosticQueueFile.location(directory: directory, account: account)
        XCTAssertFalse(file.path.contains("person@example.com"))
        XCTAssertNotEqual(file, DiagnosticQueueFile.location(directory: directory, account: "other@example.com"))
        DiagnosticQueueFile.store(file, queue: queue, consent: true)
        let stored = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(stored.contains("user@example.com"))
        XCTAssertFalse(stored.contains("sk-secretkey"))
        XCTAssertFalse(stored.contains("/Users/a"))
        XCTAssertFalse(stored.contains("person@example.com"))
        let revived = DiagnosticQueue(newID: { "22222222-2222-4222-8222-222222222222" }, now: { Date(timeIntervalSince1970: 10) })
        DiagnosticQueueFile.load(file, queue: revived)
        let report = revived.payload(consent: true, serviceEnabled: true)?["reports"].array?.first
        XCTAssertEqual(report?["code"].string, "TURN_TIMEOUT")
        XCTAssertEqual(report?["message"].string, "timeout")
        XCTAssertEqual(revived.feedbackPayload(consent: true, serviceEnabled: true)?["rating"].string, "up")
        revived.observe([FailedTurn(id: "turn-1", error: secret, model: "sol")], consent: true, client: client)
        XCTAssertEqual(revived.payload(consent: true, serviceEnabled: true)?["reports"].array?.count, 1)
        try? FileManager.default.removeItem(at: directory)
    }

    func testConsentOffKeepsTheTurnSeenAndDropsTheReport() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = DiagnosticQueueFile.location(directory: directory, account: "person@example.com")
        let queue = DiagnosticQueue(newID: { "11111111-1111-4111-8111-111111111111" }, now: { Date(timeIntervalSince1970: 10) })
        queue.observe([FailedTurn(id: "old", error: "overloaded", model: "sol")], consent: false, client: client)
        DiagnosticQueueFile.store(file, queue: queue, consent: false)
        let stored = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(stored.contains("TURN_"))
        XCTAssertFalse(stored.contains("overloaded"))
        let revived = DiagnosticQueue(newID: { "22222222-2222-4222-8222-222222222222" }, now: { Date(timeIntervalSince1970: 10) })
        DiagnosticQueueFile.load(file, queue: revived)
        revived.observe([
            FailedTurn(id: "old", error: "overloaded", model: "sol"),
            FailedTurn(id: "new", error: "429 too many requests", model: "sol"),
        ], consent: true, client: client)
        let rows = revived.payload(consent: true, serviceEnabled: true)?["reports"].array
        XCTAssertEqual(rows?.count, 1)
        XCTAssertEqual(rows?.first?["code"].string, "TURN_RATE_LIMITED")
        try? FileManager.default.removeItem(at: directory)
    }

    func testADamagedQueueIsDeleted() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = DiagnosticQueueFile.location(directory: directory, account: "person@example.com")
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let damaged = #"{"version":1,"diagnostics":[{"id":"11111111-1111-4111-8111-111111111111","turn_id":"turn-1","occurred_at":1,"code":"TURN_TIMEOUT","message":"user@example.com","model":"sol","app_version":"1","platform":"ios","arch":"arm64","os_version":"iOS 27"}],"feedback":[],"seen":[]}"#
        try? damaged.data(using: .utf8)?.write(to: file)
        let revived = DiagnosticQueue()
        DiagnosticQueueFile.load(file, queue: revived)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertTrue(revived.pendingIDs.isEmpty)
        try? FileManager.default.removeItem(at: directory)
    }

    func testACrashKeepsTheTypeAndDropsTheMessage() {
        let crashed = DiagnosticQueue(newID: { "44444444-4444-4444-8444-444444444444" }, now: { Date(timeIntervalSince1970: 10) })
        crashed.recordCrash("IllegalStateException", frames: ["AppStore.swift:10", "/Users/a/secret.txt:3", "user@example.com said sk-secret"], client: client)
        crashed.recordCrash("user@example.com", frames: [], client: client)
        let report = crashed.payload(consent: true, serviceEnabled: true)?["reports"].array?.first
        XCTAssertEqual(report?["kind"].string, "crash")
        XCTAssertEqual(report?["code"].string, "IllegalStateException")
        XCTAssertEqual(report?["message"].string, "IllegalStateException at AppStore.swift:10")
        let stored = String(describing: crashed.document())
        XCTAssertFalse(stored.contains("/Users/a"))
        XCTAssertFalse(stored.contains("user@example.com"))
        XCTAssertFalse(stored.contains("sk-secret"))
        let revived = DiagnosticQueue(now: { Date(timeIntervalSince1970: 10) })
        XCTAssertTrue(revived.restore(crashed.document()))
        let rows = revived.payload(consent: true, serviceEnabled: true)?["reports"].array
        XCTAssertEqual(rows?.first?["kind"].string, "crash")
        XCTAssertEqual(rows?.last?["code"].string, "Error")
    }
}
