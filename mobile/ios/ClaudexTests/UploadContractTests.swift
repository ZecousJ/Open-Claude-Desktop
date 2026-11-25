import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

private actor UploadSession: SessionProvider {
    func accessToken() async throws -> String { "test-token" }
    func eventsTicket(tabID: String) async throws -> String { String(repeating: "a", count: 43) }
    func signOut() async throws {}
}
private actor UploadWire: HTTPTransport {
    enum Mode: Sendable { case success, invalidID, wrongChunkID, failedChunk, holdChunk }
    let mode: Mode
    var requests: [URLRequest] = []
    var held: CheckedContinuation<(Data, Int), Error>?
    var waiting: [CheckedContinuation<Void, Never>] = []
    init(mode: Mode = .success) { self.mode = mode }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        let path = request.url!.path
        if path.hasSuffix("/uploads") { return json(#"{"ok":true,"value":{"id":""# + (mode == .invalidID ? "../escape" : "upload-one") + #""}}"#) }
        if path.contains("/chunks/") {
            if mode == .holdChunk {
                return try await withCheckedThrowingContinuation { held = $0; for waiter in waiting { waiter.resume() }; waiting = [] }
            }
            if mode == .wrongChunkID { return json(#"{"ok":true,"value":{"id":"another-upload"}}"#) }
            if mode == .failedChunk { return json(#"{"ok":false,"error":{"message":"Quota exceeded","code":"CLAUDEX_WEB_QUOTA_EXCEEDED"}}"#, status: 507) }
            return json(#"{"ok":true,"value":{"id":"upload-one","received":1048576,"complete":false}}"#)
        }
        if path.hasSuffix("/complete") { return json(#"{"ok":true,"value":{"id":"upload-one","size":1048593}}"#) }
        if path.hasSuffix("/rpc/addAttachmentData") { return json(#"{"ok":true,"value":{"id":"attachment-one","name":"file.pdf","path":"files/safe","kind":"document","size":1048593}}"#) }
        throw ServiceError.invalidResponse
    }
    private func json(_ text: String, status: Int = 200) -> (Data, Int) { (Data(text.utf8), status) }
    func captured() -> [URLRequest] { requests }
    func waitForChunk() async { if held != nil { return }; await withCheckedContinuation { waiting.append($0) } }
    func releaseChunk() { held!.resume(returning: json(#"{"ok":true,"value":{"id":"upload-one"}}"#)); held = nil }
}
private final class ProgressRecorder: @unchecked Sendable {
    private let lock = NSLock(); private var values: [Double] = []
    func append(_ value: Double) { lock.lock(); values.append(value); lock.unlock() }
    func snapshot() -> [Double] { lock.lock(); defer { lock.unlock() }; return values }
}
private func uploadService(_ wire: UploadWire) throws -> RemoteClaudexService {
    RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "upload-tab", session: UploadSession(), transport: wire))
}
private func body(_ request: URLRequest) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(request.httpBody)) }

final class UploadContractTests: XCTestCase {
    func testSHA256StandardAndPaddingBoundaryVectors() {
        let vectors: [(Int, String)] = [
            (0,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            (1,"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"),
            (55,"9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"),
            (56,"b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"),
            (63,"7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"),
            (64,"ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"),
            (65,"635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"),
            (1000000,"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")]
        for (length, digest) in vectors { XCTAssertEqual(UploadDigest.sha256(Data(repeating: 97, count: length)), digest, "\(length)-byte SHA vector") }
        XCTAssertEqual(UploadDigest.sha256(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
    func testInlineBoundaryUsesOnlyRPC() async throws {
        let wire = UploadWire()
        _ = try await uploadService(wire).upload(name: "file.pdf", data: Data(count: AttachmentLimits.inlineMaximum))
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 1)
        XCTAssertTrue(requests.first!.url!.path.hasSuffix("/rpc/addAttachmentData"))
        XCTAssertNotNil(try body(requests[0])["args"].array?[1]["$bytes"].string)
    }
    func testOneByteOverInlineBoundaryUsesChunkFlow() async throws {
        let wire = UploadWire()
        _ = try await uploadService(wire).upload(name: "file.pdf", data: Data(count: AttachmentLimits.inlineMaximum + 1))
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(requests[1].httpBody?.count, AttachmentLimits.inlineMaximum + 1)
    }
    func testChunksHashHeadersProgressAndFinalReferenceMatchWireContract() async throws {
        let wire = UploadWire(), progress = ProgressRecorder()
        let data = Data((0..<(AttachmentLimits.chunkSize + 17)).map { UInt8(truncatingIfNeeded: $0) })
        _ = try await uploadService(wire).upload(name: "file.pdf", data: data, progress: { progress.append($0) })
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 5)
        let initial = try body(requests[0])
        XCTAssertEqual(initial["name"].string, "file.pdf"); XCTAssertEqual(initial["type"].string, "application/pdf")
        XCTAssertEqual(initial["size"].number, Double(data.count)); XCTAssertEqual(initial["sha256"].string, UploadDigest.sha256(data))
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "PUT", "PUT", "POST", "POST"])
        XCTAssertTrue(requests[1].url!.path.hasSuffix("/upload-one/chunks/0")); XCTAssertTrue(requests[2].url!.path.hasSuffix("/upload-one/chunks/1"))
        XCTAssertEqual(requests[1].httpBody, data.prefix(AttachmentLimits.chunkSize)); XCTAssertEqual(requests[2].httpBody, data.suffix(17))
        XCTAssertTrue(requests[3].url!.path.hasSuffix("/upload-one/complete")); XCTAssertEqual(try body(requests[4])["args"].array?[1], .object(["$upload": .string("upload-one")]))
        for request in requests { XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token"); XCTAssertNil(request.value(forHTTPHeaderField: "Origin")); XCTAssertNil(request.value(forHTTPHeaderField: "X-Claudex-Client")) }
        let values = progress.snapshot(); XCTAssertEqual(values.first, 0); XCTAssertEqual(values.last, 1); XCTAssertEqual(values, values.sorted())
    }
    func testAboveClientCapFailsBeforeAnyRequest() async throws {
        let wire = UploadWire()
        do { _ = try await uploadService(wire).upload(name: "huge.pdf", data: Data(count: AttachmentLimits.clientMaximum + 1)); XCTFail("Must cap attachment") }
        catch { XCTAssertEqual(error as? ServiceError, .tooLarge) }
        let requests = await wire.captured(); XCTAssertTrue(requests.isEmpty)
    }
    func testUntrustedUploadIDCannotChangeRoute() async throws {
        let wire = UploadWire(mode: .invalidID)
        do { _ = try await uploadService(wire).upload(name: "file.pdf", data: Data(count: AttachmentLimits.inlineMaximum + 1)); XCTFail("Must reject ID") }
        catch { XCTAssertEqual(error as? ServiceError, .invalidResponse) }
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 1)
    }
    func testWrongChunkIDStopsBeforeFinalize() async throws {
        let wire = UploadWire(mode: .wrongChunkID)
        do { _ = try await uploadService(wire).upload(name: "file.pdf", data: Data(count: AttachmentLimits.inlineMaximum + 1)); XCTFail("Must reject ID mismatch") }
        catch { XCTAssertEqual(error as? ServiceError, .invalidResponse) }
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 2)
    }
    func testQuotaErrorStopsWithoutRetryOrAttachmentRPC() async throws {
        let wire = UploadWire(mode: .failedChunk)
        do { _ = try await uploadService(wire).upload(name: "file.pdf", data: Data(count: AttachmentLimits.inlineMaximum + 1)); XCTFail("Must surface quota") }
        catch { XCTAssertEqual(error as? ServiceError, .server("Quota exceeded", "CLAUDEX_WEB_QUOTA_EXCEEDED")) }
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 2)
    }
    func testCancellationDuringChunkNeverFinalizesOrAttaches() async throws {
        let wire = UploadWire(mode: .holdChunk)
        let service = try uploadService(wire)
        let task = Task { try await service.upload(name: "file.pdf", data: Data(count: AttachmentLimits.chunkSize + 1)) }
        await wire.waitForChunk(); task.cancel(); await wire.releaseChunk()
        do { _ = try await task.value; XCTFail("Cancelled upload must stop") } catch is CancellationError {} catch { XCTFail("Unexpected \(error)") }
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 2)
    }
    func testDirectPresignedUploadSkipsChunksOmitsBearerAndAccepts412() async throws {
        let wire = DirectObjectWire(objectPutStatus: 412), progress = ProgressRecorder()
        let data = Data((0..<(AttachmentLimits.inlineMaximum + 29)).map { UInt8(truncatingIfNeeded: $0) })
        _ = try await RemoteClaudexService(rpc: RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "upload-tab", session: UploadSession(), transport: wire)).upload(name: "photo.png", data: data, progress: { progress.append($0) })
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 4)
        let initial = try body(requests[0])
        XCTAssertEqual(initial["direct"].bool, true)
        XCTAssertEqual(requests[1].url?.host, "objects.example.test")
        XCTAssertEqual(requests[1].httpMethod, "PUT")
        XCTAssertNil(requests[1].value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(requests[1].value(forHTTPHeaderField: "X-Claudex-Web-Tab"))
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "If-None-Match"), "*")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "X-Amz-Content-Sha256"), UploadDigest.sha256(data))
        XCTAssertEqual(requests[1].httpBody, data)
        XCTAssertTrue(requests[2].url!.path.hasSuffix("/direct-one/complete"))
        XCTAssertEqual(try body(requests[3])["args"].array?[1], .object(["$upload": .string("direct-one")]))
        let values = progress.snapshot(); XCTAssertEqual(values.first, 0); XCTAssertEqual(values.last, 1)
    }
    func testDirectPresignedUploadFallsBackToChunksWhenObjectPutFails() async throws {
        let wire = DirectObjectWire(objectPutStatus: 403)
        let data = Data((0..<(AttachmentLimits.inlineMaximum + 11)).map { UInt8(truncatingIfNeeded: $0) })
        _ = try await RemoteClaudexService(rpc: RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "upload-tab", session: UploadSession(), transport: wire)).upload(name: "file.pdf", data: data)
        let requests = await wire.captured()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "PUT", "POST", "PUT", "POST", "POST"])
        XCTAssertEqual(try body(requests[0])["direct"].bool, true)
        XCTAssertNil(try body(requests[2])["direct"].bool)
        XCTAssertTrue(requests[3].url!.path.hasSuffix("/chunk-fallback/chunks/0"))
        XCTAssertEqual(try body(requests[5])["args"].array?[1], .object(["$upload": .string("chunk-fallback")]))
    }
    func testLargeGeneratedFileDownloadsDirectObjectAndVerifiesDigest() async throws {
        let data = Data((0..<(AttachmentLimits.inlineMaximum + 23)).map { UInt8(truncatingIfNeeded: $0 * 3) })
        let digest = UploadDigest.sha256(data)
        let wire = DirectObjectWire(generatedObject: data)
        let service = RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "upload-tab", session: UploadSession(), transport: wire))
        let file = try JSONDecoder().decode(GeneratedFile.self, from: Data(#"{"id":"g1","name":"out.pdf","path":"out.pdf","language":"","state":"ready","digest":"\#(digest)","bytes":\#(data.count),"blob":true,"mime":"application/pdf"}"#.utf8))
        let resolved = try await service.generatedFileData(file)
        XCTAssertEqual(resolved, data)
        let requests = await wire.captured(); XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try body(requests[0])["args"], .array([.string(digest), .string("attachment_object")]))
        XCTAssertEqual(requests[1].url?.host, "objects.example.test")
        XCTAssertNil(requests[1].value(forHTTPHeaderField: "Authorization"))
    }
    func testConversationThumbnailReadsSignedObjectWithoutBearer() async throws {
        let data = Data([1, 3, 5])
        let wire = DirectObjectWire(generatedObject: data)
        let service = RemoteClaudexService(rpc: try RPCClient(baseURL: URL(string: "https://service.test")!, tabID: "upload-tab", session: UploadSession(), transport: wire))
        let reader = try await service.attachmentPreviewReader()
        let image = try await reader.image("photo-1", thumbnail: true, maximumBytes: 16)
        XCTAssertEqual(image?.data, data)
        XCTAssertEqual(image?.contentType, "image/png")
        let requests = await wire.captured()
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests.last?.url?.host, "objects.example.test")
        XCTAssertNil(requests.last?.value(forHTTPHeaderField: "Authorization"))
    }
}

private actor DirectObjectWire: HTTPTransport {
    let objectPutStatus: Int
    let generatedObject: Data?
    var requests: [URLRequest] = []
    init(objectPutStatus: Int = 200, generatedObject: Data? = nil) {
        self.objectPutStatus = objectPutStatus
        self.generatedObject = generatedObject
    }
    func execute(_ request: URLRequest) async throws -> (Data, Int) {
        requests.append(request)
        if request.url?.host == "objects.example.test" {
            if request.httpMethod == "GET", let generatedObject { return (generatedObject, 200) }
            return (Data(), objectPutStatus)
        }
        let path = request.url!.path
        if path.hasSuffix("/rpc/officialUiRead"), let generatedObject {
            let query = try body(request)["args"].array?.first
            if query?["path"].string == "/api/organizations" {
                let organizations = Data(#"[{"uuid":"12345678-1234-1234-1234-123456789abc"}]"#.utf8).base64EncodedString()
                return (Data(#"{"ok":true,"value":{"status":200,"body":{"$bytes":"\#(organizations)"}}}"#.utf8), 200)
            }
            if query?["path"].string == "/api/12345678-1234-1234-1234-123456789abc/files/photo-1/thumbnail",
               query?["objectTransfer"].bool == true {
                return (Data(#"{"ok":true,"value":{"status":200,"contentType":"image/png","objectTransfer":{"url":"https://objects.example.test/files/photo","size":\#(generatedObject.count)}}}"#.utf8), 200)
            }
        }
        if path.hasSuffix("/uploads") {
            let payload = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data("{}".utf8))
            if payload["direct"].bool == true {
                return (Data(#"{"ok":true,"value":{"id":"direct-one","upload":{"url":"https://objects.example.test/files/76/direct-one?X-Amz-Signature=sig"}}}"#.utf8), 200)
            }
            return (Data(#"{"ok":true,"value":{"id":"chunk-fallback"}}"#.utf8), 200)
        }
        if path.contains("/chunks/") {
            return (Data(#"{"ok":true,"value":{"id":"chunk-fallback","received":262155,"complete":true}}"#.utf8), 200)
        }
        if path.hasSuffix("/direct-one/complete") {
            return (Data(#"{"ok":true,"value":{"id":"direct-one","size":262173}}"#.utf8), 200)
        }
        if path.hasSuffix("/chunk-fallback/complete") {
            return (Data(#"{"ok":true,"value":{"id":"chunk-fallback","size":262155}}"#.utf8), 200)
        }
        if path.hasSuffix("/rpc/addAttachmentData") {
            return (Data(#"{"ok":true,"value":{"id":"attachment-one","name":"photo.png","path":"files/safe","kind":"image","size":262173}}"#.utf8), 200)
        }
        if path.hasSuffix("/rpc/readGeneratedFile"), let generatedObject {
            let digest = UploadDigest.sha256(generatedObject)
            return (Data(#"{"ok":true,"value":{"name":"out.pdf","mime":"application/pdf","attachmentObject":{"url":"https://objects.example.test/files/76/\#(digest)","size":\#(generatedObject.count)}}}"#.utf8), 200)
        }
        throw ServiceError.invalidResponse
    }
    func captured() -> [URLRequest] { requests }
}
