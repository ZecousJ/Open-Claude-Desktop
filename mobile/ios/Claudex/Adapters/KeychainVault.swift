import Foundation
import Security

/// One atomic Keychain item, device-only, inaccessible while the device is locked.
final class KeychainVault: TokenVault, @unchecked Sendable {
    private let service: String
    private let lock = NSLock()
    init(service: String) { self.service = service }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "native-session"] }
    func read() throws -> StoredSession? {
        lock.lock(); defer { lock.unlock() }
        var attributes = query; attributes[kSecReturnData as String] = true; attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw VaultError(status: status) }
        return try JSONDecoder().decode(StoredSession.self, from: data)
    }
    func write(_ session: StoredSession?) throws {
        lock.lock(); defer { lock.unlock() }
        guard let session else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError(status: status) }; return
        }
        let data = try JSONEncoder().encode(session)
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            let insert = query.merging(update) { _, new in new }
            let added = SecItemAdd(insert as CFDictionary, nil)
            guard added == errSecSuccess else { throw VaultError(status: added) }
        } else if status != errSecSuccess { throw VaultError(status: status) }
    }
    private struct VaultError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "无法安全保存会话（Keychain \(status)），请解锁设备后重试。" }
    }
}
