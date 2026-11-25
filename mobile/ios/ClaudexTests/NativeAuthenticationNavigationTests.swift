#if !SWIFT_PACKAGE
import XCTest
@testable import Claudex

private final class NavigationVault: TokenVault, @unchecked Sendable {
    private let lock = NSLock()
    private var value: StoredSession?
    init(_ value: StoredSession? = nil) { self.value = value }
    func read() throws -> StoredSession? { lock.lock(); defer { lock.unlock() }; return value }
    func write(_ value: StoredSession?) throws { lock.lock(); defer { lock.unlock() }; self.value = value }
}
private struct NavigationWire: HTTPTransport {
    let failLogout: Bool
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        switch request.url?.lastPathComponent {
        case "login", "register":
            return (Data(#"{"code":0,"data":{"access_token":"LOCAL_ACCESS","refresh_token":"LOCAL_REFRESH","expires_in":3600,"token_type":"bearer","user":{"email":"local@example.invalid"}}}"#.utf8), 200)
        case "logout":
            if failLogout { throw ServiceError.server("LOCAL_LOGOUT_FAILURE", nil) }
            return (Data(#"{"code":0,"data":{}}"#.utf8), 200)
        case "modelCatalog": return (Data(#"{"ok":true,"value":null}"#.utf8), 200)
        case "snapshot":
            return (Data(#"{"ok":true,"value":{"settings":{"name":"LOCAL_AUTH","providers":[],"effort":"high"},"conversations":[],"projects":[],"artifactLibrary":{"version":1,"copies":[],"pinned":[]},"engine":{},"approvals":[]}}"#.utf8), 200)
        default: throw ServiceError.invalidResponse
        }
    }
}
@MainActor
final class NativeAuthenticationNavigationTests: XCTestCase {
    private func fixture(_ saved: StoredSession? = nil, failLogout: Bool = false) throws -> (AppStore, NativeSession, NavigationVault) {
        let vault = NavigationVault(saved), wire = NavigationWire(failLogout: failLogout)
        let url = URL(string: "https://local.invalid")!
        let session = NativeSession(http: try AuthHTTPClient(baseURL: url, transport: wire), vault: vault)
        let service = RemoteClaudexService(rpc: try RPCClient(baseURL: url, tabID: "local-auth", session: session, transport: wire))
        return (AppStore(session: session, service: service), session, vault)
    }
    func testColdSignedOutRestoreEndsAtLogin() async throws {
        let (store, _, _) = try fixture()
        XCTAssertEqual(store.authenticationDestination, .restoring)
        await store.boot()
        XCTAssertEqual(store.authenticationDestination, .login)
        XCTAssertNil(store.snapshot)
    }
    func testSavedSessionRestoreEntersChatAfterRestoreFinishes() async throws {
        let saved = StoredSession(accessToken: "LOCAL_ACCESS", refreshToken: "LOCAL_REFRESH", expiresAt: .now.addingTimeInterval(3600), account: SessionAccount(raw: .object(["email": .string("local@example.invalid")])))
        let (store, _, _) = try fixture(saved)
        XCTAssertEqual(store.authenticationDestination, .restoring)
        await store.boot()
        XCTAssertEqual(store.authenticationDestination, .chat)
        XCTAssertNotNil(store.snapshot)
    }
    func testSuccessfulLoginEntersChatAndLogoutReturnsToLoginEvenIfServerFails() async throws {
        let (store, session, vault) = try fixture(failLogout: true)
        await store.boot()
        guard case .authenticated(let account) = try await session.login(email: "local@example.invalid", password: "LOCAL_SYNTHETIC") else { return XCTFail("Expected local login") }
        await store.didLogin(account)
        XCTAssertEqual(store.authenticationDestination, .chat)
        store.composerText = "LOCAL_PRIVATE_DRAFT"
        await store.signOut()
        XCTAssertEqual(store.authenticationDestination, .login)
        XCTAssertNil(store.account); XCTAssertNil(store.snapshot); XCTAssertTrue(store.composerText.isEmpty)
        XCTAssertNil(try vault.read())
    }
    func testSuccessfulRegistrationEntersChat() async throws {
        let (store, session, _) = try fixture()
        await store.boot()
        guard case .authenticated(let account) = try await session.register(email: "local@example.invalid", password: "LOCAL_SYNTHETIC", verifyCode: "", invitation: "") else { return XCTFail("Expected local registration") }
        await store.didLogin(account)
        XCTAssertEqual(store.authenticationDestination, .chat)
        XCTAssertFalse(store.presentLogin)
    }
}
#endif
