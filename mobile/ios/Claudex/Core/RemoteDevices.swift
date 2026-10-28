import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The account's signed-in desktops (main shared/remote-devices.ts, owner
// 2026-10-06): the phone lists the computers that are online, opens a Code
// conversation on one, sends to it, stops it and answers its approvals. The
// conversation stays on the computer; the service relays.

/// One online desktop (GET /api/v1/claudex/web/devices).
public struct DeviceInfo: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let platform: String
    public let version: String
    public let connectedAt: String
    public init(id: String, name: String, platform: String, version: String, connectedAt: String) {
        self.id = id; self.name = name; self.platform = platform; self.version = version; self.connectedAt = connectedAt
    }
    /// "Mac", "Windows" or "Linux" for the list's second line.
    public var platformName: String {
        switch platform {
        case "darwin": return "Mac"
        case "win32": return "Windows"
        case "linux": return "Linux"
        default: return platform
        }
    }
    public var symbol: String { platform == "darwin" ? "laptopcomputer" : "desktopcomputer" }
}

/// A Code conversation on a desktop, as its list shows it.
public struct DeviceConversationSummary: Codable, Identifiable, Sendable, Equatable, Hashable {
    public let id: String
    public let title: String
    public let cwd: String?
    public let updatedAt: Double
    public let running: Bool
    public let approvals: Int
    public let model: String
    public init(id: String, title: String, cwd: String?, updatedAt: Double, running: Bool, approvals: Int, model: String) {
        self.id = id; self.title = title; self.cwd = cwd; self.updatedAt = updatedAt; self.running = running; self.approvals = approvals; self.model = model
    }
    /// The folder's last part ("Claudex" for /Users/me/Developer/Claudex).
    public var folderName: String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        let parts = cwd.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return parts.last.map(String.init) ?? cwd
    }
}

/// A folder the computer's owner added for phones (Settings → General → Folders for your phone);
/// new sessions start only in these.
public struct DeviceDirectory: Codable, Identifiable, Sendable, Equatable {
    public let path: String
    public let name: String
    public let sessions: Int
    public let isDefault: Bool
    public var id: String { path }
    public init(path: String, name: String, sessions: Int, isDefault: Bool) {
        self.path = path; self.name = name; self.sessions = sessions; self.isDefault = isDefault
    }
    enum CodingKeys: String, CodingKey { case path, name, sessions, isDefault = "default" }
}

/// A model the computer can run a session on (listModels).
public struct DeviceModelOption: Codable, Hashable, Identifiable, Sendable {
    public let providerId: String
    public let id: String
    public init(providerId: String, id: String) { self.providerId = providerId; self.id = id }
}

public struct DeviceModels: Codable, Sendable, Equatable {
    public let models: [DeviceModelOption]
    public let `default`: DeviceModelOption?
    public init(models: [DeviceModelOption], default: DeviceModelOption?) { self.models = models; self.`default` = `default` }
}

/// An opened desktop conversation and the approvals it waits on. Device
/// events keep it current while it is on screen.
public struct DeviceConversationState: Sendable, Equatable {
    public let deviceID: String
    public private(set) var conversation: Conversation
    public private(set) var approvals: [JSONValue]
    public init(deviceID: String, conversation: Conversation, approvals: [JSONValue]) {
        self.deviceID = deviceID; self.conversation = conversation; self.approvals = approvals
    }
    public var running: Bool { conversation.turns.last?.status == "inProgress" }

    /// Applies one device event (the inner `event` of a device-event). True
    /// when it changed what is shown.
    @discardableResult
    public mutating func apply(_ event: JSONValue) -> Bool {
        switch event["type"].string {
        case "conversation":
            guard let next = try? event["conversation"].decode(Conversation.self), next.id == conversation.id else { return false }
            conversation = next
            return true
        case "conversation-turn":
            guard event["conversationId"].string == conversation.id, let turn = try? event["turn"].decode(Turn.self) else { return false }
            var current = conversation
            if let index = current.turns.firstIndex(where: { $0.id == turn.id }) { current.turns[index] = turn } else { current.turns.append(turn) }
            if var full = (try? JSONValue.encode(current))?.object {
                for (key, value) in event["conversation"].object ?? [:] where key != "id" && key != "turns" { full[key] = value }
                if let patched = try? JSONValue.object(full).decode(Conversation.self) { current = patched }
            }
            conversation = current
            return true
        case "approval":
            let incoming = event["approval"]
            guard incoming["conversationId"].string == conversation.id else { return false }
            approvals.removeAll { $0["id"] == incoming["id"] }
            approvals.append(incoming)
            return true
        case "approval-resolved":
            let before = approvals.count
            approvals.removeAll { $0["id"] == event["id"] }
            return approvals.count != before
        default:
            return false
        }
    }
}

/// What a device-event or devices-changed frame on the account's stream means.
public enum DeviceStreamEvent: Equatable, Sendable {
    case devicesChanged
    case device(id: String, event: JSONValue)

    public init?(frame: JSONValue) {
        guard frame["t"].string == "event" else { return nil }
        let event = frame["event"]
        switch event["type"].string {
        case "devices-changed": self = .devicesChanged
        case "device-event":
            guard let id = event["deviceId"].string, !id.isEmpty, event["event"]["type"].string != nil else { return nil }
            self = .device(id: id, event: event["event"])
        default: return nil
        }
    }
}

/// Calls to the account's desktops through the service.
public struct DeviceClient: Sendable {
    public let rpc: RPCClient
    public init(rpc: RPCClient) { self.rpc = rpc }

    private static let idPattern = "^[A-Za-z0-9_-]{8,64}$"

    public func devices() async throws -> [DeviceInfo] {
        let generation = await rpc.session.sessionGeneration()
        var request = URLRequest(url: rpc.baseURL.appendingPathComponent("api/v1/claudex/web/devices"))
        request.httpMethod = "GET"
        request.setValue(rpc.tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
        let (data, status) = try await rpc.authorizedRequest(request, generation: generation)
        return try Self.value(data, status: status, as: [DeviceInfo].self)
    }

    public func call<T: Decodable & Sendable>(_ device: String, _ method: String, args: [JSONValue] = [], as: T.Type) async throws -> T {
        guard device.range(of: Self.idPattern, options: .regularExpression) != nil,
              method.range(of: "^[a-z][A-Za-z0-9]{0,63}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        let generation = await rpc.session.sessionGeneration()
        var request = URLRequest(url: rpc.baseURL.appendingPathComponent("api/v1/claudex/web/devices/\(device)/rpc/\(method)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(rpc.tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
        request.httpBody = try JSONEncoder().encode(JSONValue.object(["args": .array(args)]))
        guard (request.httpBody?.count ?? 0) <= 1_048_576 else { throw ServiceError.tooLarge }
        let (data, status) = try await rpc.authorizedRequest(request, generation: generation)
        return try Self.value(data, status: status, as: T.self)
    }

    public func conversations(_ device: String) async throws -> [DeviceConversationSummary] {
        try await call(device, "listCodeConversations", as: [DeviceConversationSummary].self)
    }

    public func open(_ device: String, conversationID: String) async throws -> DeviceConversationState {
        let value = try await call(device, "openConversation", args: [.string(conversationID)], as: JSONValue.self)
        let conversation = try value["conversation"].decode(Conversation.self)
        guard conversation.id == conversationID else { throw ServiceError.invalidResponse }
        return DeviceConversationState(deviceID: device, conversation: conversation, approvals: value["approvals"].array ?? [])
    }

    public func send(_ device: String, conversationID: String, text: String) async throws {
        let _: JSONValue = try await call(device, "send", args: [.object(["conversationId": .string(conversationID), "text": .string(text)])], as: JSONValue.self)
    }

    /// The folders new sessions may start in (the computer refuses any other path).
    public func directories(_ device: String) async throws -> [DeviceDirectory] {
        try await call(device, "listDirectories", as: [DeviceDirectory].self)
    }

    /// Starts a Code session in `cwd` with its first message; the answer is the session to open.
    public func newSession(_ device: String, cwd: String, text: String) async throws -> String {
        let value = try await call(device, "newSession", args: [.object(["cwd": .string(cwd), "text": .string(text)])], as: JSONValue.self)
        guard let id = value["conversationId"].string, !id.isEmpty else { throw ServiceError.invalidResponse }
        return id
    }

    /// Stops the session's turn and archives it on the computer.
    public func endSession(_ device: String, conversationID: String) async throws {
        let _: JSONValue = try await call(device, "endSession", args: [.string(conversationID)], as: JSONValue.self)
    }

    public func models(_ device: String) async throws -> DeviceModels {
        try await call(device, "listModels", as: DeviceModels.self)
    }

    /// The session's model from its next message on.
    public func setModel(_ device: String, conversationID: String, model: DeviceModelOption) async throws {
        let _: JSONValue = try await call(device, "setModel", args: [.object([
            "conversationId": .string(conversationID), "providerId": .string(model.providerId), "model": .string(model.id)])], as: JSONValue.self)
    }

    public func interrupt(_ device: String, conversationID: String) async throws {
        let _: JSONValue = try await call(device, "interrupt", args: [.string(conversationID)], as: JSONValue.self)
    }

    public func approve(_ device: String, approvalID: JSONValue, decision: JSONValue) async throws {
        let _: JSONValue = try await call(device, "approve", args: [approvalID, decision], as: JSONValue.self)
    }

    static func value<T: Decodable>(_ data: Data, status: Int, as: T.Type) throws -> T {
        guard status != 401 else { throw ServiceError.signedOut }
        let envelope = try JSONDecoder().decode(JSONValue.self, from: data)
        guard (200..<300).contains(status), envelope["ok"].bool == true else {
            throw ServiceError.server(DeviceClient.message(envelope["error"]["code"].string, fallback: envelope["error"]["message"].string, status: status), envelope["error"]["code"].string)
        }
        return try envelope["value"].decode(T.self)
    }

    /// The service's and the computer's refusals in the app's language.
    static func message(_ code: String?, fallback: String?, status: Int) -> String {
        switch code {
        case "CLAUDEX_DEVICE_OFFLINE": return CoreText.string(.deviceOffline)
        case "CLAUDEX_DEVICE_BUSY": return CoreText.string(.deviceBusy)
        case "CLAUDEX_WEB_TIMEOUT": return CoreText.string(.deviceTimeout)
        case "CLAUDEX_WEB_METHOD_UNAVAILABLE": return CoreText.string(.deviceOutdated)
        default: break
        }
        switch fallback {
        case "This conversation is not on this computer.": return CoreText.string(.deviceNotHere)
        case "This request was already answered.": return CoreText.string(.deviceAnswered)
        case "Write a message first.": return CoreText.string(.deviceWriteFirst)
        case "Wait for or stop the running task first.": return CoreText.string(.deviceWaitOrStop)
        case "This folder isn't added for your phone. Add it in Settings on the computer.": return CoreText.string(.deviceFolderNotAdded)
        case "Choose a directory, not the filesystem root.": return CoreText.string(.deviceNotRoot)
        case "Choose a model first.", "No model is available on this computer.": return CoreText.string(.deviceNoModel)
        case "This account cannot use the selected model.": return CoreText.string(.deviceModelNotAllowed)
        case "This computer couldn't start the session.": return CoreText.string(.deviceStartFailed)
        case nil, "": return CoreText.string(.unknownError)
        default: return fallback ?? CoreText.string(.unknownError)
        }
    }
}
