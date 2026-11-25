import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if SWIFT_PACKAGE
import ClaudexCore
#else
@testable import Claudex
#endif

private final class MemoryVault: TokenVault, @unchecked Sendable {
    private let lock = NSLock()
    private var value: StoredSession?
    func read() throws -> StoredSession? { lock.lock(); defer { lock.unlock() }; return value }
    func write(_ session: StoredSession?) throws { lock.lock(); defer { lock.unlock() }; value = session }
}
private func authResponse(_ name: String, ttl: Int = 3600, refresh: Bool = true) -> String {
    var fields: [String: Any] = ["access_token": name + "-access", "token_type": "Bearer", "expires_in": ttl, "user": ["email": name + "@example.test", "username": name]]
    if refresh { fields["refresh_token"] = name + "-refresh" }
    return String(data: try! JSONSerialization.data(withJSONObject: ["code": 0, "data": fields]), encoding: .utf8)!
}
private actor ControlledAuthWire: HTTPTransport {
    var held: [String: CheckedContinuation<(Data, Int), Error>] = [:]
    var waiting: [String: [CheckedContinuation<Void, Never>]] = [:]
    var requests: [URLRequest] = []
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        let path = request.url!.path
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data("{}".utf8))
        if path.hasSuffix("/logout") { return (Data(#"{"code":0,"data":{}}"#.utf8), 200) }
        if path.hasSuffix("/login") {
            let who = body["email"].string ?? ""
            if who != "first" { return (Data(authResponse(who, ttl: who == "initial" ? 0 : 3600).utf8), 200) }
            return try await hold("first")
        }
        if path.hasSuffix("/refresh") { return try await hold("refresh") }
        if path.hasSuffix("/events-ticket") { return try await hold("ticket") }
        throw ServiceError.invalidResponse
    }
    private func hold(_ key: String) async throws -> (Data, Int) {
        try await withCheckedThrowingContinuation { continuation in
            held[key] = continuation
            for waiter in waiting.removeValue(forKey: key) ?? [] { waiter.resume() }
        }
    }
    func waitFor(_ key: String) async {
        if held[key] != nil { return }
        await withCheckedContinuation { waiting[key, default: []].append($0) }
    }
    func finish(_ key: String, json: String, status: Int = 200) { held.removeValue(forKey: key)!.resume(returning: (Data(json.utf8), status)) }
    func count(_ suffix: String) -> Int { requests.filter { $0.url!.path.hasSuffix(suffix) }.count }
}
private func session(_ wire: ControlledAuthWire, _ vault: MemoryVault) throws -> NativeSession {
    NativeSession(http: try AuthHTTPClient(baseURL: URL(string: "https://service.test")!, transport: wire), vault: vault)
}
final class AuthRaceTests: XCTestCase {
    func testOlderOverlappingLoginCannotOverwriteNewerLogin() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault()
        let auth = try session(wire, vault)
        let old = Task { try await auth.login(email: "first", password: "test-fixture") }
        await wire.waitFor("first")
        _ = try await auth.login(email: "second", password: "test-fixture")
        await wire.finish("first", json: authResponse("first"))
        do { _ = try await old.value; XCTFail("Superseded login must not authenticate") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let access = try await auth.accessToken()
        XCTAssertEqual(access, "second-access")
        XCTAssertEqual(try vault.read()?.account.email, "second@example.test")
    }
    func testConcurrentRefreshWaitersCannotReceiveTokensAfterLogout() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault()
        let auth = try session(wire, vault)
        _ = try await auth.login(email: "initial", password: "test-fixture")
        let owner = Task { try await auth.accessToken() }
        await wire.waitFor("refresh")
        let waiter = Task { try await auth.accessToken() }
        // Let the second actor call enter its shared refresh await, without a real network or clock dependency.
        for _ in 0..<100 { await Task.yield() }
        try await auth.signOut()
        await wire.finish("refresh", json: authResponse("renewed"))
        do { _ = try await owner.value; XCTFail("Owner leaked a post-logout token") } catch {}
        do { _ = try await waiter.value; XCTFail("Shared refresh waiter leaked a post-logout token") } catch {}
        XCTAssertNil(try vault.read())
        let count = await wire.count("/refresh"); XCTAssertEqual(count, 1)
    }
    func testRefreshRotationMissingRefreshTokenFailsClosed() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault()
        let auth = try session(wire, vault)
        _ = try await auth.login(email: "initial", password: "test-fixture")
        let refresh = Task { try await auth.accessToken() }
        await wire.waitFor("refresh")
        await wire.finish("refresh", json: authResponse("renewed", refresh: false))
        do { _ = try await refresh.value; XCTFail("Refresh response without required rotated token must fail closed") }
        catch { XCTAssertEqual(error as? ServiceError, .invalidResponse) }
    }
    func testRejectedRefreshClearsPersistedSession() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault()
        let auth = try session(wire, vault)
        _ = try await auth.login(email: "initial", password: "test-fixture")
        let refresh = Task { try await auth.accessToken() }
        await wire.waitFor("refresh")
        await wire.finish("refresh", json: #"{"code":401,"message":"Refresh token revoked"}"#, status: 401)
        do { _ = try await refresh.value; XCTFail("Revoked refresh must fail") }
        catch { XCTAssertEqual(error as? ServiceError, .signedOut) }
        XCTAssertNil(try vault.read())
    }
    func testConcurrentRefreshIsSingleflightAndPersistsRotation() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault()
        let auth = try session(wire, vault)
        _ = try await auth.login(email: "initial", password: "test-fixture")
        let owner = Task { try await auth.accessToken() }
        await wire.waitFor("refresh")
        let waiter = Task { try await auth.accessToken() }
        for _ in 0..<100 { await Task.yield() }
        await wire.finish("refresh", json: authResponse("renewed"))
        let ownerToken = try await owner.value, waiterToken = try await waiter.value
        XCTAssertEqual(ownerToken, "renewed-access"); XCTAssertEqual(waiterToken, "renewed-access")
        let count = await wire.count("/refresh"); XCTAssertEqual(count, 1)
        XCTAssertEqual(try vault.read()?.refreshToken, "renewed-refresh")
    }
    func testTicket401CannotRefreshAfterSameAccountRelogin() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault(), auth = try session(wire, vault)
        _ = try await auth.login(email: "ready", password: "fixture")
        let before = await auth.sessionGeneration()
        let pending = Task { try await auth.eventsTicket(tabID: "fixture-tab") }
        await wire.waitFor("ticket")
        try await auth.signOut()
        _ = try await auth.login(email: "ready", password: "fixture")
        let after = await auth.sessionGeneration(); XCTAssertNotEqual(before, after)
        await wire.finish("ticket", json: #"{"code":401,"message":"Old token expired"}"#, status: 401)
        do { _ = try await pending.value; XCTFail("Old ticket must not be retried") }
        catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let refreshes = await wire.count("/refresh"), tickets = await wire.count("/events-ticket")
        XCTAssertEqual(refreshes, 0); XCTAssertEqual(tickets, 1)
        XCTAssertEqual(try vault.read()?.account.email, "ready@example.test")
    }
    func testRejectedCurrentSessionRefreshStillReportsSignedOutThroughRPC() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault(), auth = try session(wire, vault)
        _ = try await auth.login(email: "initial", password: "fixture")
        let rpc = try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "fixture-tab", session: auth, transport: wire)
        let pending = Task { try await rpc.call("snapshot", as: JSONValue.self) }
        await wire.waitFor("refresh")
        await wire.finish("refresh", json: #"{"code":401,"message":"Refresh token revoked"}"#, status: 401)
        do { _ = try await pending.value; XCTFail("Must report expired current session") }
        catch { XCTAssertEqual(error as? ServiceError, .signedOut) }
    }
    func testRefreshRotationKeepsSameSessionGeneration() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault(), auth = try session(wire, vault)
        _ = try await auth.login(email: "initial", password: "fixture")
        let before = await auth.sessionGeneration()
        let pending = Task { try await auth.accessToken() }
        await wire.waitFor("refresh")
        await wire.finish("refresh", json: authResponse("initial", ttl: 3600))
        _ = try await pending.value
        let after = await auth.sessionGeneration(); XCTAssertEqual(before, after)
    }
    func testInFlightEventsTicketCannotReturnAfterLogout() async throws {
        let wire = ControlledAuthWire(), vault = MemoryVault()
        let auth = try session(wire, vault)
        _ = try await auth.login(email: "ready", password: "test-fixture")
        let ticket = Task { try await auth.eventsTicket(tabID: "fixture-tab") }
        await wire.waitFor("ticket")
        try await auth.signOut()
        await wire.finish("ticket", json: #"{"code":0,"data":{"ticket":"stale-ticket"}}"#)
        do { _ = try await ticket.value; XCTFail("In-flight ticket returned after logout") } catch {}
        XCTAssertNil(try vault.read())
    }
}
