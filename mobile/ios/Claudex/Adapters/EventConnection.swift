import Foundation
import OSLog

@MainActor
final class EventConnection {
    private let baseURL: URL
    private let session: any SessionProvider
    private let tabID: String
    private var task: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private let urlSession: URLSession
    private var lastPong = Date()
    private var generation = 0
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "claudex", category: "event-stream")
    var cursor: () -> Int? = { nil }
    var onFrame: (JSONValue) -> Void = { _ in }
    var onStatus: (String) -> Void = { _ in }
    var onSignedOut: () -> Void = {}
    init(baseURL: URL, session: any SessionProvider, tabID: String) {
        self.baseURL = baseURL; self.session = session; self.tabID = tabID
        let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.urlCache = nil
        urlSession = URLSession(configuration: config, delegate: URLSessionTransport(), delegateQueue: nil)
    }
    func start() {
        guard task == nil else { return }
        generation += 1
        let epoch = generation
        task = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            var readyAt: Date?
            while !Task.isCancelled {
                do {
                    readyAt = nil
                    onStatus(attempt == 0 ? "正在连接" : "正在重新连接")
                    let ticket = try await session.eventsTicket(tabID: tabID)
                    try Task.checkCancellation()
                    guard epoch == generation else { break }
                    var parts = URLComponents(url: baseURL.appendingPathComponent("api/v1/claudex/web/events"), resolvingAgainstBaseURL: false)!
                    parts.scheme = "wss"
                    let ws = urlSession.webSocketTask(with: parts.url!, protocols: ["claudex.v1", "ticket." + ticket])
                    socket = ws; ws.maximumMessageSize = 16 * 1_024 * 1_024; ws.resume(); lastPong = Date()
                    try await send(WireFrames.hello(tabID: tabID, lastSequence: cursor()), on: ws)
                    try await send(WireFrames.presence(active: true), on: ws)
                    guard epoch == generation, !Task.isCancelled else { ws.cancel(with: .goingAway, reason: nil); break }
                    heartbeat = Task { [weak self, weak ws] in
                        while !Task.isCancelled {
                            do {
                                try await Task.sleep(for: .seconds(25))
                                guard let self, let ws, epoch == self.generation else { return }
                                if Date().timeIntervalSince(self.lastPong) > 65 { self.logger.info("Socket restart reason=heartbeatTimeout"); ws.cancel(with: .goingAway, reason: nil); return }
                                try await self.send(.object(["t": .string("ping")]), on: ws)
                            } catch { return }
                        }
                    }
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard epoch == generation, !Task.isCancelled else { break }
                        let bytes: Data
                        switch message { case .string(let text): bytes = Data(text.utf8); case .data(let data): bytes = data; @unknown default: continue }
                        let frame = try JSONDecoder().decode(JSONValue.self, from: bytes)
                        if frame["t"].string == "pong" { lastPong = Date() }
                        if frame["t"].string == "ready" { readyAt = Date(); onStatus("已连接") }
                        if let readyAt, Date().timeIntervalSince(readyAt) >= 60 { attempt = 0 }
                        onFrame(frame)
                    }
                } catch {
                    guard epoch == generation else { break }
                    heartbeat?.cancel(); heartbeat = nil
                    if Task.isCancelled { break }
                    if error as? ServiceError == .signedOut { onSignedOut(); break }
                    if case ServiceError.authentication(_, let status, _) = error, [401, 403, 404].contains(status) {
                        if status == 401 { onSignedOut() }
                        else { onStatus("出了点问题，请重试。") }
                        break
                    }
                    let code = socket?.closeCode.rawValue ?? 0
                    logger.info("Socket ended; reason=transportOrFrameError, closeCode=\(code, privacy: .public), attempt=\(attempt, privacy: .public)")
                    if code == 4008 { onSignedOut(); break }
                    if !ReconnectPolicy.shouldRetry(closeCode: code, attempt: attempt) { onStatus("连接已结束，请重新登录或刷新"); break }
                    onStatus("连接中断，正在重试")
                    socket?.cancel(with: .goingAway, reason: nil); socket = nil
                    do { try await Task.sleep(for: .seconds(ReconnectPolicy.delay(attempt: attempt))) } catch { break }
                    attempt += 1
                }
            }
            if epoch == generation { task = nil }
        }
    }
    func stop() {
        if task != nil { logger.info("Socket stopped by lifecycle or session owner") }
        generation += 1
        task?.cancel(); task = nil; heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        onStatus("已暂停连接")
    }
    private func send(_ frame: JSONValue, on socket: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(frame)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
}
