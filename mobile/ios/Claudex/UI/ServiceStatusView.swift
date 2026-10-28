import SwiftUI
import WebKit

/// Service status, drawn with the Usage page's visuals: the overall state, one meter-style tile per channel (its
/// uptime slots as the bar, the models below), the GPT IQ check as gallery cards, and incidents as rows. Error and
/// empty use the official usage states.
struct ServiceStatusView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.scenePhase) private var phase
  @State private var value: JSONValue = .null
  @State private var failed = false
  @State private var loading = false
  @State private var expanded: Set<Int> = []
  private var stepMinutes: Int { min(60, max(1, value["step_minutes"].integer ?? 60)) }
  private var platforms: [JSONValue] { value["platforms"].array ?? [] }
  private var zone: TimeZone? { TimeZone(identifier: value["timezone"].string ?? "") }
  var body: some View {
    SettingsPage(title: L("claudex_service_status_title")) {
      if value == .null {
        if failed {
          OfficialErrorState(text: L("usage_load_error")) { Task { await load() } }
        } else if loading || store.account != nil {
          ListLoading()
        } else {
          OfficialEmptyState(icon: .chartLine, text: L("usage_no_data_available"), iconSize: 48)
        }
      } else {
        SettingsGroup {
          SettingsRow(
            title: title(value["level"].string),
            subtitle: L("claudex_status_updated", NativeDisplayTime.format(value["generated_at"].string))
          ) {
            Circle().fill(color(value["level"].string)).frame(width: 12, height: 12)
          }
        }
        SettingsGroup(value["hourly"].bool == true ? L("claudex_status_last_24h") : L("claudex_status_history")) {
          if platforms.isEmpty {
            SettingsRow(title: L("usage_no_data_available"))
          }
          ForEach(Array(platforms.enumerated()), id: \.offset) { _, platform in platformTile(platform) }
        }
        Text(value["hourly"].bool == true ? L("claudex_status_slot_note", stepMinutes) : L("claudex_status_daily_note"))
          .typeStyle(.caption).foregroundStyle(Palette.text500).padding(.horizontal, 24)
        iqSection
        SettingsGroup(L("claudex_status_incidents")) {
          let incidents = value["incidents"].array ?? []
          if incidents.isEmpty { SettingsRow(title: L("claudex_status_no_incidents")) }
          ForEach(Array(incidents.enumerated()), id: \.offset) { index, incident in
            Button {
              if expanded.contains(index) { expanded.remove(index) } else { expanded.insert(index) }
            } label: {
              SettingsRow(
                icon: .warningCircle, title: incident["title"].string ?? "",
                subtitle: expanded.contains(index) ? incidentDetail(incident) : NativeDisplayTime.format(incident["started_at"].string),
                subtitleLines: expanded.contains(index) ? 40 : 1
              ) {
                AppGlyphView(expanded.contains(index) ? .caretUp : .caretDown, size: 20).foregroundStyle(Palette.text500)
              }
            }.buttonStyle(SettingsRowPressStyle())
          }
        }
        Text(L("claudex_status_footer")).typeStyle(.caption).foregroundStyle(Palette.text500).padding(.horizontal, 24)
      }
    }
    .refreshable { await load() }
    .task {
      await load()
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(60))
          if phase == .active { await load() }
        } catch { return }
      }
    }
  }

  /// A channel: name and level, the uptime slots as one bar, the first and last slot times,
  /// and the models with their level.
  private func platformTile(_ platform: JSONValue) -> some View {
    let days = platform["days"].array ?? []
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(platform["name"].string ?? platform["platform"].string ?? "").typeStyle(.bodyLarge).foregroundStyle(Palette.text100)
        Spacer(minLength: 8)
        Text(title(platform["level"].string)).typeStyle(.body).foregroundStyle(color(platform["level"].string))
      }
      HStack(spacing: days.count > 100 ? 1 : 2) {
        ForEach(Array(days.enumerated()), id: \.offset) { _, slot in
          RoundedRectangle(cornerRadius: 2, style: .continuous).fill(color(slot["level"].string)).frame(height: 16)
            .accessibilityLabel("\(NativeDisplayTime.format(slot["date"].string, wallClock: zone))：\(title(slot["level"].string))")
        }
      }
      if let first = days.first, let last = days.last {
        HStack {
          Text(NativeDisplayTime.format(first["date"].string, wallClock: zone))
          Spacer()
          Text(NativeDisplayTime.format(last["date"].string, wallClock: zone))
        }.typeStyle(.caption).foregroundStyle(Palette.text500)
      }
      ForEach(Array((platform["components"].array ?? []).enumerated()), id: \.offset) { _, component in
        HStack {
          Text(component["name"].string ?? "").typeStyle(.body).foregroundStyle(Palette.text300)
          Spacer()
          Text(title(component["level"].string)).typeStyle(.body).foregroundStyle(color(component["level"].string))
        }
      }
    }
    .padding(.leading, 12).padding(.trailing, 16).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
  }

  /// GPT 智商检测 (owner, 2026-10-06): a model's page of a pelican riding a bicycle, every hour,
  /// under the normal and dumbed-down examples; cards in the artifact gallery style.
  @ViewBuilder private var iqSection: some View {
    let checks = (value["iq"].array ?? []).filter { $0["id"].integer != nil }
    let examples = (value["iq_examples"].array ?? []).filter { !($0["html"].string ?? "").isEmpty }
    if !checks.isEmpty || !examples.isEmpty {
      let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
      VStack(alignment: .leading, spacing: 12) {
        Text(L("claudex_iq_title")).typeStyle(.bodyLargeStrong).foregroundStyle(Palette.text100)
          .accessibilityAddTraits(.isHeader)
        if !examples.isEmpty {
          Text(L("claudex_iq_examples")).typeStyle(.body).foregroundStyle(Palette.text300)
          LazyVGrid(columns: columns, spacing: 12) {
            ForEach(Array(examples.enumerated()), id: \.offset) { _, example in
              let degraded = example["kind"].string == "degraded"
              IQCheckCard(
                html: example["html"].string ?? "", caption: degraded ? L("claudex_iq_degraded") : L("claudex_iq_normal"),
                verdict: degraded ? IQCheckCard.red : IQCheckCard.green)
            }
          }
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(L("claudex_iq_records")).typeStyle(.body).foregroundStyle(Palette.text300)
          Text(L("claudex_iq_hourly")).typeStyle(.caption).foregroundStyle(Palette.text500)
        }
        LazyVGrid(columns: columns, spacing: 12) {
          ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
            IQCheckCard(
              html: check["status"].string == "ok" ? (check["html"].string ?? "") : "",
              caption: L("claudex_iq_checked_at", NativeDisplayTime.format(check["started_at"].string)))
          }
        }
      }.padding(.horizontal, 12)
    }
  }

  private func incidentDetail(_ incident: JSONValue) -> String {
    var lines = [incident["message"].string ?? "", NativeDisplayTime.format(incident["started_at"].string)]
    lines += (incident["updates"].array ?? []).compactMap { $0["message"].string }
    return lines.filter { !$0.isEmpty }.joined(separator: "\n")
  }
  private func load() async {
    guard let direct = store.direct, store.account != nil else { return }
    loading = true
    defer { loading = false }
    do {
      value = try await direct.request("api/v1/claudex/status", query: ["hours": "24", "step": "10"])
      failed = false
    } catch {
      failed = true
      if value != .null { Snackbars.shared.show(L("usage_refresh_error")) }
    }
  }
  private func title(_ level: String?) -> String {
    switch level {
    case "operational": L("claudex_status_operational")
    case "degraded": L("claudex_status_degraded")
    case "outage": L("claudex_status_outage")
    case "none": L("claudex_status_no_data")
    default: L("claudex_status_unknown")
    }
  }
  private func color(_ level: String?) -> Color {
    switch level {
    case "operational": IQCheckCard.green
    case "degraded": Palette.warning
    case "outage": IQCheckCard.red
    default: Palette.bg400
    }
  }
}

/// One IQ page (a check's, or an example) and its caption. The page is laid
/// out at 800×600, as the prompt asks, and shown whole: scaled to the card,
/// never scrolled (owner, 2026-10-06).
private struct IQCheckCard: View {
  /// The status bars' green (no issues) and red (outage).
  static let green = Color(red: 0x23 / 255, green: 0xc1 / 255, blue: 0x9a / 255)
  static let red = Color(red: 0xf5 / 255, green: 0x78 / 255, blue: 0x5c / 255)
  let html: String
  let caption: String
  /// An example's verdict: a 2px frame and a tinted, bold caption in its colour.
  var verdict: Color? = nil
  var body: some View {
    VStack(spacing: 0) {
      Color.white.aspectRatio(4 / 3, contentMode: .fit).overlay(alignment: .topLeading) {
        if !html.isEmpty {
          GeometryReader { geometry in
            IQPageView(html: html).frame(width: 800, height: 600)
              .scaleEffect(geometry.size.width / 800, anchor: .topLeading)
          }
        } else {
          Text(L("claudex_iq_no_page")).typeStyle(.caption).foregroundStyle(Palette.text500)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }.clipped()
      if let verdict {
        Text(caption).typeStyle(.bodyStrong).foregroundStyle(verdict)
          .frame(maxWidth: .infinity).padding(.vertical, 8).background(verdict.opacity(0.14))
      } else {
        Text(caption).typeStyle(.caption).foregroundStyle(Palette.text500).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.vertical, 8)
      }
    }.background(Palette.bg000).clipShape(RoundedRectangle(cornerRadius: Radius.r12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: Radius.r12, style: .continuous)
          .strokeBorder(verdict ?? Palette.border300, lineWidth: verdict == nil ? 1 : 2))
  }
}

/// The model's page, with its own scripts but nothing from the network: a
/// content security policy goes in first, the web view keeps no data and
/// follows no link.
private struct IQPageView: UIViewRepresentable {
  let html: String
  static let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:\"><style>html,body{overflow:hidden!important}</style>"
  static func page(_ html: String) -> String {
    if let head = html.range(of: "<head>", options: .caseInsensitive) {
      var out = html; out.insert(contentsOf: policy, at: head.upperBound); return out
    }
    return policy + html
  }
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.mediaTypesRequiringUserActionForPlayback = .all
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = context.coordinator
    view.scrollView.isScrollEnabled = false
    view.isOpaque = false
    view.backgroundColor = .white
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    guard context.coordinator.loaded != html else { return }
    context.coordinator.loaded = html
    view.loadHTMLString(Self.page(html), baseURL: nil)
  }
  final class Coordinator: NSObject, WKNavigationDelegate {
    var loaded: String?
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      decisionHandler(action.navigationType == .other && (action.request.url?.absoluteString ?? "about:blank").hasPrefix("about:") ? .allow : .cancel)
    }
  }
}
