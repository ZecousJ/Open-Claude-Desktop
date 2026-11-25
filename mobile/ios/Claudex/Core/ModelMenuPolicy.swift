import Foundation

public enum ModelEffort: String, Codable, Sendable {
    case low, medium, high, xhigh, max, ultra
}

public struct ModelChoice: Identifiable, Equatable, Sendable {
    public struct Key: Codable, Hashable, Sendable {
        public let providerID: String
        public let modelID: String
    }

    public let providerID: String
    public let model: ModelItem
    public var key: Key { Key(providerID: providerID, modelID: model.id) }
    public var id: String { providerID + ":" + model.id }
    public var label: String { model.displayName.isEmpty ? model.id : model.displayName }
    public var efforts: [ModelEffort] { (model.efforts ?? []).compactMap(ModelEffort.init(rawValue:)) }
    public var defaultEffort: ModelEffort? { effort(preferred: nil) }

    public func effort(preferred: ModelEffort?) -> ModelEffort? {
        let published = efforts
        return [preferred, model.defaultEffort.flatMap(ModelEffort.init(rawValue:))]
            .compactMap { $0 }.first(where: published.contains) ?? published.first
    }
}

enum ModelCatalogState {
    case loading, loaded(ModelCatalog?), failed

    var catalog: ModelCatalog? {
        if case .loaded(let catalog) = self { return catalog }
        return nil
    }
}

struct ModelPreference: Codable {
    var selected: ModelChoice.Key?
    var efforts: [ModelChoice.Key: ModelEffort] = [:]

    static func storageKey(origin: URL, account: String, mode: ChatMode) -> String {
        "modelPreference.\(origin.host?.lowercased() ?? ""):\(origin.port ?? 443).\(mode.rawValue).\(account)"
    }
}

public enum ModelMenuPolicy {
    public static func available(providers: [Provider], catalog: ModelCatalog?) -> [ModelChoice] {
        (catalog?.items ?? []).enumerated()
            .sorted { $0.element.sort == $1.element.sort ? $0.offset < $1.offset : $0.element.sort < $1.element.sort }
            .flatMap { _, item in
                providers.filter { $0.models.contains(item.id) }.map { ModelChoice(providerID: $0.id, model: item) }
            }
    }

    public static func choices(_ available: [ModelChoice], selected: ModelChoice.Key?) -> (quick: [ModelChoice], more: [ModelChoice]) {
        let quick = available.filter { !$0.model.hidden || $0.key == selected }
        return (quick, available.filter { $0.model.hidden && $0.key != selected })
    }

    public static func initialChoice(_ available: [ModelChoice], catalog: ModelCatalog?, providerID: String,
                                     saved: ModelChoice.Key?) -> ModelChoice? {
        if let choice = available.first(where: { $0.key == saved }) { return choice }
        for matches in [{ (choice: ModelChoice) in choice.model.id == catalog?.defaultModel },
                        { (choice: ModelChoice) in choice.model.isDefault }] {
            if let choice = available.first(where: { $0.providerID == providerID && matches($0) }) ?? available.first(where: matches) {
                return choice
            }
        }
        return available.first { !$0.model.hidden } ?? available.first
    }
}
