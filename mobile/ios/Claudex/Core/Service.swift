import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum ServiceError: Error, LocalizedError, Sendable, Equatable {
    case configuration, nativeAuthenticationUnavailable, signedOut, invalidResponse, insecureURL, tooLarge, transport(String), server(String, String?), authentication(String, Int, String?)
    public var errorDescription: String? {
        switch self {
        case .configuration: CoreText.string(.serverUnexpected)
        case .nativeAuthenticationUnavailable: CoreText.string(.somethingWentWrongTryAgain)
        case .signedOut: CoreText.string(.sessionInvalid)
        case .invalidResponse: CoreText.string(.somethingWentWrongTryAgain)
        case .insecureURL: CoreText.string(.somethingWentWrongTryAgain)
        case .tooLarge: CoreText.string(.fileOverLimit)
        case .transport: CoreText.string(.cannotReachService)
        case .server(let message, let code): ServiceError.presented(message, code: code)
        case .authentication(let message, _, _): message
        }
    }
    /// The service's refusals the app words itself (as the web's catalogs and Android do).
    public static func presented(_ message: String, code: String?) -> String {
        guard code == "CLAUDEX_WEB_CAPACITY" else { return message }
        return message.hasPrefix("You already have as many runs going")
            ? CoreText.string(.runsLimit) : CoreText.string(.serviceBusy)
    }
}

/// Native authentication must be implemented by a reviewed backend session bridge.
/// The shipped provider fails closed: no web cookie extraction or Origin spoofing.
public protocol SessionProvider: Sendable {
    func accessToken() async throws -> String
    func sessionGeneration() async -> Int?
    func eventsTicket(tabID: String) async throws -> String
    func signOut() async throws
    func refreshAccessToken() async throws -> String
}
public extension SessionProvider {
    func sessionGeneration() async -> Int? { nil }
    func refreshAccessToken() async throws -> String { throw ServiceError.signedOut } }
public struct UnavailableNativeSession: SessionProvider {
    public init() {}
    public func accessToken() async throws -> String { throw ServiceError.nativeAuthenticationUnavailable }
    public func eventsTicket(tabID: String) async throws -> String { throw ServiceError.nativeAuthenticationUnavailable }
    public func signOut() async throws {}
}
public protocol HTTPTransport: Sendable {
    func execute(_ request: URLRequest) async throws -> (Data, Int)
    /// The same request with the response headers (lowercased names). Transports
    /// that cannot report them return none.
    func executeReturningHeaders(_ request: URLRequest) async throws -> (Data, Int, [String: String])
}
public extension HTTPTransport {
    func executeReturningHeaders(_ request: URLRequest) async throws -> (Data, Int, [String: String]) {
        let (data, status) = try await execute(request); return (data, status, [:])
    }
}
/// Ephemeral session; HTTP redirects are denied so bearer tokens never follow redirects.
public final class URLSessionTransport: NSObject, HTTPTransport, URLSessionTaskDelegate, @unchecked Sendable {
    public override init() { super.init() }
    public func execute(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, status, _) = try await executeReturningHeaders(request); return (data, status)
    }
    public func executeReturningHeaders(_ request: URLRequest) async throws -> (Data, Int, [String: String]) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil; config.timeoutIntervalForRequest = 120
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ServiceError.invalidResponse }
        var headers: [String: String] = [:]
        for (name, value) in response.allHeaderFields { if let name = name as? String, let value = value as? String { headers[name.lowercased()] = value } }
        return (data, response.statusCode, headers)
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
public struct RPCClient: Sendable {
    public let baseURL: URL
    public let tabID: String
    public let session: any SessionProvider
    public let transport: any HTTPTransport
    public init(baseURL: URL, tabID: String, session: any SessionProvider, transport: any HTTPTransport = URLSessionTransport()) throws {
        guard baseURL.scheme == "https", baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, ["", "/"].contains(baseURL.path) else { throw ServiceError.insecureURL }
        self.baseURL = baseURL; self.tabID = tabID; self.session = session; self.transport = transport
    }
    public func call<T: Decodable & Sendable>(_ method: String, args: [JSONValue] = [], as: T.Type) async throws -> T {
        try Task.checkCancellation()
        let generation = await session.sessionGeneration()
        do { return try await callBound(method, args: args, as: T.self, generation: generation) }
        catch { try await verifyGeneration(generation); throw error }
    }
    func verifyGeneration(_ expected: Int?) async throws {
        try Task.checkCancellation()
        let current = await session.sessionGeneration()
        guard current == expected else { throw CancellationError() }
    }
    /// Shared bearer transport for RPC, direct REST and every upload chunk. A retry remains bound to its starting session.
    func authorizedRequest(_ source: URLRequest, generation: Int?) async throws -> (Data, Int) {
        let (data, status, _) = try await authorizedRequestReturningHeaders(source, generation: generation)
        return (data, status)
    }
    func authorizedRequestReturningHeaders(_ source: URLRequest, generation: Int?) async throws -> (Data, Int, [String: String]) {
        do {
            try await verifyGeneration(generation)
            guard source.url?.scheme == baseURL.scheme, source.url?.host == baseURL.host, source.url?.port == baseURL.port else { throw ServiceError.insecureURL }
            var request = source
            let token = try await session.accessToken()
            try await verifyGeneration(generation)
            guard !token.isEmpty else { throw ServiceError.signedOut }
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            var (data, status, headers) = try await transport.executeReturningHeaders(request)
            if status == 401 {
                try await verifyGeneration(generation)
                let renewed = try await session.refreshAccessToken()
                try await verifyGeneration(generation)
                request.setValue("Bearer " + renewed, forHTTPHeaderField: "Authorization")
                (data, status, headers) = try await transport.executeReturningHeaders(request)
            }
            try await verifyGeneration(generation)
            return (data, status, headers)
        } catch { try await verifyGeneration(generation); throw error }
    }
    func callBound<T: Decodable & Sendable>(_ method: String, args: [JSONValue], as: T.Type, generation: Int?) async throws -> T {
        try await callBoundReturningHeaders(method, args: args, as: T.self, generation: generation).0
    }
    /// A call with its response headers, for the snapshot's event sequence.
    public func callReturningHeaders<T: Decodable & Sendable>(_ method: String, args: [JSONValue] = [], as: T.Type) async throws -> (T, [String: String]) {
        try Task.checkCancellation()
        let generation = await session.sessionGeneration()
        do { return try await callBoundReturningHeaders(method, args: args, as: T.self, generation: generation) }
        catch { try await verifyGeneration(generation); throw error }
    }
    func callBoundReturningHeaders<T: Decodable & Sendable>(_ method: String, args: [JSONValue], as: T.Type, generation: Int?) async throws -> (T, [String: String]) {
        guard method.range(of: "^[a-z][A-Za-z0-9]{0,63}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/v1/claudex/web/rpc/" + method))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Browser-only identity/CSRF headers are omitted for native bearer requests.
        request.setValue(tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
        request.httpBody = try JSONEncoder().encode(JSONValue.object(["args": .array(args)]))
        guard (request.httpBody?.count ?? 0) <= 1_048_576 else { throw ServiceError.tooLarge }
        let (data, status, headers) = try await authorizedRequestReturningHeaders(request, generation: generation)
        guard status != 401 else { throw ServiceError.signedOut }
        let envelope = try JSONDecoder().decode(JSONValue.self, from: data)
        guard (200..<300).contains(status), envelope["ok"].bool == true else {
            throw ServiceError.server(envelope["error"]["message"].string ?? CoreText.string(.serverUnexpected), envelope["error"]["code"].string)
        }
        return (try envelope["value"].decode(T.self), headers)
    }
}
public protocol ClaudexService: Sendable {
    func snapshot() async throws -> Snapshot
    func snapshotCoverage() async throws -> (Snapshot, Int?)
    func conversationTurns(_ id: String) async throws -> ConversationTurns
    func models() async throws -> ModelCatalog?
    func send(_ input: SendInput) async throws -> Conversation
    func steerTurn(_ conversationID: String, text: String, attachmentIDs: [String]) async throws -> SteerResult?
    func interrupt(_ conversationID: String) async throws
    func upload(name: String, data: Data) async throws -> Attachment
    func upload(name: String, data: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> Attachment
    func updateConversation(_ id: String, patch: JSONValue) async throws -> Conversation
    func saveSettings(_ settings: Settings) async throws -> Settings
}
public struct RemoteClaudexService: ClaudexService {
    public let rpc: RPCClient
    public init(rpc: RPCClient) { self.rpc = rpc }
    public func snapshot() async throws -> Snapshot { try await rpc.call("snapshot", as: Snapshot.self) }
    public func snapshotCoverage() async throws -> (Snapshot, Int?) {
        let (state, headers) = try await rpc.callReturningHeaders("snapshot", as: Snapshot.self)
        return (state, SnapshotSequence.parse(headers["x-claudex-event-seq"]))
    }
    public func conversationTurns(_ id: String) async throws -> ConversationTurns { try await rpc.call("conversationTurns", args: [.string(id)], as: ConversationTurns.self) }
    public func models() async throws -> ModelCatalog? { try await rpc.call("modelCatalog", as: Optional<ModelCatalog>.self) }
    public func send(_ input: SendInput) async throws -> Conversation { try await rpc.call("send", args: [.encode(input)], as: Conversation.self) }
    public func steerTurn(_ conversationID: String, text: String, attachmentIDs: [String]) async throws -> SteerResult? {
        guard !conversationID.isEmpty, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIDs.isEmpty,
              attachmentIDs.allSatisfy({ !$0.isEmpty }) else { throw ServiceError.invalidResponse }
        let result = try await rpc.call("steerTurn", args: [.string(conversationID), .string(text), .array(attachmentIDs.map(JSONValue.string))], as: SteerResult?.self)
        if let result, result.messageId.isEmpty || result.conversation.id != conversationID { throw ServiceError.invalidResponse }
        return result
    }
    public func interrupt(_ conversationID: String) async throws { let _: JSONValue = try await rpc.call("interrupt", args: [.string(conversationID)], as: JSONValue.self) }
    public func upload(name: String, data: Data) async throws -> Attachment { try await upload(name: name, data: data, progress: { _ in }) }
    public func updateConversation(_ id: String, patch: JSONValue) async throws -> Conversation { try await rpc.call("updateConversation", args: [.string(id), patch], as: Conversation.self) }
    public func saveSettings(_ settings: Settings) async throws -> Settings { try await rpc.call("saveSettings", args: [.encode(settings)], as: Settings.self) }
}
public struct UnavailableClaudexService: ClaudexService {
    public init() {}
    public func snapshot() async throws -> Snapshot { throw ServiceError.nativeAuthenticationUnavailable }
    public func conversationTurns(_ id: String) async throws -> ConversationTurns { throw ServiceError.nativeAuthenticationUnavailable }
    public func models() async throws -> ModelCatalog? { throw ServiceError.nativeAuthenticationUnavailable }
    public func send(_ input: SendInput) async throws -> Conversation { throw ServiceError.nativeAuthenticationUnavailable }
    public func steerTurn(_ conversationID: String, text: String, attachmentIDs: [String]) async throws -> SteerResult? { throw ServiceError.nativeAuthenticationUnavailable }
    public func interrupt(_ conversationID: String) async throws { throw ServiceError.nativeAuthenticationUnavailable }
    public func upload(name: String, data: Data) async throws -> Attachment { throw ServiceError.nativeAuthenticationUnavailable }
    public func updateConversation(_ id: String, patch: JSONValue) async throws -> Conversation { throw ServiceError.nativeAuthenticationUnavailable }
    public func saveSettings(_ settings: Settings) async throws -> Settings { throw ServiceError.nativeAuthenticationUnavailable }
}

/// The last event a snapshot already includes, from its X-Claudex-Event-Seq
/// response header (as the web and Android read it).
public enum SnapshotSequence {
    public static func parse(_ header: String?) -> Int? {
        guard let header, header.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil,
              let value = Int(header), value <= 9_007_199_254_740_991 else { return nil }
        return value
    }
}
public extension ClaudexService {
    /// Missing implementations are errors, never a fabricated null fallback.
    func steerTurn(_ conversationID: String, text: String, attachmentIDs: [String]) async throws -> SteerResult? { throw ServiceError.invalidResponse }
    /// The snapshot and the event sequence it covers, when the service reports it.
    func snapshotCoverage() async throws -> (Snapshot, Int?) { (try await snapshot(), nil) }
}
