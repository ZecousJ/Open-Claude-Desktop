import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// Official composer rules: placeholder, trailing action, pill width, dictation merge, waveform geometry and the
/// usage-limit card. Portable: `swift test` and Xcode.
final class ComposerPresentationTests: XCTestCase {
  typealias P = ComposerPresentation

  func testPlaceholderFollowsTheOfficialOrder() {
    XCTAssertEqual(P.hint(sending: false, newChat: true, projectName: nil, holdToTalk: false), .init("chat_input_hint"))
    XCTAssertEqual(
      P.hint(sending: false, newChat: true, projectName: "Docs", holdToTalk: false), .init("chat_input_hint_in_project", "Docs"))
    XCTAssertEqual(P.hint(sending: false, newChat: false, projectName: nil, holdToTalk: false), .init("chat_input_hint_reply"))
    XCTAssertEqual(
      P.hint(sending: false, newChat: false, projectName: "Docs", holdToTalk: false),
      .init("chat_input_hint_reply_in_project", "Docs"))
    XCTAssertEqual(P.hint(sending: true, newChat: false, projectName: "Docs", holdToTalk: false), .init("chat_input_hint_sending"))
    XCTAssertEqual(P.hint(sending: false, newChat: false, projectName: "", holdToTalk: false), .init("chat_input_hint_reply"))
    // Hold-to-talk replaces every other hint.
    XCTAssertEqual(P.hint(sending: false, newChat: true, projectName: "Docs", holdToTalk: true), .init("type_or_hold_to_talk"))
    XCTAssertEqual(P.hint(sending: false, newChat: false, projectName: nil, holdToTalk: true), .init("reply_or_hold_to_talk"))
  }

  func testTrailingAction() {
    XCTAssertEqual(P.action(hasContent: true, responding: false), .send)
    XCTAssertEqual(P.action(hasContent: true, responding: true), .send, "typing while Claude replies queues the message")
    XCTAssertEqual(P.action(hasContent: false, responding: true), .stop)
    XCTAssertEqual(P.action(hasContent: false, responding: false), .none)
  }

  func testModelPillWidth() {
    XCTAssertEqual(P.modelPillMaxWidth(screenWidth: 390, fontScale: 1), 220)
    XCTAssertEqual(P.modelPillMaxWidth(screenWidth: 300, fontScale: 1), 220)
    XCTAssertEqual(P.modelPillMaxWidth(screenWidth: 390, fontScale: 1.3), 262)
    XCTAssertEqual(P.modelPillMaxWidth(screenWidth: 390, fontScale: 0.8), 220, "font scale below 1 counts as 1")
  }

  func testDictationMerge() {
    XCTAssertEqual(P.merge(prefix: "", transcript: " 你好 "), "你好")
    XCTAssertEqual(P.merge(prefix: "Hello", transcript: "world"), "Hello world")
    XCTAssertEqual(P.merge(prefix: "Hello ", transcript: "world"), "Hello world")
    XCTAssertEqual(P.merge(prefix: "Hello", transcript: "  "), "Hello")
    XCTAssertEqual(P.merge(prefix: "  ", transcript: "world"), "world")
  }

  func testWaveformGeometry() {
    XCTAssertEqual(DictationWaveform.capacity(width: 0), 0)
    XCTAssertEqual(DictationWaveform.capacity(width: 3), 1)
    XCTAssertEqual(DictationWaveform.capacity(width: 117), 20)
    // Middle bars: full ellipse factor; silence = 3pt minimum, loudest = full height.
    XCTAssertEqual(DictationWaveform.barHeight(level: 0, index: 10, count: 20), 3, accuracy: 0.0001)
    XCTAssertEqual(DictationWaveform.barHeight(level: 1, index: 10, count: 20), 25, accuracy: 0.0001)
    XCTAssertEqual(DictationWaveform.barHeight(level: 2, index: 10, count: 20), 25, accuracy: 0.0001)
    // The three outermost bars at each end fade, symmetrically and monotonically.
    let edge = (0..<4).map { DictationWaveform.barHeight(level: 1, index: $0, count: 20) }
    XCTAssertLessThan(edge[0], edge[1])
    XCTAssertLessThan(edge[1], edge[2])
    XCTAssertLessThan(edge[2], edge[3])
    XCTAssertEqual(edge[3], 25, accuracy: 0.0001)
    XCTAssertEqual(
      DictationWaveform.barHeight(level: 1, index: 19, count: 20), edge[0], accuracy: 0.0001)
    XCTAssertEqual(DictationWaveform.level(rms: 0), 0)
    XCTAssertEqual(DictationWaveform.level(rms: 1), 1, accuracy: 0.0001)
    XCTAssertEqual(DictationWaveform.level(rms: .nan), 0)
    XCTAssertEqual(DictationWaveform.level(rms: 0.001), 0)
  }

  func testUsageLimitNotice() throws {
    func usage(_ windows: [(Double, Double?)]) -> JSONValue {
      .object([
        "windows": .array(windows.map { percent, reset in
          var fields: [String: JSONValue] = ["percent": .number(percent), "label": .string("5h")]
          if let reset { fields["resetsAt"] = .number(reset) }
          return .object(fields)
        })
      ])
    }
    XCTAssertNil(UsageLimitNotice.from(.null))
    XCTAssertNil(UsageLimitNotice.from(usage([(40, nil), (89.9, nil)])))
    let approaching = try XCTUnwrap(UsageLimitNotice.from(usage([(40, nil), (92, 1_800_000_000_000)])))
    XCTAssertEqual(approaching.kind, .approaching)
    XCTAssertEqual(approaching.resetsAt, Date(timeIntervalSince1970: 1_800_000_000))
    let reached = try XCTUnwrap(UsageLimitNotice.from(usage([(95, nil), (100, nil)])))
    XCTAssertEqual(reached.kind, .reached)
    XCTAssertNil(reached.resetsAt)
  }
}
