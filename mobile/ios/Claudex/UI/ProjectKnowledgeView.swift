import SwiftUI
import UniformTypeIdentifiers

/// Project Knowledge: capacity header, the file grid (adaptive 120pt, 12pt spacing), long-press Delete, and the
/// full-width "Add Content" button opening the Add Content sheet. The service keeps text files and PDFs only, so the
/// camera and photo options of the official sheet are left out.
struct ProjectKnowledgeView: View {
  @EnvironmentObject private var store: AppStore
  let project: Project
  @State private var knowledge: JSONValue = .null
  @State private var loaded = false
  @State private var failed = false
  @State private var uploading: [String] = []
  @State private var adding = false
  @State private var importing = false
  @State private var creatingDoc = false
  @State private var deleting: String?
  private var files: [JSONValue] {
    (knowledge["files"].array ?? []).sorted { ($0["addedAt"].number ?? 0) > ($1["addedAt"].number ?? 0) }
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let limit = knowledge["limit"].number, limit > 0 {
          capacity(used: knowledge["bytes"].number ?? 0, limit: limit)
        }
        if !loaded {
          ListLoading()
        } else if failed && files.isEmpty {
          OfficialErrorState(text: L("generic_error_something_went_wrong")) { Task { await load() } }
        } else if files.isEmpty && uploading.isEmpty {
          OfficialEmptyState(icon: .fileAdd, text: L("project_knowledge_screen_empty_state_title", project.name))
            .padding(.top, 48)
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 12)], spacing: 12) {
            ForEach(uploading, id: \.self) { name in KnowledgeTile(name: name, detail: nil, uploading: true) }
            ForEach(Array(files.enumerated()), id: \.offset) { _, file in
              let name = file["name"].string ?? ""
              KnowledgeTile(
                name: name,
                detail: ByteCountFormatter.string(fromByteCount: Int64(file["bytes"].number ?? 0), countStyle: .file),
                uploading: false
              )
              .contextMenu {
                MenuItem(L("project_knowledge_delete_doc_button"), icon: .trash, destructive: true) { deleting = name }
              }
            }
          }
        }
      }
      .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
    }
    .background(Palette.bg100.ignoresSafeArea())
    .refreshable { await load() }
    .pageTitle(L("project_knowledge_screen_title"), serif: false)
    .safeAreaInset(edge: .bottom) {
      Button(L("project_knowledge_add_content_button")) { adding = true }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(store.account == nil)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Palette.bg100)
        .accessibilityIdentifier("knowledge-add-content")
    }
    .task { await load() }
    .sheet(isPresented: $adding) {
      AddContentSheet(
        upload: { adding = false; Task { try? await Task.sleep(for: .milliseconds(350)); importing = true } },
        create: { adding = false; Task { try? await Task.sleep(for: .milliseconds(350)); creatingDoc = true } })
    }
    .sheet(isPresented: $creatingDoc) {
      CreateKnowledgeDocView(project: project) { result in knowledge = result }
        .claudeSheetChrome([.large])
    }
    .fileImporter(
      isPresented: $importing,
      allowedContentTypes: [.plainText, .pdf, .commaSeparatedText, .json, .xml, .html, .sourceCode, .text],
      allowsMultipleSelection: true
    ) { result in
      switch result {
      case .success(let urls): Task { for url in urls { await upload(url) } }
      case .failure(let error): store.errorMessage = error.localizedDescription
      }
    }
    .alert(
      L("project_knowledge_delete_doc_dialog_title"),
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    ) {
      Button(L("generic_button_cancel"), role: .cancel) { deleting = nil }
      Button(L("project_knowledge_delete_doc_button"), role: .destructive) {
        if let name = deleting { Task { await remove(name) } }
        deleting = nil
      }
    } message: {
      Text(L("delete_dialog_default_subtitle"))
    }
  }

  /// Capacity header: 8pt bar, label "N% of project capacity used".
  private func capacity(used: Double, limit: Double) -> some View {
    let fraction = max(0, min(1, used / limit))
    return VStack(alignment: .leading, spacing: 8) {
      CapacityBar(fraction: fraction)
      Text(L("project_knowledge_capacity_used", Int((fraction * 100).rounded()))).typeStyle(.body)
        .foregroundStyle(Palette.text300)
    }
    .accessibilityElement(children: .combine)
  }

  private func load() async {
    guard let remote = store.remote else { loaded = true; return }
    do {
      knowledge = try await remote.rpc.call("listProjectKnowledge", args: [.string(project.id)], as: JSONValue.self)
      failed = false
    } catch {
      failed = true
      store.validateSessionError(error)
    }
    loaded = true
  }

  private func upload(_ url: URL) async {
    guard let remote = store.remote else { return }
    let name = url.lastPathComponent
    uploading.append(name)
    defer { uploading.removeAll { $0 == name } }
    let accessed = url.startAccessingSecurityScopedResource()
    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
    do {
      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      let limit = min(10_000_000, knowledge["fileLimit"].integer ?? 10_000_000)
      guard size <= limit else {
        Snackbars.shared.show(
          L("project_knowledge_file_too_large_error",
            ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .file)), kind: .warning)
        return
      }
      let data = try Data(contentsOf: url, options: .mappedIfSafe)
      let reference = try await remote.encodedUpload(name: name, data: data)
      knowledge = try await remote.rpc.call(
        "addProjectKnowledgeFiles",
        args: [.string(project.id), .array([.object(["name": .string(name), "data": reference])])],
        as: JSONValue.self)
    } catch {
      Snackbars.shared.show(L("project_knowledge_upload_failed"), kind: .warning)
      store.validateSessionError(error)
    }
  }

  private func remove(_ name: String) async {
    guard let remote = store.remote else { return }
    do {
      knowledge = try await remote.rpc.call(
        "removeProjectKnowledge", args: [.string(project.id), .string(name)], as: JSONValue.self)
    } catch {
      store.errorMessage = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}

/// A knowledge tile: square, `bg300`, 16pt corners; file glyph, the name on two lines, size.
private struct KnowledgeTile: View {
  let name: String
  let detail: String?
  let uploading: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if uploading {
        ClaudeSpinner(size: .xSmall)
      } else {
        AppGlyphView(name.lowercased().hasSuffix(".pdf") ? .file : .bookText).foregroundStyle(Palette.text300)
      }
      Spacer(minLength: 0)
      Text(uploading ? L("project_knowledge_uploading") : name).typeStyle(.captionStrong)
        .foregroundStyle(Palette.text100).lineLimit(2)
      if uploading {
        Text(name).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(1)
      } else if let detail {
        Text(detail).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(1)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .aspectRatio(1, contentMode: .fit)
    .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// "Add Content to Project": title, subtitle, centred option buttons (12pt corners, `bg300`, 12pt padding, icon +
/// label), 8pt apart.
private struct AddContentSheet: View {
  let upload: () -> Void
  let create: () -> Void
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("project_knowledge_add_content_sheet_title"))
      Text(L("project_knowledge_add_content_sheet_subtitle")).typeStyle(.body).foregroundStyle(Palette.text500)
        .multilineTextAlignment(.center).padding(.horizontal, 24)
      VStack(spacing: 8) {
        option(L("project_knowledge_upload_button"), icon: .fileUpload, action: upload)
          .accessibilityIdentifier("knowledge-upload")
        option(L("project_knowledge_create_button"), icon: .edit, action: create).padding(.top, 8)
          .accessibilityIdentifier("knowledge-create")
      }
      .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 8)
      Spacer(minLength: 0)
    }
    .claudeSheetChrome([.height(280)])
  }
  private func option(_ title: String, icon: AppGlyph, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 8) {
        AppGlyphView(icon)
        Text(title).typeStyle(.bodyStrong)
      }
      .foregroundStyle(Palette.text100)
      .padding(12).frame(maxWidth: .infinity).frame(minHeight: 48)
      .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    }.buttonStyle(.plain)
  }
}

/// Create new document (`CreateDoc`): title and content fields (content 3–10 lines), saved as a
/// text file in the project.
private struct CreateKnowledgeDocView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  let project: Project
  let saved: (JSONValue) -> Void
  @State private var title = ""
  @State private var content = ""
  @State private var busy = false
  @State private var error: String?
  private var fileName: String {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.contains(".") ? trimmed : trimmed + ".md"
  }
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("project_knowledge_create_button"))
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          Text(L("create_project_doc_title_field_label")).typeStyle(.body).foregroundStyle(Palette.text300)
          ClaudeTextField(L("create_project_doc_title_field_label"), text: $title, shape: .rounded, identifier: "knowledge-doc-title")
            .padding(.bottom, 8)
          Text(L("create_project_doc_content_field_label")).typeStyle(.body).foregroundStyle(Palette.text300)
          DialogTextArea(placeholder: L("create_project_doc_content_field_label"), text: $content)
          if let error { InlineNotice(text: error, tone: .error).padding(.top, 8) }
        }.padding(.horizontal, Spacing.sheetGutter).padding(.vertical, 12)
      }
      Button {
        Task { await save() }
      } label: {
        if busy { ClaudeSpinner(size: .xSmall, color: Palette.primaryContent) } else { Text(L("generic_save")) }
      }
      .claudeButton(.primary, size: .large, fullWidth: true)
      .disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.isEmpty)
      .padding(.horizontal, Spacing.sheetGutter).padding(.vertical, 16)
    }
    .background(Palette.bg100)
    .interactiveDismissDisabled(busy)
  }
  private func save() async {
    guard let remote = store.remote else { return }
    busy = true
    defer { busy = false }
    do {
      let result = try await remote.rpc.call(
        "addProjectKnowledgeText",
        args: [.string(project.id), .object(["name": .string(fileName), "text": .string(content)])],
        as: JSONValue.self)
      saved(result)
      dismiss()
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}
