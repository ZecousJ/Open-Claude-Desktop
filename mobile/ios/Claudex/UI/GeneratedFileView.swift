import SwiftUI
import UniformTypeIdentifiers

struct GeneratedFileDetailView: View {
    @EnvironmentObject private var store: AppStore
    let file: GeneratedFile
    @State private var url: URL?
    @State private var data: Data?
    @State private var error: String?
    @State private var loading = false
    @State private var retry = UUID()
    @State private var exporting = false
    @State private var showSource = false
    /// The official document preview sheet (FilePreviewSheet.swift): the preview fills the sheet under its
    /// header, one full-width Download sits under it; states read as the official lines.
    var body: some View {
        VStack(spacing: 0) {
            Group {
                if loading {
                    ClaudeSpinner().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if error != nil {
                    FilePreviewLine(key: "document_preview_load_failed")
                } else if let url, let data {
                    preview(url: url, data: data)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, 12)
            .clipped()
            if !loading, error == nil, data != nil {
                FilePreviewDownloadButton { exporting = true }
            }
        }
        .background(Palette.bg100).navigationTitle(file.name).navigationBarTitleDisplayMode(.inline)
            .task(id: retry) { await load() }
            .onDisappear { cleanup() }
            .fileExporter(isPresented: $exporting, document: GeneratedBinaryDocument(data: data ?? Data()), contentType: contentType, defaultFilename: file.safeName) { result in
                if case .failure(let failure) = result { store.errorMessage = failure.localizedDescription }
            }
    }
    @ViewBuilder private func preview(url: URL, data: Data) -> some View {
        if let mime = file.mime, mime.hasPrefix("image/"), mime != "image/svg+xml", let image = UIImage(data: data) {
            ZoomableImage(image: image, label: file.name)
        } else if ArtifactIndex.staticPreviewLanguage(language: file.language, name: file.name, mime: file.mime) != nil,
                  let content = String(data: data, encoding: .utf8) {
            VStack(spacing: 12) {
                // The same Preview / Code chips as the artifact page (the system's segmented control is not a Claude control).
                HStack(spacing: 8) {
                    ClaudeChip(title: L("artifact_view_mode_preview"), icon: .eye, selected: !showSource, kind: .compact) { showSource = false }
                        .accessibilityLabel(L("artifact_button_show_preview_content_description"))
                    ClaudeChip(title: L("artifact_view_mode_code"), icon: .code, selected: showSource, kind: .compact) { showSource = true }
                        .accessibilityLabel(L("artifact_button_show_code_content_description"))
                    Spacer(minLength: 0)
                }.padding(.horizontal, 12)
                if showSource {
                    SharedDocumentView(id: file.id, language: file.language, content: content, name: file.name)
                } else { SafeArtifactPreview(content: content) }
            }
        } else if file.blob != true, let content = String(data: data, encoding: .utf8) {
            SharedDocumentView(id: file.id, language: file.language, content: content, name: file.name)
        } else if file.quickLookAllowed {
            QuickLookPreview(url: url)
        } else {
            FilePreviewLine(key: "document_preview_bottom_sheet_unavailable")
        }
    }
    private var contentType: UTType { UTType(filenameExtension: (file.safeName as NSString).pathExtension) ?? .data }
    private func cleanup() {
        if let url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        url = nil; data = nil
    }
    @MainActor private func load() async {
        cleanup(); error = nil; loading = true
        defer { loading = false }
        do {
            let result = try await store.materializeGeneratedFile(file)
            do { try Task.checkCancellation() } catch {
                try? FileManager.default.removeItem(at: result.url.deletingLastPathComponent()); throw error
            }
            url = result.url; data = result.data
        } catch is CancellationError {} catch { self.error = error.localizedDescription; store.validateSessionError(error) }
    }
}
struct GeneratedBinaryDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
