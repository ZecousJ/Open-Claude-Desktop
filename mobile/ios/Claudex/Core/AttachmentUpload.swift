import Foundation
#if canImport(ImageIO)
import ImageIO
#endif
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum AttachmentLimits {
    public static let maximumCount = 10
    public static let clientMaximum = 30 * 1_024 * 1_024
    public static let imageMaximum = 20 * 1_024 * 1_024
    public static let textMaximum = 2 * 1_024 * 1_024
    public static let inlineMaximum = 256 * 1_024
    public static let chunkSize = 1_024 * 1_024
    private static let textExtensions: Set<String> = ["txt", "md", "csv", "ts", "tsx", "js", "jsx", "py", "json", "yaml", "yml", "html", "css", "rs", "go", "java", "c", "cpp", "xml", "toml", "log"]
    public static func isImage(name: String) -> Bool {
        ["png", "jpg", "jpeg", "webp", "gif"].contains(URL(fileURLWithPath: name).pathExtension.lowercased())
    }
    public static func isText(name: String) -> Bool {
        textExtensions.contains(URL(fileURLWithPath: name).pathExtension.lowercased())
    }
    public static func validate(name: String, data: Data) throws {
        if isImage(name: name) {
            guard data.count <= imageMaximum else { throw ServiceError.server(CoreText.string(.attachmentFileOverLimit, 20), nil) }
            #if canImport(ImageIO)
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
                  CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1
                  ] as CFDictionary) != nil else {
                throw ServiceError.server(CoreText.string(.uploadFailed), nil)
            }
            #endif
            return
        }
        guard isText(name: name) else { return }
        guard data.count <= textMaximum else { throw ServiceError.server(CoreText.string(.attachmentFileOverLimit, 2), nil) }
        guard !data.contains(0), String(data: data, encoding: .utf8) != nil else {
            throw ServiceError.server(CoreText.string(.uploadFailed), nil)
        }
    }
}
struct AttachmentPreviewImage: Sendable {
    let contentType: String
    let data: Data
    var dataURL: String { "data:\(contentType);base64,\(data.base64EncodedString())" }
}

struct AttachmentPreviewReader: Sendable {
    let rpc: RPCClient
    let generation: Int?
    let organization: UUID?

    func image(_ id: String, thumbnail: Bool, maximumBytes: Int) async throws -> AttachmentPreviewImage? {
        guard maximumBytes > 0 else { return nil }
        try await rpc.verifyGeneration(generation)
        if let organization,
           id.range(of: "^[A-Za-z0-9_-]{1,500}$", options: .regularExpression) != nil {
            let part = thumbnail ? "thumbnail" : "preview"
            let path = "/api/\(organization.uuidString.lowercased())/files/\(id)/\(part)"
            let request = JSONValue.object(["method": .string("GET"), "path": .string(path), "objectTransfer": .bool(true)])
            let response = try? await rpc.callBound("officialUiRead", args: [request], as: JSONValue.self, generation: generation)
            try await rpc.verifyGeneration(generation)
            if let response, response["status"].number == 200,
               let type = response["contentType"].string,
               type.hasPrefix("image/"),
               let url = response["objectTransfer"]["url"].string,
               let size = response["objectTransfer"]["size"].number,
               size >= 1, size <= Double(maximumBytes), Double(Int(size)) == size,
               let data = try await AttachmentObjectTransfer.getObject(rpc: rpc, rawURL: url, expectedSize: Int(size),
                                                                         generation: generation, maximumSize: maximumBytes) {
                return AttachmentPreviewImage(contentType: type, data: data)
            }
        }
        guard let value = try await rpc.callBound("attachmentPreview", args: [.string(id)], as: Optional<String>.self, generation: generation),
              value.hasPrefix("data:image/"), let separator = value.range(of: ";base64,"),
              value[separator.upperBound...].utf8.count <= (maximumBytes + 2) / 3 * 4,
              let data = Data(base64Encoded: String(value[separator.upperBound...])), data.count <= maximumBytes else { return nil }
        return AttachmentPreviewImage(contentType: String(value.dropFirst(5)[..<separator.lowerBound]), data: data)
    }
}

extension RemoteClaudexService {
    func attachmentPreviewReader() async throws -> AttachmentPreviewReader {
        struct Organization: Decodable { let uuid: UUID }
        let generation = await rpc.session.sessionGeneration()
        let request = JSONValue.object(["method": .string("GET"), "path": .string("/api/organizations")])
        let response = try? await rpc.callBound("officialUiRead", args: [request], as: JSONValue.self, generation: generation)
        try await rpc.verifyGeneration(generation)
        let organization = response?["status"].number == 200 ? response?["body"]["$bytes"].string
            .flatMap { Data(base64Encoded: $0) }
            .flatMap { try? JSONDecoder().decode([Organization].self, from: $0) }?.first?.uuid : nil
        return AttachmentPreviewReader(rpc: rpc, generation: generation, organization: organization)
    }
}

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
        let mime = mimeType(name)
        func startUpload(direct: Bool) async throws -> JSONValue {
            try Task.checkCancellation()
            var payload: [String: JSONValue] = ["name": .string(name), "size": .number(Double(data.count)), "type": .string(mime), "sha256": .string(checksum)]
            if direct { payload["direct"] = .bool(true) }
            return try await uploadRequest(path: "api/v1/claudex/web/uploads", method: "POST", bytes: JSONEncoder().encode(JSONValue.object(payload)), contentType: "application/json", generation: generation)
        }
        var initialized = try await startUpload(direct: true)
        guard var id = initialized["id"].string, id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        if let directURL = initialized["upload"]["url"].string, !directURL.isEmpty {
            if try await AttachmentObjectTransfer.putObject(rpc: rpc, rawURL: directURL, sha256: checksum, data: data, generation: generation) {
                try Task.checkCancellation()
                let completed = try await uploadRequest(path: "api/v1/claudex/web/uploads/\(id)/complete", method: "POST", bytes: Data("{}".utf8), contentType: "application/json", generation: generation)
                guard completed["id"].string == id else { throw ServiceError.invalidResponse }
                try Task.checkCancellation()
                progress(0.95)
                return .object(["$upload": .string(id)])
            }
            initialized = try await startUpload(direct: false)
            guard let fallbackID = initialized["id"].string, fallbackID.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
            id = fallbackID
        }
        if initialized["complete"].bool != true {
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
        } else {
            progress(0.95)
        }
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

enum AttachmentObjectTransfer {
    static func validURL(_ raw: String) -> URL? {
        guard let components = URLComponents(string: raw),
              components.scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.fragment == nil,
              let url = components.url else { return nil }
        return url
    }
    static func putObject(rpc: RPCClient, rawURL: String, sha256: String, data: Data, generation: Int?) async throws -> Bool {
        guard let url = validURL(rawURL) else { return false }
        for attempt in 0..<3 {
            try await rpc.verifyGeneration(generation)
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.httpBody = data
            request.setValue("*", forHTTPHeaderField: "If-None-Match")
            request.setValue(sha256, forHTTPHeaderField: "X-Amz-Content-Sha256")
            let status: Int
            do {
                (_, status) = try await rpc.transport.execute(request)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                status = 0
            }
            try await rpc.verifyGeneration(generation)
            if (200..<300).contains(status) || status == 412 { return true }
            if attempt == 2 || (status != 0 && status != 429 && !(500..<600).contains(status)) { return false }
            try await Task.sleep(nanoseconds: UInt64(250_000_000 * (attempt + 1)))
        }
        return false
    }
    static func getObject(rpc: RPCClient, rawURL: String, expectedSize: Int, generation: Int?, maximumSize: Int = GeneratedFileSafety.maximumBytes) async throws -> Data? {
        guard expectedSize >= 0, expectedSize <= maximumSize,
              let url = validURL(rawURL) else { return nil }
        var accumulated = Data()
        accumulated.reserveCapacity(expectedSize)
        for attempt in 0..<3 {
            try await rpc.verifyGeneration(generation)
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            let offset = accumulated.count
            if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
            let chunk: Data
            let status: Int
            let headers: [String: String]
            do {
                (chunk, status, headers) = try await rpc.transport.executeReturningHeaders(request)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                chunk = Data(); status = 0; headers = [:]
            }
            try await rpc.verifyGeneration(generation)
            let expectedStatus = offset > 0 ? 206 : 200
            let validRange = offset == 0 || headers["content-range"] == "bytes \(offset)-\(expectedSize - 1)/\(expectedSize)"
            if status == expectedStatus, validRange, offset + chunk.count <= expectedSize {
                accumulated.append(chunk)
                if accumulated.count == expectedSize { return accumulated }
            }
            if attempt == 2 { return nil }
            try await Task.sleep(nanoseconds: UInt64(250_000_000 * (attempt + 1)))
        }
        return nil
    }
}
