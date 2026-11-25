import Foundation

public enum NativeConversationDetails {
    public static func showsCodeChanges(_ mode: ChatMode) -> Bool { mode == .code }
    public static func rename(_ value: String) throws -> JSONValue {
        let title = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 200 else { throw ServiceError.server(CoreText.string(.titleInvalid), nil) }
        return .object(["title": .string(title)])
    }
    public static func move(to projectID: String?, availableIDs: Set<String>) throws -> JSONValue {
        if let projectID { guard availableIDs.contains(projectID) else { throw ServiceError.server(CoreText.string(.projectUnavailable), nil) } }
        return .object(["projectId": projectID.map(JSONValue.string) ?? .null])
    }
    public static func photoName(ordinal: Int, suffix: String) -> String {
        let ext = suffix.lowercased()
        let safe = ext.range(of: "^[a-z0-9]{1,12}$", options: .regularExpression) != nil ? ext : "img"
        return CoreText.string(.photoName, max(1, ordinal), safe)
    }
}
