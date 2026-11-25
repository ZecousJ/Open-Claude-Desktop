import SwiftUI
import WidgetKit

private struct ChatRow: Identifiable {
    let id: String
    let title: String
}

private struct ChatEntry: TimelineEntry {
    let date: Date
    let rows: [ChatRow]
}

private struct ChatProvider: TimelineProvider {
    func placeholder(in context: Context) -> ChatEntry { ChatEntry(date: Date(), rows: []) }
    func getSnapshot(in context: Context, completion: @escaping (ChatEntry) -> Void) { completion(current()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ChatEntry>) -> Void) {
        completion(Timeline(entries: [current()], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
    private func current() -> ChatEntry {
        guard let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.cn.zecous.claudex"),
              let data = try? Data(contentsOf: folder.appendingPathComponent("chats.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = object["rows"] as? [[String: String]] else { return ChatEntry(date: Date(), rows: []) }
        let parsed = rows.prefix(4).compactMap { row -> ChatRow? in
            guard let id = row["id"], id.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil else { return nil }
            let title = row["title"]?.trimmingCharacters(in: .whitespacesAndNewlines)
            return ChatRow(id: id, title: title?.isEmpty == false ? title! : (Locale.current.language.languageCode?.identifier == "zh" ? "未命名" : "Untitled"))
        }
        return ChatEntry(date: Date(), rows: Array(parsed))
    }
}

private struct ChatWidgetView: View {
    let entry: ChatEntry
    private var chinese: Bool { Locale.current.language.languageCode?.identifier == "zh" }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Link(destination: URL(string: "claudex://new")!) {
                Text(chinese ? "新对话" : "New chat").font(.headline)
            }
            ForEach(entry.rows) { row in
                if let url = URL(string: "claudex://chat/\(row.id)") {
                    Link(destination: url) { Text(row.title).font(.subheadline).lineLimit(1) }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }
}

struct ClaudexChatWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "claudex.chats", provider: ChatProvider()) { entry in
            ChatWidgetView(entry: entry)
        }
        .configurationDisplayName("Claudex")
        .description(Locale.current.language.languageCode?.identifier == "zh" ? "在主屏幕上向 Claudex 提问" : "Ask Claudex from your home screen")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct ClaudexWidgetBundle: WidgetBundle {
    var body: some Widget { ClaudexChatWidget() }
}
