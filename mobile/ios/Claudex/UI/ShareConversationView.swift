import SwiftUI

/// "Share snapshot": a "Who has access" card with the access levels Claudex supports (Private / Invite-only / Public
/// — no organisation level), then "Share link" / "Update and share link" and the "Only messages up to this point will
/// be shared" caption. Claudex keeps its invite-by-email list for invite-only links.
struct ShareConversationView: View {
  enum Access: String, CaseIterable { case none, invited, link }
  @EnvironmentObject private var store: AppStore
  let conversation: Conversation?
  @State private var policy: JSONValue = .null
  @State private var share: JSONValue = .null
  @State private var access: Access = .invited
  @State private var invite = ""
  @State private var error: String?
  @State private var loading = true
  @State private var busy = false
  @State private var confirmUnshare = false
  @State private var confirmInvite = false
  private var shared: Bool { share != .null }
  private var available: Bool { policy["conversations"].bool == true || shared }
  private var shareURL: URL? {
    let address = share["access"].string == "invited" ? share["inviteUrl"].string : share["url"].string
    guard let address, let url = URL(string: address), url.scheme == "https", url.user == nil, url.password == nil else { return nil }
    return url
  }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: L("chat_sharing_snapshot_title"))
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          if loading {
            ClaudeSpinner(size: .large).frame(maxWidth: .infinity).padding(32)
              .accessibilityLabel(L("usage_meter_row_loading"))
          } else if !available {
            Text(policy == .null && error != nil ? L("chat_share_blocked_generic") : L("claudex_share_unavailable"))
              .typeStyle(.body).foregroundStyle(Palette.text500).multilineTextAlignment(.center)
              .frame(maxWidth: .infinity).padding(.vertical, 32)
          } else {
            Spacer().frame(height: 4)
            Text(L("who_has_access_title")).typeStyle(.captionStrong).foregroundStyle(Palette.text500)
              .textCase(.uppercase).accessibilityAddTraits(.isHeader)
            accessCard
            Spacer().frame(height: 8)
            mainButton
            Text(shareCaption).typeStyle(.caption).foregroundStyle(Palette.text500)
              .multilineTextAlignment(.center).frame(maxWidth: .infinity)
            if let shareURL { linkRow(shareURL).padding(.top, 8) }
            if shared && access == .invited && share["access"].string == "invited" { invites.padding(.top, 8) }
          }
          if let error { InlineNotice(text: error, tone: .error).padding(.top, 8) }
        }
        .padding(.horizontal, Spacing.sheetGutter).padding(.bottom, 24)
      }
    }
    .claudeSheetChrome([.large])
    .task { await load() }
    .alert(L("shared_links_unshare_dialog_title"), isPresented: $confirmUnshare) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("shared_links_unshare_button"), role: .destructive) { Task { await unshare() } }
    } message: { Text(L("shared_links_unshare_dialog_description", conversation?.title ?? "")) }
    .alert(L("claudex_share_invite_confirm", invite.trimmingCharacters(in: .whitespacesAndNewlines)), isPresented: $confirmInvite) {
      Button(L("generic_button_cancel"), role: .cancel) {}
      Button(L("claudex_share_invite_button")) { Task { await sendInvite() } }
    }
  }

  private var shareCaption: String {
    if let timestamp = share["snapshotAt"].number, access != .none {
      return L("chat_sharing_subtext") + "\n" + L("claudex_share_snapshot_time", Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .abbreviated, time: .shortened))
    }
    return L("chat_sharing_subtext")
  }

  private var accessCard: some View {
    VStack(spacing: 0) {
      accessRow(.none, icon: .lock, title: L("share_status_private_description"), label: L("share_private_icon_content_description"))
      Rectangle().fill(Palette.border200).frame(height: 0.5)
      accessRow(.invited, icon: .users, title: L("share_status_invite_only_description"), label: L("share_invite_only_icon_content_description"))
      Rectangle().fill(Palette.border200).frame(height: 0.5)
      accessRow(.link, icon: .globe, title: L("share_status_public_description"), label: L("share_public_icon_content_description"))
    }
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border200, lineWidth: 0.5))
    .clipShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
  }

  private func accessRow(_ value: Access, icon: AppGlyph, title: String, label: String) -> some View {
    Button { access = value } label: {
      HStack(spacing: 12) {
        AppGlyphView(icon, size: 20).foregroundStyle(Palette.text300).accessibilityLabel(label)
        Text(title).typeStyle(.body).foregroundStyle(Palette.text100).frame(maxWidth: .infinity, alignment: .leading)
        if access == value { AppGlyphView(.check, size: 20).foregroundStyle(Palette.text100) }
      }
      .padding(.horizontal, 16).frame(minHeight: 52)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .accessibilityAddTraits(access == value ? .isSelected : [])
  }

  @ViewBuilder private var mainButton: some View {
    if access == .none {
      // Private: a shared link can be withdrawn; an unshared chat is already private.
      Button(L("shared_links_unshare_button")) { confirmUnshare = true }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(busy || !shared)
        .frame(maxWidth: .infinity)
    } else {
      Button(shared ? L("share_update_link_button") : L("share_link_button")) { Task { await shareLink() } }
        .claudeButton(.primary, size: .large, fullWidth: true)
        .disabled(busy || policy["conversations"].bool != true)
        .overlay { if busy { ClaudeSpinner(size: .small) } }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("share-link")
    }
  }

  private func linkRow(_ url: URL) -> some View {
    HStack(spacing: 8) {
      AppGlyphView(.link, size: 20).foregroundStyle(Palette.text500)
      Text(url.absoluteString).typeStyle(.caption).foregroundStyle(Palette.text300).lineLimit(1).truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button(L("copy_link")) {
        UIPasteboard.general.string = url.absoluteString
        Snackbars.shared.toast(L("generic_copied_toast"))
      }.claudeButton(.secondary, size: .small)
    }
    .padding(.leading, 16).padding(.trailing, 8).frame(minHeight: 52)
    .overlay(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous).strokeBorder(Palette.border300, lineWidth: 1))
  }

  private var invites: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        ClaudeTextField(L("claudex_share_invite_placeholder"), text: $invite)
          .textContentType(.emailAddress).keyboardType(.emailAddress)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
        Button(L("claudex_share_invite_button")) { confirmInvite = true }
          .claudeButton(.secondary, size: .small)
          .disabled(busy || !invite.contains("@") || !invite.contains("."))
      }
      ForEach((share["invites"].array ?? []).compactMap(\.string), id: \.self) { email in
        HStack(spacing: 12) {
          AppGlyphView(.user, size: 20).foregroundStyle(Palette.text500)
          Text(email).typeStyle(.body).foregroundStyle(Palette.text100).frame(maxWidth: .infinity, alignment: .leading)
          Text(L("claudex_share_invited")).typeStyle(.caption).foregroundStyle(Palette.text500)
        }.frame(minHeight: 40)
      }
    }
  }

  private func load() async {
    guard let conversation, let remote = store.remote else { loading = false; return }
    defer { loading = false }
    do {
      policy = try await remote.rpc.call("sharingStatus", as: JSONValue.self)
      share = try await remote.rpc.call("conversationShare", args: [.string(conversation.id)], as: JSONValue.self)
      access = shared ? (Access(rawValue: share["access"].string ?? "link") ?? .link) : .invited
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  private func shareLink() async {
    guard let conversation, let remote = store.remote, access != .none else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      if shared && (share["access"].string ?? "link") != access.rawValue {
        share = try await remote.rpc.call("setShareAccess", args: [.string(conversation.id), .string(access.rawValue)], as: JSONValue.self)
      }
      share = try await remote.rpc.call("shareConversation", args: [.string(conversation.id), .string(access.rawValue)], as: JSONValue.self)
      if let shareURL { ActivitySheet.present([shareURL]) }
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  private func unshare() async {
    guard let conversation, let remote = store.remote else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      let _: JSONValue = try await remote.rpc.call("unshareConversation", args: [.string(conversation.id)], as: JSONValue.self)
      share = .null
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
  private func sendInvite() async {
    guard let conversation, let remote = store.remote else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      let result = try await remote.rpc.call("inviteToShare", args: [.string(conversation.id), .string(invite.trimmingCharacters(in: .whitespacesAndNewlines))], as: JSONValue.self)
      share = result["share"]
      invite = ""
      if result["mailed"].bool != true { error = L("claudex_share_not_mailed") }
    } catch {
      self.error = error.localizedDescription
      store.validateSessionError(error)
    }
  }
}
