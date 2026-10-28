import Foundation

/// Pure rules behind the official home composer, kept out of SwiftUI so `swift test` covers them.
public enum ComposerPresentation {
  // MARK: Placeholder

  /// The catalogue key and argument of the field's placeholder.
  public struct Hint: Equatable, Sendable {
    public let key: String
    public let argument: String?
    public init(_ key: String, _ argument: String? = nil) {
      self.key = key
      self.argument = argument
    }
  }

  public static func hint(sending: Bool, newChat: Bool, projectName: String?, holdToTalk: Bool) -> Hint {
    if holdToTalk { return Hint(newChat ? "type_or_hold_to_talk" : "reply_or_hold_to_talk") }
    if sending { return Hint("chat_input_hint_sending") }
    let project = projectName.flatMap { $0.isEmpty ? nil : $0 }
    switch (newChat, project) {
    case (true, nil): return Hint("chat_input_hint")
    case (true, let name?): return Hint("chat_input_hint_in_project", name)
    case (false, nil): return Hint("chat_input_hint_reply")
    case (false, let name?): return Hint("chat_input_hint_reply_in_project", name)
    }
  }

  // MARK: Trailing action

  public enum Action: Equatable, Sendable { case send, stop, none }

  /// Text or attachments → Send (also while Claude replies: the message waits); replying with
  /// nothing typed → Stop; otherwise nothing (the official Voice Mode slot, which Claudex lacks).
  public static func action(hasContent: Bool, responding: Bool) -> Action {
    if hasContent { return .send }
    return responding ? .stop : .none
  }

  // MARK: Model pill

  /// `min(220 × fontScale(≥1), max(screenWidth − 128, 220))`.
  public static func modelPillMaxWidth(screenWidth: Double, fontScale: Double) -> Double {
    min(220 * max(fontScale, 1), max(screenWidth - 128, 220))
  }

  // MARK: Dictation text

  /// The field after dictation: what was typed before, a space, then the transcript.
  public static func merge(prefix: String, transcript: String) -> String {
    let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !spoken.isEmpty else { return prefix }
    let typed = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
    if typed.isEmpty { return spoken }
    let separator = prefix.last?.isWhitespace == true ? "" : " "
    return prefix + separator + spoken
  }
}

// MARK: Waveform

public enum DictationWaveform {
  public static let barWidth = 3.0
  public static let gap = 3.0
  public static let height = 25.0
  public static let minimumBar = 3.0
  /// One bar per 60 ms of audio.
  public static let sampleInterval = 0.06
  /// Silence (or no sample) for longer than this draws the secondary colour.
  public static let silenceInterval = 0.75

  /// How many bars fit a width (pitch 6pt).
  public static func capacity(width: Double) -> Int {
    max(0, Int((width + gap) / (barWidth + gap)))
  }

  /// Bar height: `(level × (H − 3) + 3) × sqrt(1 − e²)` with the three outermost bars at each
  /// end fading along an ellipse. `index` counts from the left of `count` visible bars.
  public static func barHeight(level: Double, index: Int, count: Int, height: Double = height) -> Double {
    let clamped = min(1, max(0, level))
    let fromEdge = min(index, count - 1 - index)
    let e = fromEdge >= 3 ? 0 : Double(3 - fromEdge) / 4
    return (clamped * (height - minimumBar) + minimumBar) * (1 - e * e).squareRoot()
  }

  /// A 0…1 level from an RMS amplitude (−50 dB → 0, 0 dB → 1).
  public static func level(rms: Double) -> Double {
    guard rms > 0, rms.isFinite else { return 0 }
    let decibels = 20 * log10(rms)
    return min(1, max(0, (decibels + 50) / 50))
  }
}

// MARK: Usage-limit banner

/// The rate-limit card above the composer, read from the service's `planUsage` windows.
public struct UsageLimitNotice: Equatable, Sendable {
  public enum Kind: Equatable, Sendable { case reached, approaching }
  public let kind: Kind
  /// Reset time of the window that triggered the notice.
  public let resetsAt: Date?

  /// A window at or above 100 % → limit reached; at or above `approachingPercent` → approaching.
  /// The first (most constrained) window wins.
  public static let approachingPercent = 90.0

  public static func from(_ usage: JSONValue) -> UsageLimitNotice? {
    let windows = (usage["windows"].array ?? []).compactMap { window -> (Double, Date?)? in
      guard let percent = window["percent"].number, percent.isFinite else { return nil }
      let reset = window["resetsAt"].number.map { Date(timeIntervalSince1970: $0 / 1000) }
      return (percent, reset)
    }
    guard let worst = windows.max(by: { $0.0 < $1.0 }) else { return nil }
    if worst.0 >= 100 { return UsageLimitNotice(kind: .reached, resetsAt: worst.1) }
    if worst.0 >= approachingPercent { return UsageLimitNotice(kind: .approaching, resetsAt: worst.1) }
    return nil
  }
}
