import Foundation

/// Native adapter for shared/composer-api.ts and src/composer/queue.ts.
/// No transcript rendering or new transport protocol lives here.
public struct SteerResult: Codable, Sendable {
    public let messageId: String
    public let conversation: Conversation
}

public struct QueuedComposerMessage: Identifiable, Sendable, Equatable {
    public enum State: String, Sendable { case queued, steered }
    public let id: UUID
    public let text: String
    public let attachments: [Attachment]
    public let mode: ChatMode
    public let providerID: String
    public let model: String
    public let webSearch: Bool
    public var state: State
    public var messageID: String?
    public var error: String?
    public init(text: String, attachments: [Attachment], conversation: Conversation,
                webSearch: Bool, state: State, messageID: String? = nil) {
        id = UUID(); self.text = text; self.attachments = attachments
        mode = conversation.mode; providerID = conversation.providerId; model = conversation.model
        self.webSearch = webSearch; self.state = state; self.messageID = messageID
    }
    public func input(conversationID: String) -> SendInput {
        SendInput(conversationId: conversationID, text: text, mode: mode,
                  attachments: attachments, providerId: providerID, model: model, webSearch: webSearch)
    }
}

/// Owned by one AppStore account generation; switching chats keeps its queues,
/// account invalidation resets them. An unconfirmed mutation remains failed and
/// cannot be replayed by later events, snapshots or foreground transitions.
public struct ComposerQueue: Sendable {
    public struct Lease: Sendable {
        public let epoch: UUID
        public let conversationID: String
        public let entry: QueuedComposerMessage
    }
    private var epoch = UUID()
    private var queues: [String: [QueuedComposerMessage]] = [:]
    private var sending: [String: UUID] = [:]
    public init() {}
    public var conversationIDs: Set<String> { Set(queues.keys) }
    public var allEntries: [QueuedComposerMessage] { queues.values.flatMap { $0 } }
    public func entries(_ conversationID: String) -> [QueuedComposerMessage] { queues[conversationID] ?? [] }
    public func isSending(_ conversationID: String) -> Bool { sending[conversationID] != nil }
    public mutating func reset() { epoch = UUID(); queues = [:]; sending = [:] }
    public mutating func add(_ entry: QueuedComposerMessage, conversationID: String) {
        queues[conversationID, default: []].append(entry)
    }
    @discardableResult public mutating func remove(_ id: UUID, conversationID: String) -> Bool {
        guard sending[conversationID] != id else { return false }
        let old = entries(conversationID)
        set(old.filter { $0.id != id }, conversationID: conversationID)
        return old.contains { $0.id == id }
    }
    public mutating func removeConversation(_ id: String) { queues.removeValue(forKey: id); sending.removeValue(forKey: id) }
    public mutating func reconcile(_ conversation: Conversation) {
        // A slim/truncated transcript cannot prove an accepted steer was unread.
        guard conversation.slim != true else { return }
        let delivered = Set(conversation.turns.flatMap(\.items).compactMap { item -> String? in
            guard item.type == "userMessage", item.raw["steered"].bool == true else { return nil }
            return item.raw["clientId"].string
        })
        let next = entries(conversation.id).compactMap { original -> QueuedComposerMessage? in
            guard original.state == .steered else { return original }
            if let id = original.messageID, delivered.contains(id) { return nil }
            var entry = original
            if !conversation.isRunning { entry.state = .queued }
            return entry
        }
        set(next, conversationID: conversation.id)
    }
    public mutating func beginNext(_ conversation: Conversation) -> Lease? {
        reconcile(conversation)
        let entries = entries(conversation.id)
        guard conversation.slim != true, !conversation.isRunning, !isSending(conversation.id),
              !entries.contains(where: { $0.state == .steered }), let next = entries.first,
              next.state == .queued, next.error == nil else { return nil }
        sending[conversation.id] = next.id
        return Lease(epoch: epoch, conversationID: conversation.id, entry: next)
    }
    public mutating func beginManualSteer(_ id: UUID, conversationID: String) -> Lease? {
        guard !isSending(conversationID), let entry = entries(conversationID).first(where: { $0.id == id }),
              entry.state == .queued else { return nil }
        sending[conversationID] = id
        return Lease(epoch: epoch, conversationID: conversationID, entry: entry)
    }
    /// Only before starting the RPC: returning to background must not consume
    /// or fail a draft. Never release an already dispatched mutation for replay.
    public mutating func releaseBeforeDispatch(_ lease: Lease) {
        guard lease.epoch == epoch, sending[lease.conversationID] == lease.entry.id else { return }
        sending.removeValue(forKey: lease.conversationID)
    }
    @discardableResult public mutating func completeSteer(_ lease: Lease, messageID: String) -> Bool {
        guard !messageID.isEmpty, lease.epoch == epoch, sending[lease.conversationID] == lease.entry.id else { return false }
        sending.removeValue(forKey: lease.conversationID)
        set(entries(lease.conversationID).map { original in
            guard original.id == lease.entry.id else { return original }
            var entry = original; entry.state = .steered; entry.messageID = messageID; entry.error = nil
            return entry
        }, conversationID: lease.conversationID)
        return true
    }
    /// Returns false for stale account leases; callers must also reject stale
    /// account responses before changing their snapshot or navigation.
    @discardableResult public mutating func complete(_ lease: Lease, error: String? = nil) -> Bool {
        guard lease.epoch == epoch, sending[lease.conversationID] == lease.entry.id else { return false }
        sending.removeValue(forKey: lease.conversationID)
        set(entries(lease.conversationID).compactMap { original in
            guard original.id == lease.entry.id else { return original }
            guard let error else { return nil }
            var entry = original; entry.error = error; return entry
        }, conversationID: lease.conversationID)
        return true
    }
    private mutating func set(_ entries: [QueuedComposerMessage], conversationID: String) {
        if entries.isEmpty { queues.removeValue(forKey: conversationID) }
        else { queues[conversationID] = entries }
    }
}
