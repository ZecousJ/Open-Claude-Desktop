import SwiftUI

struct RepositoryPickerView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @State private var status: JSONValue = .null
  @State private var repositories: [JSONValue] = []
  @State private var branches: [JSONValue] = []
  @State private var selected: JSONValue?
  @State private var branch = ""
  @State private var query = ""
  @State private var nextPage: Int?
  @State private var nextBranchPage: Int?
  @State private var error: String?
  @State private var busy = false
  @State private var authorizationURL: URL?
  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: selected == nil ? L("code_project_repos_title") : L("ccr_choose_base_branch"))
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          github
          if let error { InlineNotice(text: error).padding(.horizontal, 12) }
          if let selected { branchList(selected) } else { repositoryList }
          if busy { ListLoading() }
        }.padding(.vertical, 8)
      }
      if selected != nil {
        Button(L("claudex_code_use_branch")) { useSelection() }
          .claudeButton(.primary, size: .large, fullWidth: true).disabled(branch.isEmpty)
          .padding(.horizontal, 16).padding(.vertical, 12)
      }
    }
    .background(Palette.bg100)
    .claudeSheetChrome([.large])
    .task { await loadStatus() }.task(id: query) {
      do {
        try await Task.sleep(for: .milliseconds(350))
        if status["connected"].bool == true { await loadRepositories() }
      } catch {}
    }
    .onChange(of: phase) { _, next in if next == .active { Task { await loadStatus() } } }
  }

  /// GitHub connection: "Connect to GitHub" only while not connected; once connected the list is shown directly.
  @ViewBuilder private var github: some View {
    if status["connected"].bool != true && status != .null {
      connectGroup
    }
  }

  private var connectGroup: some View {
    SettingsGroup {
      if status["configured"].bool == false {
        SettingsRow(icon: .github, title: L("ccr_connect_github_title"), subtitle: L("claudex_github_not_configured"), subtitleLines: 2)
      } else if let authorizationURL {
        Link(destination: authorizationURL) {
          SettingsRow(icon: .github, title: L("ccr_connect_github_title"), subtitle: L("claudex_github_authorize_hint"), subtitleLines: 2) {
            AppGlyphView(.arrowOutSquare, size: 20).foregroundStyle(Palette.text300)
          }
        }.buttonStyle(SettingsRowPressStyle())
      } else {
        SettingsButton(icon: .github, title: L("ccr_connect_github_title")) { Task { await prepareAuthorization() } }
          .disabled(busy)
      }
    }
  }

  @ViewBuilder private var repositoryList: some View {
    if status["connected"].bool == true {
      ListSearchField(placeholder: L("claudex_code_search_repositories"), text: $query).padding(.vertical, -12)
      VStack(spacing: 0) {
        ForEach(Array(repositories.enumerated()), id: \.offset) { _, repository in
          Button {
            selected = repository
            branches = []
            nextBranchPage = nil
            branch = repository["default_branch"].string ?? ""
            Task { await loadBranches(repository) }
          } label: {
            pickerRow(
              icon: repository["private"].bool == true ? .lock : .globe,
              title: repository["full_name"].string ?? "",
              subtitle: repository["description"].string,
              checked: repository["clone_url"].string == store.preparedRepository?.url)
          }.buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
        }
        if let nextPage {
          Button(L("claudex_load_more")) { Task { await loadRepositories(page: nextPage) } }
            .claudeButton(.borderless, size: .small).padding(.vertical, 8)
        }
      }
      if repositories.isEmpty && !busy {
        OfficialEmptyState(icon: .searchCircle, text: L("ccr_no_repositories_found"), iconSize: 48).padding(.top, 16)
      }
    }
  }

  private func branchList(_ repository: JSONValue) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { self.selected = nil } label: {
        HStack(spacing: 8) {
          AppGlyphView(.caretLeft, size: 20)
          Text(repository["full_name"].string ?? "").typeStyle(.bodyStrong).lineLimit(1)
        }.foregroundStyle(Palette.text300).padding(.horizontal, 24).frame(minHeight: 44)
      }.buttonStyle(.plain).accessibilityLabel(L("generic_back_button_content_description"))
      ForEach(Array(branches.enumerated()), id: \.offset) { _, item in
        let name = item["name"].string ?? ""
        Button { branch = name } label: {
          pickerRow(
            icon: item["protected"].bool == true ? .lock : .branch, title: name, subtitle: nil, checked: branch == name,
            suffix: name == repository["default_branch"].string ? L("ccr_default_branch_label") : nil)
        }.buttonStyle(RowPressStyle(radius: Radius.r10)).padding(.horizontal, 12)
      }
      if branches.isEmpty && !busy && error == nil {
        Text(L("ccr_no_branches_found")).typeStyle(.body).foregroundStyle(Palette.text500)
          .frame(maxWidth: .infinity).padding(24)
      }
      if let nextBranchPage {
        Button(L("claudex_load_more")) { Task { await loadBranches(repository, page: nextBranchPage) } }
          .claudeButton(.borderless, size: .small).padding(.vertical, 8).frame(maxWidth: .infinity)
      }
    }
  }

  private func pickerRow(icon: AppGlyph, title: String, subtitle: String?, checked: Bool, suffix: String? = nil) -> some View {
    HStack(spacing: 12) {
      AppGlyphView(icon).foregroundStyle(Palette.textSecondary)
      VStack(alignment: .leading, spacing: 0) {
        Text(title).typeStyle(.bodyLarge).foregroundStyle(Palette.text100).lineLimit(1)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle).typeStyle(.body).foregroundStyle(Palette.text500).lineLimit(1)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      if let suffix { Text(suffix).typeStyle(.caption).foregroundStyle(Palette.text500) }
      if checked { AppGlyphView(.check, size: 20).foregroundStyle(Palette.text100) }
    }
    .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 56)
    .contentShape(RoundedRectangle(cornerRadius: Radius.r10, style: .continuous))
  }

  private func useSelection() {
    if let url = selected?["clone_url"].string, let parsed = URL(string: url),
      parsed.scheme == "https", parsed.user == nil, parsed.password == nil
    {
      store.preparedRepository = RepositoryReference(url: url, ref: branch.isEmpty ? nil : branch)
      dismiss()
    } else {
      error = L("claudex_code_unsafe_repository")
    }
  }
  private func loadStatus() async {
    guard let direct = store.direct, store.account != nil else {
      error = L("login_sign_in_again_title")
      return
    }
    busy = true
    defer { busy = false }
    do {
      status = try await direct.request("api/v1/claudex/web/github")
      if status["connected"].bool == true {
        authorizationURL = nil
        await loadRepositories()
      }
    } catch { self.error = L("ccr_failed_to_load_repositories") }
  }
  private func loadRepositories(page: Int = 1) async {
    guard let direct = store.direct else { return }
    let search = query
    do {
      let value = try await direct.request(
        "api/v1/claudex/web/github/repos", query: ["query": search, "page": String(page)])
      guard query == search, !Task.isCancelled else { return }
      if page == 1 { repositories = [] }
      repositories += value["items"].array ?? []
      nextPage = value["next_page"].integer
      error = value["truncated"].bool == true ? L("claudex_code_search_truncated") : nil
    } catch { if !(error is CancellationError) { self.error = L("ccr_failed_to_load_repositories") } }
  }
  private func loadBranches(_ repository: JSONValue, page: Int = 1) async {
    guard let direct = store.direct, let name = repository["full_name"].string else { return }
    do {
      let value = try await direct.request(
        "api/v1/claudex/web/github/branches", query: ["repo": name, "page": String(page)])
      guard selected?["full_name"].string == name else { return }
      if page == 1 { branches = [] }
      branches += value["items"].array ?? []
      nextBranchPage = value["next_page"].integer
    } catch { self.error = L("ccr_failed_to_load_branches") }
  }
  private func prepareAuthorization() async {
    guard let direct = store.direct else { return }
    busy = true
    defer { busy = false }
    do {
      let value = try await direct.request(
        "api/v1/claudex/web/github/connect", method: "POST", body: .object([:]))
      guard let address = value["authorize_url"].string, let url = URL(string: address),
        url.scheme == "https", url.host?.lowercased() == "github.com", url.user == nil,
        url.password == nil
      else { throw ServiceError.invalidResponse }
      authorizationURL = url
    } catch { self.error = L("generic_error_something_went_wrong_try_again") }
  }
}
