import Foundation

public struct ModelChoice: Identifiable, Equatable, Sendable {
    public let providerID: String
    public let model: ModelItem
    public var id: String { providerID + ":" + model.id }
    public var label: String { model.displayName.isEmpty ? model.id : model.displayName }
    public var vendor: String { ModelMenuPolicy.vendor(model.id) }
}
/// Mirrors web code-model-choices at main dd5137a8; no invented catalog fields.
public enum ModelMenuPolicy {
    public static let effortLevels = ["low", "medium", "high", "xhigh", "max"]
    public static func vendor(_ id: String) -> String {
        let value = id.split(separator: "/").last.map(String.init)?.lowercased() ?? id.lowercased()
        if ["gpt", "chatgpt", "codex"].contains(where: value.hasPrefix) || value.range(of: "^o[0-9]", options: .regularExpression) != nil { return "openai" }
        for (prefix, vendor) in [("claude", "anthropic"), ("grok", "xai"), ("composer", "xai"), ("gemini", "gemini"), ("qwen", "qwen"), ("deepseek", "deepseek")] {
            if value.hasPrefix(prefix) { return vendor }
        }
        return "other"
    }
    public static func choices(providers: [Provider], catalog: ModelCatalog?, providerID: String, selected: String) -> (quick: [ModelChoice], more: [ModelChoice]) {
        let items = (catalog?.items ?? []).sorted { $0.sort < $1.sort }
        let byID = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let all = providers.flatMap { provider -> [ModelChoice] in
            var seen = Set<String>()
            return ([provider.model] + provider.models).filter { !$0.isEmpty && seen.insert($0).inserted && $0.range(of: "^(gpt-image|grok-imagine)|(^|[-_/])(image|imagine|video|dall-e|tts|whisper|transcribe|embedding|embed|moderation)([-_./]|$)", options: .regularExpression) == nil }.map { id in
                let item = byID[id] ?? ModelItem(id: id, displayName: id, description: "", badges: [], sort: Int.max, hidden: false, isDefault: false, usageHint: "", efforts: nil, defaultEffort: nil, contextWindow: nil)
                return ModelChoice(providerID: provider.id, model: item)
            }
        }
        let ordered = all.enumerated().sorted { a, b in a.element.model.sort == b.element.model.sort ? a.offset < b.offset : a.element.model.sort < b.element.model.sort }.map(\.element)
        let catalogued = !items.isEmpty
        let listed = catalogued ? ordered.filter { byID[$0.model.id] != nil && !$0.model.hidden } : all
        let chosen = all.first { $0.providerID == providerID && $0.model.id == selected }
        var quick = catalogued ? listed : Array(listed.prefix(4))
        if let chosen, !quick.contains(chosen) { quick.insert(chosen, at: 0); if !catalogued { quick = Array(quick.prefix(4)) } }
        return (quick, ordered.filter { !quick.contains($0) })
    }
    public static func efforts(_ model: ModelItem?) -> [String] {
        guard let offered = model?.efforts else { return effortLevels }
        let filtered = effortLevels.filter(offered.contains)
        return filtered.isEmpty ? effortLevels : filtered
    }
}
