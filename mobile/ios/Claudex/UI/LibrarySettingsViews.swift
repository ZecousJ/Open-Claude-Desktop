import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct LibraryArtifact: Identifiable {
  let value: JSONValue
  var id: String { value["libraryId"].string ?? "" }
  var name: String { value["name"].string ?? L("artifact_name_default_title") }
  var language: String { value["language"].string ?? "text" }
  var content: String { value["content"].string ?? "" }
  var generatedFile: GeneratedFile? { try? value["generatedFile"].decode(GeneratedFile.self) }
  var origin: String? { value["originConversationId"].string }
  var identity: String {
    if let stored = value["identity"].string { return stored }
    return ArtifactIndex.identity(["library", id])
  }
  /// The official type label (`artifact_type_*`).
  var typeLabel: String {
    if generatedFile?.blob == true { return L("artifact_type_document") }
    switch language.lowercased() {
    case "html", "jsx", "tsx", "react": return L("artifact_type_interactive")
    case "svg", "png", "jpg", "jpeg", "gif", "webp": return L("artifact_type_image")
    case "mermaid": return L("artifact_type_diagram")
    case "md", "markdown", "text", "txt": return L("artifact_type_document")
    default: return L("artifact_type_code")
    }
  }
}

/// The Artifacts gallery: All / Pinned, the source filter (All / Chat / Code), search, and a two-column grid of cards
/// with the type and the source chat's time. Claudex artifacts are all the account's own, so "Yours" / "Shared with
/// you" are left out.
struct ArtifactLibraryView: View {
  @EnvironmentObject private var store: AppStore
  enum Source: String, CaseIterable, Identifiable {
    case all, chat, code
    var id: String { rawValue }
    var title: String {
      switch self {
      case .all: L("artifact_gallery_source_all")
      case .chat: L("artifact_gallery_source_chat")
      case .code: L("artifact_gallery_source_code")
      }
    }
  }
  @State private var query = ""
  @State private var pinnedOnly = false
  @State private var source: Source = .all
  private var pinned: [String] { (store.snapshot?.artifactLibrary["pinned"].array ?? []).compactMap(\.string) }
  private var conversations: [String: Conversation] {
    Dictionary(store.conversations.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
  }
  private var artifacts: [LibraryArtifact] {
    var records = store.snapshot?.artifactLibrary["copies"].array ?? []
    for conversation in store.conversations {
      for turn in conversation.turns {
        for item in turn.items { records += ArtifactIndex.fencedArtifacts(item, conversation: conversation) }
      }
      for file in ArtifactIndex.latestGeneratedFiles(conversation)
      where file.isReady && (file.content != nil || file.digest != nil) {
        let identity = ArtifactIndex.identity([conversation.id, file.path])
        records.append(.object([
          "libraryId": .string("source:" + conversation.id + ":" + file.path), "name": .string(file.name),
          "language": .string(file.language), "content": file.content.map(JSONValue.string) ?? .null,
          "generatedFile": (try? JSONValue.encode(file)) ?? .null,
          "originConversationId": .string(conversation.id), "identity": .string(identity)
        ]))
      }
    }
    let hidden = Set(
      (store.snapshot?.artifactShares ?? []).filter { $0["showInList"].bool == false }.compactMap {
        $0["identity"].string
      })
    let pinned = self.pinned
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let byID = conversations
    return records.map { LibraryArtifact(value: $0) }.filter { artifact in
      guard !hidden.contains(artifact.identity), !pinnedOnly || pinned.contains(artifact.identity) else { return false }
      guard needle.isEmpty || artifact.name.localizedCaseInsensitiveContains(needle) else { return false }
      switch source {
      case .all: return true
      case .code: return artifact.origin.flatMap { byID[$0] }?.mode == .code
      case .chat: return artifact.origin.flatMap { byID[$0] }?.mode != .code
      }
    }.sorted {
      (pinned.firstIndex(of: $0.identity) ?? Int.max) < (pinned.firstIndex(of: $1.identity) ?? Int.max)
    }
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ListSearchField(placeholder: L("artifact_gallery_search"), text: $query)
        HStack(spacing: 8) {
          ClaudeChip(title: L("artifact_gallery_tab_all"), selected: !pinnedOnly) { pinnedOnly = false }
          ClaudeChip(title: L("artifact_gallery_tab_pinned"), selected: pinnedOnly) { pinnedOnly = true }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.bottom, 12)
        .accessibilityElement(children: .contain).accessibilityLabel(L("artifact_gallery_tabs_a11y"))
        let list = artifacts
        if list.isEmpty {
          OfficialEmptyState(
            icon: .artifacts,
            text: query.isEmpty && !pinnedOnly && source == .all ? L("artifacts_empty_state") : L("artifact_gallery_no_matches")
          ).padding(.top, 48)
        }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 16) {
          ForEach(list) { artifact in
            NavigationLink {
              if let file = artifact.generatedFile, file.blob == true { GeneratedFileDetailView(file: file) }
              else { ArtifactPreviewView(artifact: artifact) }
            } label: {
              ArtifactCard(artifact: artifact, date: artifact.origin.flatMap { conversations[$0] }?.date,
                           pinned: pinned.contains(artifact.identity))
            }
            .buttonStyle(.plain)
            .contextMenu { menu(artifact) }
            .accessibilityHint(L("artifact_gallery_open_a11y"))
          }
        }.padding(.horizontal, 12)
      }.padding(.bottom, 24)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .pageTitle(L("product_name_artifacts"), serif: false)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ForEach(Source.allCases) { option in
            MenuItem(option.title, selected: source == option) { source = option }
          }
        } label: {
          HStack(spacing: 2) {
            AppGlyphView(.filter, size: 20)
            AppGlyphView(.caretDown, size: 16)
          }.foregroundStyle(Palette.text100).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(source == .all ? L("artifact_gallery_filter_a11y") : L("artifact_gallery_filter_change_a11y"))
        .accessibilityValue(source.title)
      }
    }
  }
  @ViewBuilder private func menu(_ artifact: LibraryArtifact) -> some View {
    let isPinned = pinned.contains(artifact.identity)
    MenuItem(isPinned ? L("chat_unstar") : L("chat_star"), icon: isPinned ? .pinSlash : .pin) {
      Task { await pin(artifact, !isPinned) }
    }
    if artifact.generatedFile?.blob != true {
      MenuItem(L("claudex_artifact_duplicate"), icon: .copy) { Task { await duplicate(artifact) } }
    }
    if let origin = artifact.origin, conversations[origin] != nil {
      MenuItem(L("claudex_artifact_open_source_chat"), icon: .chat) {
        store.section = .chat
        store.chatPath = [.conversation(origin)]
      }
    }
  }
  private func duplicate(_ artifact: LibraryArtifact) async {
    guard let remote = store.remote else { return }
    var fields: [String: JSONValue] = [
      "name": .string(artifact.name), "language": .string(artifact.language),
      "content": .string(artifact.content),
    ]
    if let origin = artifact.origin { fields["originConversationId"] = .string(origin) }
    do {
      let _: JSONValue = try await remote.rpc.call("duplicateArtifact", args: [.object(fields)], as: JSONValue.self)
      await store.refresh()
    } catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  private func pin(_ artifact: LibraryArtifact, _ value: Bool) async {
    guard let remote = store.remote else { return }
    do {
      let _: JSONValue = try await remote.rpc.call(
        "pinArtifact", args: [.string(artifact.identity), .bool(value)], as: JSONValue.self)
      await store.refresh()
    } catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// A gallery card: a preview tile (the start of the source in the code font, on `bg200`), the
/// name, and "type · Edited <time>".
private struct ArtifactCard: View {
  let artifact: LibraryArtifact
  let date: Date?
  let pinned: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ZStack(alignment: .topLeading) {
        Palette.bg200
        if artifact.generatedFile?.blob == true {
          AppGlyphView(.file, size: 32).foregroundStyle(Palette.text500)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          Text(String(artifact.content.prefix(240))).font(Font(TypeStyle.uiFont(family: .mono, size: 8, weight: 400)))
            .foregroundStyle(Palette.text500).lineLimit(10).padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        if pinned {
          AppGlyphView(.pinFilled, size: 16).foregroundStyle(Palette.text300).padding(8)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
      }
      .aspectRatio(4 / 3, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: Radius.r8, style: .continuous))
      .accessibilityHidden(true)
      Text(artifact.name).typeStyle(.bodyStrong).foregroundStyle(Palette.text100).lineLimit(2)
        .multilineTextAlignment(.leading)
      Text([artifact.typeLabel, date.map { L("artifact_gallery_edited", RelativeTime.string($0, capitalized: false)) }]
        .compactMap { $0 }.joined(separator: " · "))
        .typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(1)
    }
    .padding(8)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// The artifact viewer (`artifact_viewer_*`): Preview / Code, the top-bar menu with Copy, Copy to project, Print,
/// Publish, Save as and Share as, the version footer when the file was written more than once, and the official
/// comment mode.
struct ArtifactPreviewView: View {
  @EnvironmentObject private var store: AppStore
  /// The latest version of the artifact.
  let artifact: LibraryArtifact
  @State private var showSource = false
  @State private var exporting = false
  @State private var publishing = false
  @State private var publishedURL: String?
  @State private var picked: Int?
  @State private var commenting = false
  @State private var selection: String?
  @State private var commentText = ""
  private var owner: Conversation? { artifact.origin.flatMap { id in store.conversations.first { $0.id == id } } }
  /// One version per write of the file on the chat's current branch (as the web's switcher); the last is the latest.
  private var versions: [GeneratedFile] { ArtifactVersions.of(turns: owner?.turns ?? [], path: artifact.generatedFile?.path ?? "") }
  private var versioned: Bool { artifact.generatedFile?.blob != true && versions.count > 1 }
  private var index: Int { versioned ? min(max(picked ?? versions.count - 1, 0), versions.count - 1) : 0 }
  /// What the sheet shows: the picked version, or the latest.
  private var shown: LibraryArtifact { versioned && index != versions.count - 1 ? artifact.showing(versions[index]) : artifact }
  private var fileExtension: String {
    let ext = URL(fileURLWithPath: shown.name).pathExtension
    return ext.isEmpty ? shown.language : ext
  }
  private var canComment: Bool { owner != nil && shown.generatedFile?.blob != true }
  private var projectFile: (project: String, name: String)? {
    guard let project = owner?.projectId,
      let name = ArtifactProjectFile.name(title: shown.name, filename: shown.generatedFile?.name, language: shown.language, blob: shown.generatedFile?.blob == true)
    else { return nil }
    return (project, name)
  }
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        ClaudeChip(title: L("artifact_view_mode_preview"), icon: .eye, selected: !showSource && !commenting, kind: .compact) { showSource = false; commenting = false }
          .accessibilityLabel(L("artifact_button_show_preview_content_description"))
        ClaudeChip(title: L("artifact_view_mode_code"), icon: .code, selected: showSource && !commenting, kind: .compact) { showSource = true; commenting = false }
          .accessibilityLabel(L("artifact_button_show_code_content_description"))
        Spacer(minLength: 0)
        // Comment / Done commenting (ccr_artifact_viewer_comments_*): select text, then Comment.
        if canComment {
          ClaudeChip(title: L(commenting ? "ccr_artifact_viewer_comments_exit" : "ccr_artifact_viewer_comments_enter"), icon: .chatAdd, selected: commenting, kind: .compact) { commenting.toggle() }
        }
      }.padding(.horizontal, 12).padding(.vertical, 8)
      Group {
        if commenting {
          CommentableText(text: shown.content) { text in commentText = ""; selection = text }
        } else if showSource {
          SharedDocumentView(id: shown.id + ":source", language: ["md", "markdown"].contains(shown.language) ? "text" : shown.language, content: shown.content, name: shown.name)
        } else if ArtifactIndex.staticPreviewLanguage(language: shown.language, name: shown.name) != nil {
          SafeArtifactPreview(content: shown.content)
        } else {
          SharedDocumentView(id: shown.id, language: shown.language, content: shown.content, name: shown.name)
        }
      }
      .background(Palette.bg000)
      .clipShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
      .padding(.horizontal, 12).padding(.bottom, versioned ? 0 : 12)
      // Version footer: "Version %1$s of %2$s", Previous / Next (arrow icons), padding h16 v4.
      if versioned {
        HStack(spacing: 4) {
          Text(L("artifact_sheet_footer_count", index + 1, versions.count)).typeStyle(.caption).foregroundStyle(Palette.text300)
          Spacer(minLength: 0)
          ClaudeIconButton(.arrowLeft, label: L("artifact_sheet_footer_previous"), tint: index > 0 ? Palette.text100 : Palette.text500) { picked = index - 1 }
            .disabled(index == 0)
          ClaudeIconButton(.arrowRight, label: L("artifact_sheet_footer_next"), tint: index < versions.count - 1 ? Palette.text100 : Palette.text500) { picked = index + 1 }
            .disabled(index >= versions.count - 1)
        }.padding(.horizontal, 16).padding(.vertical, 4)
      }
    }
    .background(Palette.bg100.ignoresSafeArea())
    .pageTitle(shown.name, serif: false)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          MenuItem(L("artifact_sheet_menu_copy"), icon: .copy) {
            UIPasteboard.general.string = shown.content
            Snackbars.shared.toast(L("generic_copied_toast"))
          }
          if let target = projectFile {
            MenuItem(L("artifact_sheet_menu_copy_to_project"), icon: .projects) { Task { await copyToProject(target.project, name: target.name) } }
          }
          MenuItem(L("artifact_sheet_menu_print")) { printArtifact() }
          MenuItem(L("artifact_sheet_menu_publish"), icon: .share) { publishing = true }
          MenuItem(L("artifact_sheet_menu_save_as", fileExtension.uppercased()), icon: .download) { exporting = true }
          ShareLink(item: shown.content, subject: Text(shown.name)) {
            Label(L("artifact_sheet_menu_share_as", fileExtension.uppercased()), systemImage: AppGlyph.share.symbol)
          }
        } label: {
          AppGlyphView(.dotsVertical).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .foregroundStyle(Palette.text100)
        .accessibilityLabel(L("generic_button_more_options"))
      }
    }
    .alert(L("artifact_share_sheet_title"), isPresented: $publishing) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("artifact_sheet_menu_publish")) { Task { await publish() } }
    } message: { Text(L("claudex_artifact_publish_body")) }
    .alert(L("claudex_artifact_published"), isPresented: Binding(get: { publishedURL != nil }, set: { if !$0 { publishedURL = nil } })) {
      Button(L("generic_copy")) { UIPasteboard.general.string = publishedURL; Snackbars.shared.toast(L("generic_copied_toast")) }
      Button(L("generic_button_cancel"), role: .cancel) {}
    } message: { Text(publishedURL ?? "") }
    .alert(L("claudex_artifact_comment_title"), isPresented: Binding(get: { selection != nil }, set: { if !$0 { selection = nil } })) {
      TextField(L("claudex_artifact_comment_hint"), text: $commentText)
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("claudex_artifact_comment_send")) { Task { await sendComment() } }
    } message: { Text((selection ?? "").components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n").prefix(400)) }
    .fileExporter(
      isPresented: $exporting, document: ArtifactDocument(text: shown.content),
      contentType: UTType(filenameExtension: URL(fileURLWithPath: shown.name).pathExtension) ?? .plainText,
      defaultFilename: shown.name
    ) { result in
      if case .failure = result { Snackbars.shared.show(L("artifact_export_failed")) }
    }
  }
}
extension ArtifactPreviewView {
  /// Copy to project: the shown version, as a text file, in the project of this artifact's chat.
  @MainActor fileprivate func copyToProject(_ project: String, name: String) async {
    guard let remote = store.remote else { return }
    do {
      let reference = try await remote.encodedUpload(name: name, data: Data(shown.content.utf8))
      let _: JSONValue = try await remote.rpc.call(
        "addProjectKnowledgeFiles", args: [.string(project), .array([.object(["name": .string(name), "data": reference])])], as: JSONValue.self)
      Snackbars.shared.toast(L("artifact_copy_to_project_success"))
    } catch is CancellationError {} catch {
      Snackbars.shared.show(L("artifact_copy_to_project_failed"))
      store.validateSessionError(error)
    }
  }
  /// Sends the comment to the artifact's chat (the official "Artifact comment sent to Claude").
  @MainActor fileprivate func sendComment() async {
    guard let chat = owner, let quoted = selection else { return }
    let text = ArtifactComment.prompt(
      name: shown.name, comment: commentText, selection: quoted, path: shown.generatedFile?.path, digest: shown.generatedFile?.digest, content: shown.content)
    if await store.sendArtifactComment(chat, text: text) {
      commentText = ""
      Snackbars.shared.toast(L("artifact_comment_sent_title"))
    }
  }
  /// Creates the hosted link (the service's `publishArtifact`); a service without artifact sharing says so.
  @MainActor fileprivate func publish() async {
    let payload: JSONValue = .object(["identity": .string(shown.identity), "title": .string(shown.name),
                                      "language": .string(shown.language), "content": .string(shown.content)])
    do {
      let url: String? = try await store.accountRequest { remote in
        let status: JSONValue = try await remote.rpc.call("sharingStatus", as: JSONValue.self)
        guard status["artifacts"].bool == true else { return nil }
        let share: JSONValue = try await remote.rpc.call("publishArtifact", args: [payload], as: JSONValue.self)
        return share["url"].string
      }
      if let url { publishedURL = url } else { Snackbars.shared.show(L("generic_error_something_went_wrong")) }
    } catch is CancellationError {} catch {
      Snackbars.shared.show(L("generic_error_something_went_wrong"))
      store.validateSessionError(error)
    }
  }
  /// The system print sheet: HTML and SVG as a page, anything else as plain text.
  fileprivate func printArtifact() {
    let controller = UIPrintInteractionController.shared
    let info = UIPrintInfo(dictionary: nil)
    info.jobName = shown.name
    info.outputType = .general
    controller.printInfo = info
    if ArtifactIndex.staticPreviewLanguage(language: shown.language, name: shown.name) != nil {
      controller.printFormatter = UIMarkupTextPrintFormatter(markupText: shown.content)
    } else {
      controller.printFormatter = UISimpleTextPrintFormatter(text: shown.content)
    }
    controller.present(animated: true) { _, _, error in
      if error != nil { Snackbars.shared.show(L("artifact_print_failed")) }
    }
  }
}
/// Comment mode's text: the artifact's text in a selectable view where a selection offers "Comment" beside the
/// system's items.
struct CommentableText: UIViewRepresentable {
  let text: String
  let onComment: (String) -> Void
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.backgroundColor = .clear
    view.dataDetectorTypes = []
    view.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    view.textColor = UIColor(Palette.text100)
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.delegate = context.coordinator
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.onComment = onComment
    if view.text != text { view.text = text }
  }
  final class Coordinator: NSObject, UITextViewDelegate {
    var onComment: (String) -> Void = { _ in }
    func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
      guard range.length > 0, let selected = Range(range, in: textView.text).map({ String(textView.text[$0]) }) else { return UIMenu(children: suggestedActions) }
      let comment = UIAction(title: L("ccr_artifact_viewer_selection_comment"), image: UIImage(systemName: AppGlyph.chatAdd.symbol)) { [weak self] _ in
        let chosen = selected.trimmingCharacters(in: .whitespacesAndNewlines)
        if !chosen.isEmpty { self?.onComment(String(chosen.prefix(2_000))) }
      }
      return UIMenu(children: [comment] + suggestedActions)
    }
  }
}
extension LibraryArtifact {
  /// This artifact as an earlier version of its file (the footer's Previous / Next).
  func showing(_ file: GeneratedFile) -> LibraryArtifact {
    var fields = value.object ?? [:]
    fields["content"] = file.content.map(JSONValue.string) ?? .null
    fields["language"] = .string(file.language.isEmpty ? language : file.language)
    fields["generatedFile"] = (try? JSONValue.encode(file)) ?? .null
    return LibraryArtifact(value: .object(fields))
  }
}
struct ArtifactDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.plainText, .html, .json, .xml, .data] }
  var text: String
  init(text: String) { self.text = text }
  init(configuration: ReadConfiguration) throws {
    text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: Data(text.utf8))
  }
}
/// Static, non-network preview. Artifact JS, subresource requests and link navigation are disabled.
struct SafeArtifactPreview: UIViewRepresentable {
  let content: String
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.defaultWebpagePreferences.allowsContentJavaScript = false
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = context.coordinator
    view.isOpaque = true
    return view
  }
  func updateUIView(_ uiView: WKWebView, context: Context) {
    guard context.coordinator.loaded != content else { return }
    context.coordinator.loaded = content
    let policy =
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; frame-src 'none'; base-uri 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    uiView.loadHTMLString(policy + content, baseURL: nil)
  }
  final class Coordinator: NSObject, WKNavigationDelegate {
    var loaded: String?
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      decisionHandler(
        navigationAction.request.url?.absoluteString == "about:blank"
          && navigationAction.navigationType == .other ? .allow : .cancel)
    }
  }
}
