import UIKit
import UniformTypeIdentifiers

/// Puts a system share into the shared inbox and opens Claudex. Nothing is sent.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let group = "group.cn.zecous.claudex"
    private let byteLimit = 30 * 1024 * 1024

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await receive() }
    }

    private func receive() async {
        var text = ""
        var copies: [(String, Data)] = []
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        for item in items {
            for provider in item.attachments ?? [] {
                if copies.count >= 10 && !text.isEmpty { break }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let value = await load(provider, UTType.plainText.identifier) as? String {
                    text += text.isEmpty ? value : "\n" + value
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                          let url = await load(provider, UTType.url.identifier) as? URL {
                    text += text.isEmpty ? url.absoluteString : "\n" + url.absoluteString
                } else if copies.count < 10, let file = await file(from: provider) {
                    copies.append(file)
                }
            }
        }
        text = String(text.prefix(10_000))
        if let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) {
            let folder = container.appendingPathComponent("share", isDirectory: true)
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var names: [String] = []
            for (name, data) in copies where data.count <= byteLimit {
                let stored = UUID().uuidString + "-" + name
                try? data.write(to: folder.appendingPathComponent(stored), options: .atomic)
                names.append(stored)
            }
            let body = try? JSONSerialization.data(withJSONObject: ["text": text, "files": names])
            try? body?.write(to: folder.appendingPathComponent("inbox.json"), options: .atomic)
            openHost(URL(string: "claudex://share"))
        } else if !text.isEmpty, let encoded = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                  let url = URL(string: "claudex://new?q=\(encoded.prefix(1500))") {
            openHost(url)
        } else {
            finish()
        }
    }

    private func file(from provider: NSItemProvider) async -> (String, Data)? {
        let type = [UTType.fileURL.identifier, UTType.image.identifier, UTType.data.identifier].first { provider.hasItemConformingToTypeIdentifier($0) }
        guard let type, let value = await load(provider, type) else { return nil }
        if let url = value as? URL, url.isFileURL, let data = try? Data(contentsOf: url) {
            return (url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent, data)
        }
        if let image = value as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
            return ("photo.jpg", data)
        }
        if let data = value as? Data { return ("file", data) }
        return nil
    }

    private func load(_ provider: NSItemProvider, _ type: String) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type) { value, _ in
                continuation.resume(returning: value as? NSSecureCoding)
            }
        }
    }

    private func openHost(_ url: URL?) {
        guard let url else { finish(); return }
        extensionContext?.open(url) { _ in self.finish() }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: [])
    }
}
