import Foundation

/// A native observation of one current item, never an authority supplied by JS.
public struct TranscriptImageObservation: Sendable, Equatable {
    public let conversationID: String
    public let turnID: String
    public let itemID: String
    public let type: String
    public let path: String
    public let source: JSONValue
    public var key: String { ArtifactIndex.identity([conversationID, turnID, itemID, type, path]) }
    public var revisionKey: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return key + ":" + UploadDigest.sha256((try? encoder.encode(source)) ?? Data())
    }
    public var method: String { type == "imageGeneration" ? "imageGenerationSnapshot" : "viewedImageSnapshot" }
    public var arguments: [JSONValue] { type == "imageGeneration" ? [.string(path)] : [.string(conversationID), .string(path)] }
}
public struct TranscriptImageCapture: Sendable, Equatable {
    public let observation: TranscriptImageObservation
    public let file: GeneratedFile
}
public enum TranscriptImageSnapshots {
    /// Shared descriptors are metadata, not permission to preload or raise the
    /// existing bounded generated-file read limit.
    public static let maximumBytes = 64 * 1024 * 1024
    public static let maximumInlineBytes = 2 * 1024 * 1024
    public static let maximumInlineTotalBytes = 8 * 1024 * 1024
    public static let maximumEntries = 12
    public static func observations(_ conversation: Conversation) -> [TranscriptImageObservation] {
        guard conversation.slim != true, SharedConversationProtocol.identifier(.string(conversation.id)) != nil else { return [] }
        var result: [TranscriptImageObservation] = []
        for turn in conversation.turns {
            guard SharedConversationProtocol.identifier(.string(turn.id)) != nil,
                  conversation.turns.filter({ $0.id == turn.id }).count == 1 else { continue }
            for item in turn.items {
                guard SharedConversationProtocol.identifier(item.raw["id"]) != nil,
                      turn.items.filter({ $0.id == item.id }).count == 1,
                      ["imageGeneration", "imageView"].contains(item.type),
                      item.raw["generatedFiles"] == .null || item.raw["generatedFiles"] == .array([]),
                      let path = item.raw[item.type == "imageGeneration" ? "savedPath" : "path"].string,
                      !path.isEmpty, path.utf16.count <= 2000,
                      !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { continue }
                result.append(.init(conversationID: conversation.id, turnID: turn.id, itemID: item.id, type: item.type, path: path, source: item.raw))
            }
        }
        return Array(result.suffix(maximumEntries))
    }
    public static func isCurrent(_ observation: TranscriptImageObservation, in conversation: Conversation) -> Bool {
        observations(conversation).contains(observation)
    }
    public static func inlineEligible(_ file: GeneratedFile, budget: Int) -> Bool {
        guard file.isReady, file.blob == true, let digest = file.digest, GeneratedFileSafety.validDigest(digest),
              ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(file.mime ?? ""),
              let count = file.bytes else { return false }
        return count > 0 && count <= min(maximumInlineBytes, budget / 2)
    }
    /// No guessed MIME, permissive digest, fractional size, or arbitrary file path.
    public static func capture(_ descriptor: JSONValue, observation: TranscriptImageObservation) throws -> TranscriptImageCapture {
        guard descriptor.object != nil, let digest = descriptor["digest"].string,
              GeneratedFileSafety.validDigest(digest), let size = descriptor["bytes"].integer,
              size >= 0, size <= maximumBytes, let mime = descriptor["mime"].string,
              ["image/png", "image/jpeg", "image/webp"].contains(mime) else { throw ServiceError.invalidResponse }
        let suffix = mime == "image/png" ? "png" : mime == "image/jpeg" ? "jpg" : "webp"
        var name = GeneratedFileSafety.filename(observation.path)
        let ext = (name as NSString).pathExtension.lowercased()
        if !(mime == "image/jpeg" ? ["jpg", "jpeg"] : [suffix]).contains(ext) { name = CoreText.string(.imageName, suffix) }
        let identity = "native-image:" + UploadDigest.sha256(Data((observation.key + ":" + digest).utf8))
        let file = GeneratedFile(extensionFields: ["operation": .string("create")], id: identity, name: name, path: observation.path,
                                 language: "text", state: "ready", content: nil, digest: digest, bytes: size, blob: true, mime: mime, error: nil)
        return .init(observation: observation, file: file)
    }
    /// Projection keeps server snapshots/reducers untouched. Authorization and
    /// rendering see the same file, only while the original current item survives.
    public static func applying(_ captures: [TranscriptImageCapture], to source: Conversation) -> Conversation {
        let captures = captures.filter { $0.observation.conversationID == source.id }
        guard !captures.isEmpty else { return source }
        var result = source
        let current = observations(source)
        for capture in captures where current.contains(capture.observation) {
            guard let turn = result.turns.firstIndex(where: { $0.id == capture.observation.turnID }),
                  let item = result.turns[turn].items.firstIndex(where: { $0.id == capture.observation.itemID }),
                  var fields = result.turns[turn].items[item].raw.object,
                  let wire = try? JSONValue.encode(capture.file) else { continue }
            fields["generatedFiles"] = .array([wire])
            guard let replacement = try? JSONValue.object(fields).decode(TranscriptItem.self) else { continue }
            result.turns[turn].items[item] = replacement
        }
        return result
    }
}
public extension RemoteClaudexService {
    func transcriptImageSnapshot(_ observation: TranscriptImageObservation) async throws -> TranscriptImageCapture? {
        let value = try await rpc.call(observation.method, args: observation.arguments, as: Optional<JSONValue>.self)
        try Task.checkCancellation()
        return try value.map { try TranscriptImageSnapshots.capture($0, observation: observation) }
    }
}
