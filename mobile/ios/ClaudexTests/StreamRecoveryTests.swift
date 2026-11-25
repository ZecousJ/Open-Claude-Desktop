import XCTest
#if SWIFT_PACKAGE
import ClaudexCore
#else
@testable import Claudex
#endif

final class StreamRecoveryTests: XCTestCase {
    private func event(_ seq: Int) -> JSONValue {
        .object(["t": .string("event"), "seq": .number(Double(seq)), "event": .object(["type": .string("engine"), "engine": .object(["sequence": .number(Double(seq))])])])
    }
    private func state() throws -> Snapshot {
        try JSONDecoder().decode(Snapshot.self, from: Data(#"{"settings":{"name":"LOCAL_RECOVERY","providers":[],"effort":"high"},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}"#.utf8))
    }
    func testGapSnapshotCoversOldCursorAndLaterEventsContinue() throws {
        var reducer = StreamReducer(), recovery = StreamRecovery()
        let snapshot = try state()
        _ = try reducer.apply(.object(["t": .string("snapshot"), "seq": .number(10), "snapshot": try .encode(snapshot)]))
        XCTAssertEqual(try reducer.apply(event(13)), .resync)
        recovery.observe(event(13)); XCTAssertTrue(recovery.begin())
        let covered = recovery.beginRead()
        recovery.buffer(event(14)); recovery.buffer(event(15))
        reducer.recover(snapshot, covering: covered)
        for frame in recovery.drain() { XCTAssertEqual(try reducer.apply(frame), .changed) }
        XCTAssertEqual(reducer.lastSequence, 15)
        XCTAssertEqual(reducer.snapshot?.engine["sequence"].number, 15)
        XCTAssertEqual(try reducer.apply(event(14)), .none)
        XCTAssertFalse(reducer.needsResync)
    }
    func testRecoveryNeverMovesBehindAcceptedCursor() throws {
        var reducer = StreamReducer()
        reducer.recover(try state(), covering: 20)
        reducer.recover(try state(), covering: 12)
        XCTAssertEqual(reducer.lastSequence, 20)
    }
    func testOverflowIsBoundedAndRequestsAnotherSnapshot() {
        var recovery = StreamRecovery(capacity: 2)
        XCTAssertTrue(recovery.begin()); _ = recovery.beginRead()
        for i in 1...10 { recovery.buffer(event(i)) }
        XCTAssertTrue(recovery.overflowed)
        XCTAssertLessThanOrEqual(recovery.drain().count, 2)
        XCTAssertTrue(recovery.begin()); XCTAssertEqual(recovery.beginRead(), 10)
        XCTAssertFalse(recovery.overflowed)
    }
    func testRepeatedUnrecoverableGapsHaveFiniteReadBudget() {
        var recovery = StreamRecovery(maximumAttempts: 3)
        for _ in 0..<3 { XCTAssertTrue(recovery.begin()); _ = recovery.beginRead() }
        for _ in 0..<100 { XCTAssertFalse(recovery.begin()) }
        XCTAssertTrue(recovery.blocked); XCTAssertEqual(recovery.attempts, 3)
        recovery.recovered(); XCTAssertTrue(recovery.begin())
    }
    func testFailedReadDoesNotRetryOnEveryStreamingFrame() {
        var recovery = StreamRecovery()
        XCTAssertTrue(recovery.begin()); recovery.failed()
        for i in 1...100 { recovery.observe(event(i)); XCTAssertFalse(recovery.begin()) }
        XCTAssertEqual(recovery.attempts, 1)
        recovery.reset(); XCTAssertTrue(recovery.begin())
    }
    func testSocketRetriesKeepGoingWithCappedDelay() {
        for attempt in 0..<100 {
            XCTAssertTrue(ReconnectPolicy.shouldRetry(closeCode: 1006, attempt: attempt))
            XCTAssertLessThanOrEqual(ReconnectPolicy.delay(attempt: attempt), 30)
        }
        for code in [4003, 4008, 4400] { XCTAssertFalse(ReconnectPolicy.shouldRetry(closeCode: code, attempt: 0)) }
    }
}

final class SnapshotSequenceTests: XCTestCase {
    func testHeaderParsingAcceptsOnlyWholeSafeIntegers() {
        XCTAssertEqual(SnapshotSequence.parse("25"), 25)
        XCTAssertEqual(SnapshotSequence.parse("0"), 0)
        for value in [nil, "", "-1", "1.5", "9007199254740992", "abc", "12345678901234567"] {
            XCTAssertNil(SnapshotSequence.parse(value), String(describing: value))
        }
    }
}
