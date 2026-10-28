import Foundation

public struct GeneratedFile: Codable, Identifiable, Sendable, Equatable {
    public var extensionFields: [String: JSONValue] = [:]
    public let id: String
    public let name: String
    public let path: String
    public let language: String
    public let state: String
    public let content: String?
    public let digest: String?
    public let bytes: Int?
    public let blob: Bool?
    public let mime: String?
    public let error: String?
    public var isReady: Bool { state == "ready" }
    public var safeName: String { GeneratedFileSafety.filename(name) }
    public var quickLookAllowed: Bool {
        let ext = (safeName as NSString).pathExtension.lowercased()
        // No active HTML/SVG, scripts or arbitrary executables in Quick Look.
        let types: [String: Set<String>] = [
            "pdf": ["application/pdf"], "png": ["image/png"], "jpg": ["image/jpeg"], "jpeg": ["image/jpeg"],
            "gif": ["image/gif"], "webp": ["image/webp"], "heic": ["image/heic", "image/heif"], "tif": ["image/tiff"], "tiff": ["image/tiff"],
            "docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
            "xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
            "pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
            "txt": ["text/plain"], "csv": ["text/csv", "text/plain"]
        ]
        guard let allowed = types[ext] else { return false }
        guard let mime else { return true }
        return allowed.contains(mime.lowercased().components(separatedBy: ";")[0].trimmingCharacters(in: .whitespaces))
    }
}
public enum GeneratedFileSafety {
    public static let maximumBytes = 16 * 1024 * 1024 // electron/generated-blobs.ts
    public static func filename(_ name: String) -> String {
        let basename = name.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
        let clean = String(basename.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0 != ":" }.prefix(180))
        return clean.isEmpty || clean == "." || clean == ".." ? "generated-file" : clean
    }
    public static func validDigest(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    public static func decode(_ base64: String, file: GeneratedFile) throws -> Data {
        guard file.isReady, let digest = file.digest, validDigest(digest),
              base64.utf8.count <= ((maximumBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: base64), data.count <= maximumBytes,
              file.bytes == nil || file.bytes == data.count,
              UploadDigest.sha256(data) == digest else { throw ServiceError.server(CoreText.string(.somethingWentWrongTryAgain), "INVALID_GENERATED_FILE") }
        return data
    }
}
public extension RemoteClaudexService {
    func generatedFileData(_ file: GeneratedFile) async throws -> Data {
        guard file.isReady else { throw ServiceError.server(file.error ?? CoreText.string(.fileNotReady), "FILE_NOT_READY") }
        if file.blob != true, let content = file.content {
            let data = Data(content.utf8)
            guard data.count <= GeneratedFileSafety.maximumBytes else { throw ServiceError.tooLarge }
            return data
        }
        if let count = file.bytes, count > GeneratedFileSafety.maximumBytes {
            throw ServiceError.server(CoreText.string(.previewTooLarge), "GENERATED_FILE_READ_LIMIT")
        }
        guard let digest = file.digest, GeneratedFileSafety.validDigest(digest),
              file.bytes.map({ $0 >= 0 && $0 <= GeneratedFileSafety.maximumBytes }) ?? true else { throw ServiceError.invalidResponse }
        let base64: String = try await rpc.call("readGeneratedFile", args: [.string(digest)], as: String.self)
        try Task.checkCancellation()
        return try GeneratedFileSafety.decode(base64, file: file)
    }
}


public extension GeneratedFile {
    init(from decoder: Decoder) throws {
        let wire = try JSONValue(from: decoder)
        guard let fields = wire.object else { throw ServiceError.invalidResponse }
        id = try wire["id"].decode(String.self)
        name = try wire["name"].decode(String.self)
        path = try wire["path"].decode(String.self)
        language = try wire["language"].decode(String.self)
        state = try wire["state"].decode(String.self)
        content = wire["content"] == .null ? nil : try wire["content"].decode(String.self)
        digest = wire["digest"] == .null ? nil : try wire["digest"].decode(String.self)
        bytes = wire["bytes"] == .null ? nil : try wire["bytes"].decode(Int.self)
        blob = wire["blob"] == .null ? nil : try wire["blob"].decode(Bool.self)
        mime = wire["mime"] == .null ? nil : try wire["mime"].decode(String.self)
        error = wire["error"] == .null ? nil : try wire["error"].decode(String.self)
        let known: Set<String> = ["id", "name", "path", "language", "state", "content", "digest", "bytes", "blob", "mime", "error"]
        extensionFields = fields.filter { !known.contains($0.key) }
    }
    func encode(to encoder: Encoder) throws {
        var wire = extensionFields
        wire["id"] = try JSONValue.encode(id)
        wire["name"] = try JSONValue.encode(name)
        wire["path"] = try JSONValue.encode(path)
        wire["language"] = try JSONValue.encode(language)
        wire["state"] = try JSONValue.encode(state)
        if let content { wire["content"] = try JSONValue.encode(content) }
        if let digest { wire["digest"] = try JSONValue.encode(digest) }
        if let bytes { wire["bytes"] = try JSONValue.encode(bytes) }
        if let blob { wire["blob"] = try JSONValue.encode(blob) }
        if let mime { wire["mime"] = try JSONValue.encode(mime) }
        if let error { wire["error"] = try JSONValue.encode(error) }
        try JSONValue.object(wire).encode(to: encoder)
    }
}
