import CryptoKit
import Darwin
import Foundation

guard SecureEnclave.isAvailable else { exit(2) }
guard CommandLine.arguments.count == 3 else { exit(3) }

let operation = CommandLine.arguments[1]
let file = URL(fileURLWithPath: CommandLine.arguments[2])

do {
    let key: SecureEnclave.P256.Signing.PrivateKey
    switch operation {
    case "public", "rotate":
        if operation == "public", FileManager.default.fileExists(atPath: file.path) {
            key = try .init(dataRepresentation: Data(contentsOf: file))
        } else {
            key = try .init(compactRepresentable: false)
            let manager = FileManager.default
            try manager.createDirectory(at: file.deletingLastPathComponent(),
                                        withIntermediateDirectories: true,
                                        attributes: [.posixPermissions: 0o700])
            _ = umask(0o077)
            try key.dataRepresentation.write(to: file, options: .atomic)
        }
        print(key.publicKey.derRepresentation.base64EncodedString())
    case "sign":
        guard let line = readLine(), let preimage = Data(base64Encoded: line) else { exit(3) }
        key = try .init(dataRepresentation: Data(contentsOf: file))
        print(try key.signature(for: preimage).rawRepresentation.base64EncodedString())
    default:
        exit(3)
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(3)
}
