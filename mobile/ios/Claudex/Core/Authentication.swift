import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct SessionAccount: Codable, Sendable, Equatable {
    public let raw: JSONValue
    public var email: String { raw["email"].string ?? "" }
    public var name: String { raw["username"].string ?? email }
    public init(raw: JSONValue) { self.raw = raw }
}
public struct StoredSession: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date
    public var account: SessionAccount
}
public protocol TokenVault: Sendable {
    func read() throws -> StoredSession?
    func write(_ session: StoredSession?) throws
}
public enum LoginOutcome: Sendable, Equatable {
    case authenticated(SessionAccount)
    case twoFactor(maskedEmail: String)
}
public struct AuthHTTPClient: Sendable {
    public let baseURL: URL
    public let transport: any HTTPTransport
    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) throws {
        // Same origin validation as RPC; never accept a user-entered upstream/API key URL.
        _ = try RPCClient(baseURL: baseURL, tabID: "validation", session: UnavailableNativeSession())
        self.baseURL = baseURL; self.transport = transport
    }
    public func request(_ path: String, body: JSONValue?, token: String? = nil, method: String = "POST") async throws -> JSONValue {
        guard path.hasPrefix("api/v1/auth/") || path == "api/v1/claudex/mobile/events-ticket" || path == "api/v1/claudex/sign-in/options" || path.hasPrefix("api/v1/claudex/auth/email-code/") else { throw ServiceError.invalidResponse }
        var request = URLRequest(url: baseURL.appendingPathComponent(path)); request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Native clients deliberately omit browser-only identity and CSRF headers.
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, status) = try await transport.execute(request)
        let response = (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
        guard (200..<300).contains(status), response["code"].number == 0 else {
            throw ServiceError.authentication(response["message"].string ?? CoreText.string(.somethingWentWrongTryAgain), status, response["reason"].string)
        }
        return response["data"]
    }
}
/// Serializes refresh rotation and invalidates in-flight work on logout.
public actor NativeSession: SessionProvider {
    private let http: AuthHTTPClient
    private let vault: any TokenVault
    private var current: StoredSession?
    private var refreshTask: Task<StoredSession, Error>?
    private var pendingTwoFactor: String?
    private var generation = 0
    public init(http: AuthHTTPClient, vault: any TokenVault) { self.http = http; self.vault = vault }
    public func restore() async throws -> SessionAccount? {
        guard let saved = try vault.read(), saved.refreshToken != nil else { return nil }
        current = saved
        _ = try await accessToken()
        return current?.account
    }
    public func signInOptions() async throws -> JSONValue {
        try await http.request("api/v1/claudex/sign-in/options", body: nil, method: "GET")
    }
    public func requestSignInCode(email: String) async throws -> Int {
        let result = try await http.request("api/v1/claudex/auth/email-code/send", body: .object(["email": .string(email)]))
        return max(0, min(86_400, result["countdown"].integer ?? 0))
    }
    public func loginWithEmailCode(email: String, code: String) async throws -> LoginOutcome {
        generation += 1; refreshTask?.cancel(); refreshTask = nil
        let epoch = generation
        let value = try await http.request("api/v1/claudex/auth/email-code/login", body: .object(["email": .string(email), "code": .string(code)]))
        guard epoch == generation else { throw CancellationError() }
        if value["requires_2fa"].bool == true {
            guard let temp = value["temp_token"].string else { throw ServiceError.invalidResponse }
            pendingTwoFactor = temp
            return .twoFactor(maskedEmail: value["user_email_masked"].string ?? email)
        }
        let session = try Self.parse(value, previous: nil); try persist(session)
        return .authenticated(session.account)
    }
    public func login(email: String, password: String) async throws -> LoginOutcome {
        generation += 1; refreshTask?.cancel(); refreshTask = nil
        let epoch = generation
        let value = try await http.request("api/v1/auth/login", body: .object(["email": .string(email), "password": .string(password)]))
        guard epoch == generation else { throw CancellationError() }
        if value["requires_2fa"].bool == true {
            guard let token = value["temp_token"].string, !token.isEmpty else { throw ServiceError.invalidResponse }
            pendingTwoFactor = token
            return .twoFactor(maskedEmail: value["user_email_masked"].string ?? email)
        }
        let session = try Self.parse(value, previous: nil)
        try persist(session); pendingTwoFactor = nil
        return .authenticated(session.account)
    }
    public func completeTwoFactor(code: String) async throws -> LoginOutcome {
        guard let temp = pendingTwoFactor, code.count == 6, code.allSatisfy(\.isNumber) else { throw ServiceError.server(CoreText.string(.codeInvalid), nil) }
        let epoch = generation
        let value = try await http.request("api/v1/auth/login/2fa", body: .object(["temp_token": .string(temp), "totp_code": .string(code)]))
        guard epoch == generation else { throw CancellationError() }
        let session = try Self.parse(value, previous: nil); try persist(session); pendingTwoFactor = nil
        return .authenticated(session.account)
    }
    public func cancelTwoFactor() { generation += 1; pendingTwoFactor = nil }
    public func requestVerification(email: String) async throws -> Int {
        let value = try await http.request("api/v1/auth/send-verify-code", body: .object(["email": .string(email)]))
        return max(0, min(86_400, value["countdown"].integer ?? 0))
    }
    public func register(email: String, password: String, verifyCode: String, invitation: String) async throws -> LoginOutcome {
        generation += 1; refreshTask?.cancel(); refreshTask = nil
        var body: [String: JSONValue] = ["email": .string(email), "password": .string(password)]
        if !verifyCode.isEmpty { body["verify_code"] = .string(verifyCode) }
        if !invitation.isEmpty { body["invitation_code"] = .string(invitation) }
        let epoch = generation
        let value = try await http.request("api/v1/auth/register", body: .object(body))
        guard epoch == generation else { throw CancellationError() }
        let session = try Self.parse(value, previous: nil); try persist(session)
        return .authenticated(session.account)
    }
    public func sessionGeneration() async -> Int? { generation }
    public func accessToken() async throws -> String {
        guard let current else { throw ServiceError.signedOut }
        if current.expiresAt.timeIntervalSinceNow > 60 { return current.accessToken }
        guard let refresh = current.refreshToken else { throw ServiceError.signedOut }
        let http = self.http, epoch = generation
        let task: Task<StoredSession, Error>
        if let existing = refreshTask { task = existing }
        else {
            task = Task { () throws -> StoredSession in
                let value = try await http.request("api/v1/auth/refresh", body: .object(["refresh_token": .string(refresh)]))
                guard let rotated = value["refresh_token"].string, !rotated.isEmpty else { throw ServiceError.invalidResponse }
                return try Self.parse(value, previous: current)
            }
            refreshTask = task
        }
        do {
            let renewed = try await task.value
            guard epoch == generation else { throw CancellationError() }
            try persist(renewed); refreshTask = nil; return renewed.accessToken
        } catch {
            if epoch == generation {
                refreshTask = nil
                if case ServiceError.authentication(_, let status, _) = error, [400, 401, 403].contains(status) {
                    self.current = nil; try vault.write(nil); throw ServiceError.signedOut
                }
                if error as? ServiceError == .invalidResponse { self.current = nil; try vault.write(nil) }
            }
            throw error
        }
    }
    public func refreshAccessToken() async throws -> String {
        current?.expiresAt = .distantPast
        return try await accessToken()
    }
    public func clearLocal() throws {
        generation += 1; refreshTask?.cancel(); refreshTask = nil; current = nil; pendingTwoFactor = nil
        try vault.write(nil)
    }
    public func eventsTicket(tabID: String) async throws -> String {
        let epoch = generation
        do {
            var token = try await accessToken()
            guard epoch == generation else { throw CancellationError() }
            try Task.checkCancellation()
            let body: JSONValue = .object(["tabId": .string(tabID)])
            let value: JSONValue
            do { value = try await http.request("api/v1/claudex/mobile/events-ticket", body: body, token: token) }
            catch ServiceError.authentication(_, 401, _) {
                guard epoch == generation else { throw CancellationError() }
                token = try await refreshAccessToken()
                guard epoch == generation else { throw CancellationError() }
                try Task.checkCancellation()
                value = try await http.request("api/v1/claudex/mobile/events-ticket", body: body, token: token)
            }
            guard epoch == generation else { throw CancellationError() }
            try Task.checkCancellation()
            guard let ticket = value["ticket"].string, ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
            return ticket
        } catch { guard epoch == generation else { throw CancellationError() }; throw error }
    }
    public func signOut() async throws {
        let refresh = current?.refreshToken
        generation += 1; refreshTask?.cancel(); refreshTask = nil; current = nil; pendingTwoFactor = nil
        try vault.write(nil)
        if let refresh { _ = try await http.request("api/v1/auth/logout", body: .object(["refresh_token": .string(refresh)])) }
    }
    private func persist(_ session: StoredSession) throws {
        // Access-only fallback is memory-only. Passwords and challenge tokens never enter the vault.
        try vault.write(session.refreshToken == nil ? nil : session); current = session
    }
    private static func parse(_ value: JSONValue, previous: StoredSession?) throws -> StoredSession {
        guard let access = value["access_token"].string, !access.isEmpty,
              value["token_type"].string?.lowercased() == "bearer" else { throw ServiceError.invalidResponse }
        let account: SessionAccount
        if value["user"].object != nil { account = SessionAccount(raw: value["user"]) }
        else if let previous { account = previous.account }
        else { throw ServiceError.invalidResponse }
        let ttl = value["expires_in"].number
        let expiration = ttl.map { Date().addingTimeInterval(max(0, $0)) } ?? jwtExpiry(access) ?? Date()
        return StoredSession(accessToken: access, refreshToken: value["refresh_token"].string, expiresAt: expiration, account: account)
    }
    private static func jwtExpiry(_ token: String) -> Date? {
        let parts = token.split(separator: "."); guard parts.count == 3 else { return nil }
        var base64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let claims = try? JSONDecoder().decode(JSONValue.self, from: data), let exp = claims["exp"].number else { return nil }
        return Date(timeIntervalSince1970: exp) // Scheduling only; the server verifies signatures.
    }
}
