import Foundation

public enum TranscriptLoadState: Equatable, Sendable {
    case loading
    case failed(String)
}

/// Main-actor transcript merge coordinator shared by the app and portable tests.
/// A fetch is permitted once per explicit source revision; delta events never
/// recursively schedule more requests. Context checks are independent of Task
/// cancellation because a completed transport may ignore cancellation.
@MainActor
public final class ConversationHydrator {
    public typealias Fetch = @Sendable (String) async throws -> ConversationTurns
    public private(set) var states: [String: TranscriptLoadState] = [:]
    public var onHydrated: ((Conversation) -> Void)?
    public var onStateChanged: (() -> Void)?
    public var onFailure: ((Error) -> Void)?
    private let fetch: Fetch
    private var conversations: [String: Conversation] = [:]
    private var revisions: [String: UInt64] = [:]
    private var requested: [String: UInt64] = [:]
    private var attempted: [String: UInt64] = [:]
    private var requests: [String: Request] = [:]
    private var sessionGeneration: UInt64 = 0
    private var selectionGeneration: UInt64 = 0
    private var selectedID: String?
    private var clock: UInt64 = 0

    private struct Ticket {
        let id: UUID
        let conversationID: String
        let session: UInt64
        let selection: UInt64
        let revision: UInt64
    }
    private struct Request { let ticket: Ticket; var task: Task<Void, Never>? }

    public init(fetch: @escaping Fetch) { self.fetch = fetch }

    /// Every authoritative snapshot is a new revision even if updatedAt is equal.
    /// changedIDs forces invalidation for a newer accepted WS event with equal fields.
    public func observe(_ values: [Conversation], snapshotReplacement: Bool = false,
                        changedIDs: Set<String> = [], requestSelected: Bool = true) {
        let incoming = Dictionary(values.map { ($0.id, $0) }, uniquingKeysWith: { _, next in next })
        for id in conversations.keys where incoming[id] == nil {
            cancel(id); revisions[id] = nil; requested[id] = nil; attempted[id] = nil
        }
        for (id, value) in incoming {
            if snapshotReplacement || changedIDs.contains(id) || conversations[id] != value {
                clock &+= 1; revisions[id] = clock
            }
            if value.slim != true { cancel(id); requested[id] = nil; attempted[id] = nil }
        }
        conversations = incoming
        if requestSelected, let id = selectedID, incoming[id]?.slim == true {
            requested[id] = revisions[id]
            schedule(id)
        }
        onStateChanged?()
    }

    public func select(_ id: String?) {
        guard selectedID != id else { return }
        if let previous = selectedID { cancel(previous) }
        selectionGeneration &+= 1; selectedID = id
        if let id, conversations[id]?.slim == true {
            attempted[id] = nil; requested[id] = revisions[id]; schedule(id)
        }
        onStateChanged?()
    }

    /// Explicit retry after an error; ordinary re-renders never call this.
    public func retry(_ id: String) {
        guard selectedID == id, conversations[id]?.slim == true, requests[id] == nil else { return }
        attempted[id] = nil; requested[id] = revisions[id]; schedule(id)
    }

    /// Protects pending fetches while a reconnect/resync has not produced its baseline yet.
    public func invalidateSource() {
        for id in conversations.keys { clock &+= 1; revisions[id] = clock }
        requested.removeAll()
    }

    public func reset() {
        sessionGeneration &+= 1; selectionGeneration &+= 1
        for request in requests.values { request.task?.cancel() }
        requests.removeAll(); conversations.removeAll(); revisions.removeAll()
        requested.removeAll(); attempted.removeAll(); states.removeAll(); selectedID = nil
        onStateChanged?()
    }

    private func cancel(_ id: String) {
        requests.removeValue(forKey: id)?.task?.cancel(); states[id] = nil
    }

    private func schedule(_ id: String) {
        guard id == selectedID, conversations[id]?.slim == true,
              let revision = revisions[id], requested[id] == revision,
              attempted[id] != revision, requests[id] == nil else { return }
        attempted[id] = revision
        let ticket = Ticket(id: UUID(), conversationID: id, session: sessionGeneration,
                            selection: selectionGeneration, revision: revision)
        requests[id] = Request(ticket: ticket, task: nil); states[id] = .loading
        let fetch = self.fetch
        requests[id]?.task = Task { [weak self] in
            do { let value = try await fetch(id); self?.finish(ticket, result: .success(value)) }
            catch { self?.finish(ticket, result: .failure(error)) }
        }
        onStateChanged?()
    }

    private func finish(_ ticket: Ticket, result: Result<ConversationTurns, Error>) {
        let id = ticket.conversationID
        guard requests[id]?.ticket.id == ticket.id else { return }
        requests[id] = nil
        guard ticket.session == sessionGeneration, ticket.selection == selectionGeneration,
              selectedID == id, var conversation = conversations[id], conversation.slim == true else {
            states[id] = nil; onStateChanged?(); return
        }
        guard revisions[id] == ticket.revision else {
            states[id] = .failed(CoreText.string(.somethingWentWrongTryAgain))
            // Coalesce explicit full-snapshot/full-conversation updates into at most
            // one latest request. A turn delta alone never causes a refetch loop.
            schedule(id); onStateChanged?(); return
        }
        switch result {
        case .success(let full):
            conversation.turns = full.turns
            conversation.savedBranches = full.savedBranches
            conversation.slim = nil
            conversations[id] = conversation; states[id] = nil
            onHydrated?(conversation)
        case .failure(let error):
            states[id] = .failed(CoreText.string(.somethingWentWrongTryAgain))
            onFailure?(error)
        }
        onStateChanged?()
    }
}
