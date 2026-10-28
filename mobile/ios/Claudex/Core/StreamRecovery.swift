import Foundation

/// HTTP snapshots have no atomic event cursor. Cover only events observed before
/// the read starts, then replay later frames. A server snapshot remains preferable.
public struct StreamRecovery: Sendable {
    public private(set) var observedSequence: Int?
    public private(set) var attempts = 0
    public private(set) var blocked = false
    public private(set) var overflowed = false
    private var frames: [JSONValue] = []
    public let capacity: Int
    public let maximumAttempts: Int
    public init(capacity: Int = 2_000, maximumAttempts: Int = 3) {
        self.capacity = max(1, capacity); self.maximumAttempts = max(1, maximumAttempts)
    }
    public mutating func observe(_ frame: JSONValue) {
        guard ["ready", "snapshot", "event"].contains(frame["t"].string ?? "") else { return }
        if frame["t"].string == "event", (frame["event"]["type"].string ?? "").isEmpty { return }
        guard let value = frame["seq"].number, value >= (frame["t"].string == "event" ? 1 : 0),
              value <= 9_007_199_254_740_991, value.rounded() == value else { return }
        observedSequence = max(observedSequence ?? 0, Int(value))
    }
    public mutating func buffer(_ frame: JSONValue) {
        observe(frame)
        if frames.count == capacity { frames.removeAll(); overflowed = true }
        frames.append(frame)
    }
    public mutating func begin() -> Bool {
        guard !blocked, attempts < maximumAttempts else { blocked = true; return false }
        attempts += 1
        return true
    }
    public mutating func beginRead() -> Int? {
        frames.removeAll(); overflowed = false
        return observedSequence
    }
    public mutating func drain() -> [JSONValue] {
        let result = frames; frames.removeAll(); return result
    }
    public mutating func recovered() { attempts = 0; blocked = false; overflowed = false }
    public mutating func failed() { blocked = true; frames.removeAll() }
    public mutating func reset() { self = Self(capacity: capacity, maximumAttempts: maximumAttempts) }
}
