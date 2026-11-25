import Foundation

enum ComposerDraftScope: Hashable, Codable {
    case new(ChatMode)
    case project(String)
    case conversation(String)
}

enum ComposerProjectChoice: Codable, Equatable {
    case none
    case project(String)
}

struct ComposerDraft: Codable {
    var text = ""
    var files: [LocalAttachment] = []
    var project: ComposerProjectChoice?

    var isEmpty: Bool { text.isEmpty && files.isEmpty && project == nil }

    func restoring(_ sent: ComposerDraft) -> ComposerDraft {
        var draft = self
        if draft.text.isEmpty { draft.text = sent.text }
        else if !sent.text.isEmpty && draft.text != sent.text { draft.text = sent.text + "\n\n" + draft.text }
        let savedIDs = Set(draft.files.map(\.id))
        draft.files.insert(contentsOf: sent.files.filter { !savedIDs.contains($0.id) }, at: 0)
        return draft
    }
}

enum ScheduleDraftScope: Hashable, Codable {
    case new
    case existing(String)
}

struct PendingComposerSend: Codable {
    var input: SendInput
    var draft: ComposerDraft
    var supportsReceipts: Bool?
    var uploadFailed: Bool? = nil

    func canRetry(currentSupport: Bool) -> Bool {
        if uploadFailed == true { return true }
        return supportsReceipts == true && currentSupport
    }
}

struct ComposerDraftArchive: Codable {
    var drafts: [ComposerDraftScope: ComposerDraft] = [:]
    var schedulePrompts: [ScheduleDraftScope: String] = [:]
    var repository: RepositoryReference?
    var pendingSends: [ComposerDraftScope: PendingComposerSend]?
    var pendingCodeSubmissions: [String: CodeQueueSubmission]?
}

struct ComposerDraftStorage {
    let directory: URL

    init?(root: URL, origin: URL, account: String) {
        let safeCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard let host = origin.host?.lowercased(),
              let name = account.addingPercentEncoding(withAllowedCharacters: safeCharacters) else { return nil }
        directory = root
            .appendingPathComponent("\(host)-\(origin.port ?? 443)", isDirectory: true)
            .appendingPathComponent("account-\(name)", isDirectory: true)
    }

    var attachmentsDirectory: URL { directory.appendingPathComponent("Attachments", isDirectory: true) }
    private var archiveURL: URL { directory.appendingPathComponent("drafts.json") }

    func load() throws -> ComposerDraftArchive {
        let data: Data
        do { data = try Data(contentsOf: archiveURL) }
        catch CocoaError.fileReadNoSuchFile { return ComposerDraftArchive() }

        var archive = try JSONDecoder().decode(ComposerDraftArchive.self, from: data)
        archive.drafts = archive.drafts.mapValues { draft in
            var draft = draft
            draft.files = draft.files.compactMap { attachment in
                var file = attachment
                file.url = attachmentsDirectory.appendingPathComponent(file.url.lastPathComponent)
                return FileManager.default.fileExists(atPath: file.url.path) ? file : nil
            }
            return draft
        }
        archive.pendingSends = archive.pendingSends?.mapValues { pending in
            var pending = pending
            pending.draft.files = pending.draft.files.compactMap { attachment in
                var file = attachment
                file.url = attachmentsDirectory.appendingPathComponent(file.url.lastPathComponent)
                return FileManager.default.fileExists(atPath: file.url.path) ? file : nil
            }
            return pending
        }
        return archive
    }

    func remove() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    func prepareDirectory() throws {
        guard !FileManager.default.fileExists(atPath: directory.path) else { return }
        var folder = directory
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
    }

    func save(_ archive: ComposerDraftArchive) throws {
        try prepareDirectory()

        try JSONEncoder().encode(archive).write(to: archiveURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
