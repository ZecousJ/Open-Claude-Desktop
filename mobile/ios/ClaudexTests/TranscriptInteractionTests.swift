import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// Portable checks for the official transcript layer's native side: gesture decoding, turn
/// resolution, reply text and the collapsed steps rows.
final class TranscriptInteractionTests: XCTestCase {
    private func conversation(_ turns: String) throws -> Conversation {
        try JSONDecoder().decode(Conversation.self, from: Data(#"{"id":"c","title":"t","mode":"chat","providerId":"p","model":"m","pinned":false,"archived":false,"createdAt":1,"updatedAt":1,"turns":\#(turns)}"#.utf8))
    }

    func testDecodesOnlyWellFormedGestures() {
        let menu = TranscriptUIEvent.decode(.object(["type": .string("messageMenu"), "role": .string("user"), "index": .number(2), "prompt": .string("你好"), "x": .number(10), "y": .number(20), "retry": .bool(false), "edit": .bool(true)]))
        XCTAssertEqual(menu, .messageMenu(role: .user, place: .init(index: 2, prompt: "你好"), point: .init(x: 10, y: 20), canRetry: false, canEdit: true))
        XCTAssertEqual(TranscriptUIEvent.decode(.object(["type": .string("steps"), "index": .number(0), "prompt": .string("")])), .steps(.init(index: 0, prompt: "")))
        XCTAssertEqual(TranscriptUIEvent.decode(.object(["type": .string("share"), "index": .number(1)])), .share(.init(index: 1, prompt: "")))
        XCTAssertNil(TranscriptUIEvent.decode(.object(["type": .string("share"), "index": .number(-1)])))
        XCTAssertNil(TranscriptUIEvent.decode(.object(["type": .string("share"), "index": .number(1.5)])))
        XCTAssertNil(TranscriptUIEvent.decode(.object(["type": .string("copyText"), "index": .number(0)])))
        XCTAssertNil(TranscriptUIEvent.decode(.object(["type": .string("messageMenu"), "role": .string("system"), "index": .number(0), "x": .number(1), "y": .number(1)])))
        XCTAssertNil(TranscriptUIEvent.decode(.object(["type": .string("steps"), "index": .number(0), "prompt": .string(String(repeating: "x", count: TranscriptUIEvent.maximumPromptBytes + 1))])))
    }

    func testResolvesTurnsByRenderedPromptAndRefusesStaleRenders() throws {
        let value = try conversation(#"[{"id":"a","prompt":"一","attachments":[],"items":[],"status":"completed","createdAt":1},{"id":"b","prompt":"二\n\n第二段","attachments":[],"items":[],"status":"completed","createdAt":2},{"id":"c","prompt":"一","attachments":[],"items":[],"status":"completed","createdAt":3}]"#)
        XCTAssertEqual(TranscriptTurns.resolve(.init(index: 1, prompt: "二 第二段"), in: value)?.id, "b")
        // Same prompt twice: the one nearest the rendered position wins.
        XCTAssertEqual(TranscriptTurns.resolve(.init(index: 2, prompt: "一"), in: value)?.id, "c")
        XCTAssertEqual(TranscriptTurns.resolve(.init(index: 0, prompt: "一"), in: value)?.id, "a")
        // A rendered prompt no turn has is a stale render.
        XCTAssertNil(TranscriptTurns.resolve(.init(index: 1, prompt: "不存在"), in: value))
        XCTAssertNil(TranscriptTurns.resolve(.init(index: 9, prompt: ""), in: value))
    }

    func testReplyTextJoinsAssistantMessagesOnly() throws {
        let value = try conversation(#"[{"id":"a","prompt":"p","attachments":[],"status":"completed","createdAt":1,"items":[{"id":"r","type":"reasoning","summary":["想"]},{"id":"m1","type":"agentMessage","text":"第一段"},{"id":"x","type":"commandExecution","command":"ls"},{"id":"m2","type":"agentMessage","text":"第二段"},{"id":"m3","type":"agentMessage","text":"  "}]}]"#)
        XCTAssertEqual(TranscriptTurns.replyText(value.turns[0]), "第一段\n\n第二段")
    }

    func testStepsFollowTheTurnItems() throws {
        let value = try conversation(#"[{"id":"a","prompt":"p","attachments":[],"status":"completed","createdAt":1,"items":[{"id":"r","type":"reasoning","summary":["先想一下\n细节"],"content":["完整推理"]},{"id":"w","type":"webSearch","query":"swift print"},{"id":"x","type":"commandExecution","command":"ls -la","aggregatedOutput":"a\nb","status":"completed"},{"id":"f","type":"fileChange","changes":[{"path":"src/a.swift","diff":"+1"}],"status":"failed"},{"id":"t","type":"mcpToolCall","server":"docs","tool":"search","arguments":{"q":"x"},"result":{"ok":true},"status":"completed"},{"id":"m","type":"agentMessage","text":"回答"}]}]"#)
        let steps = TranscriptSteps.steps(value.turns[0])
        XCTAssertEqual(steps.map(\.kind), [.thinking, .search, .command, .fileChange, .tool])
        XCTAssertEqual(steps[0].subject, "先想一下")
        XCTAssertEqual(steps[0].response, "先想一下\n细节\n\n完整推理")
        XCTAssertEqual(steps[1].subject, "swift print")
        XCTAssertEqual(steps[2].request, "ls -la")
        XCTAssertEqual(steps[2].response, "a\nb")
        XCTAssertEqual(steps[3].state, .failed)
        XCTAssertEqual(steps[3].subject, "src/a.swift")
        XCTAssertEqual(steps[4].subject, "search · docs")
        XCTAssertTrue(steps[4].request.contains("\"q\""))
        XCTAssertFalse(steps.contains { $0.truncated })
    }

    func testLongOutputIsMarkedTruncated() throws {
        let long = String(repeating: "x", count: TranscriptSteps.maximumText + 10)
        let value = try conversation(#"[{"id":"a","prompt":"p","attachments":[],"status":"completed","createdAt":1,"items":[{"id":"x","type":"commandExecution","command":"cat","aggregatedOutput":"\#(long)"}]}]"#)
        let step = try XCTUnwrap(TranscriptSteps.steps(value.turns[0]).first)
        XCTAssertTrue(step.truncated)
        XCTAssertEqual(step.response.count, TranscriptSteps.maximumText)
    }
}
