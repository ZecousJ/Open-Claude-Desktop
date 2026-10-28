import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum AttachmentLimits { public static let maximumCount = 10; public static let clientMaximum = 30 * 1_024 * 1_024; public static let inlineMaximum = 256 * 1_024; public static let chunkSize = 1_024 * 1_024 }
public extension ClaudexService {
    func upload(name: String, data: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> Attachment { progress(0); let result = try await upload(name: name, data: data); progress(1); return result }
}
public extension RemoteClaudexService {
    func upload(name: String, data: Data, progress: @escaping @Sendable (Double) -> Void) async throws -> Attachment {
        let generation = await rpc.session.sessionGeneration()
        let reference = try await encodedUploadBound(name: name, data: data, progress: progress, generation: generation)
        let result = try await rpc.callBound("addAttachmentData", args: [.string(name), reference], as: Attachment.self, generation: generation)
        progress(1); return result
    }
    func encodedUpload(name: String, data: Data, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> JSONValue {
        let generation = await rpc.session.sessionGeneration()
        return try await encodedUploadBound(name: name, data: data, progress: progress, generation: generation)
    }
    private func encodedUploadBound(name: String, data: Data, progress: @escaping @Sendable (Double) -> Void, generation: Int?) async throws -> JSONValue {
        guard data.count <= AttachmentLimits.clientMaximum else { throw ServiceError.tooLarge }
        try await rpc.verifyGeneration(generation); progress(0)
        if data.count <= AttachmentLimits.inlineMaximum {
            return .object(["$bytes": .string(data.base64EncodedString())])
        }
        let checksum = UploadDigest.sha256(data)
        try Task.checkCancellation()
        let initialized = try await uploadRequest(path: "api/v1/claudex/web/uploads", method: "POST", bytes: JSONEncoder().encode(JSONValue.object(["name": .string(name), "size": .number(Double(data.count)), "type": .string(mimeType(name)), "sha256": .string(checksum)])), contentType: "application/json", generation: generation)
        guard let id = initialized["id"].string, id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        for (index, offset) in stride(from: 0, to: data.count, by: AttachmentLimits.chunkSize).enumerated() {
            try Task.checkCancellation()
            let end = min(data.count, offset + AttachmentLimits.chunkSize)
            let result = try await uploadRequest(path: "api/v1/claudex/web/uploads/\(id)/chunks/\(index)", method: "PUT", bytes: data.subdata(in: offset..<end), contentType: "application/octet-stream", generation: generation)
            guard result["id"].string == id else { throw ServiceError.invalidResponse }
            progress(Double(end) / Double(data.count) * 0.95)
        }
        try Task.checkCancellation()
        let completed = try await uploadRequest(path: "api/v1/claudex/web/uploads/\(id)/complete", method: "POST", bytes: Data("{}".utf8), contentType: "application/json", generation: generation)
        guard completed["id"].string == id else { throw ServiceError.invalidResponse }
        try Task.checkCancellation()
        return .object(["$upload": .string(id)])
    }
    private func uploadRequest(path: String, method: String, bytes: Data, contentType: String, generation: Int?) async throws -> JSONValue {
        var request = URLRequest(url: rpc.baseURL.appendingPathComponent(path)); request.httpMethod = method; request.httpBody = bytes
        request.setValue(contentType, forHTTPHeaderField: "Content-Type"); request.setValue(rpc.tabID, forHTTPHeaderField: "X-Claudex-Web-Tab")
        let (body, status) = try await rpc.authorizedRequest(request, generation: generation)
        guard status != 401 else { throw ServiceError.signedOut }
        let envelope = try JSONDecoder().decode(JSONValue.self, from: body)
        guard (200..<300).contains(status), envelope["ok"].bool == true else { throw ServiceError.server(envelope["error"]["message"].string ?? CoreText.string(.uploadFailed), envelope["error"]["code"].string) }
        return envelope["value"]
    }
    private func mimeType(_ name: String) -> String {
        switch URL(fileURLWithPath: name).pathExtension.lowercased() {
        case "png": "image/png"; case "jpg", "jpeg": "image/jpeg"; case "webp": "image/webp"; case "heic": "image/heic"; case "pdf": "application/pdf"; case "txt", "md": "text/plain"; case "csv": "text/csv"; case "json": "application/json"; default: "application/octet-stream"
        }
    }
}
