import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif
final class ModelMenuTests: XCTestCase {
  override func setUp() { CoreTextForTests.install() }
    func testCatalogOrderingCurrentMoreAndProviderIdentity() throws {
        let providers = try JSONDecoder().decode([Provider].self, from: Data(#"[{"id":"p1","name":"one","model":"gpt-a","models":["gpt-a","deepseek-a","claude-old","extra"]},{"id":"p2","name":"two","model":"gpt-a","models":["gpt-a"]}]"#.utf8))
        func item(_ id: String, _ sort: Int, hidden: Bool = false) -> ModelItem {
            ModelItem(id: id, displayName: "Display " + id, description: "", badges: [], sort: sort, hidden: hidden, isDefault: false, usageHint: "", efforts: ["low","high"], defaultEffort: "high", contextWindow: nil)
        }
        let catalog = ModelCatalog(defaultModel: "gpt-a", items: [item("deepseek-a", 0), item("gpt-a", 1), item("claude-old", 2, hidden: true)])
        let choices = ModelMenuPolicy.choices(providers: providers, catalog: catalog, providerID: "p1", selected: "claude-old")
        XCTAssertEqual(choices.quick.map(\.id), ["p1:claude-old", "p1:deepseek-a", "p1:gpt-a", "p2:gpt-a"])
        XCTAssertEqual(choices.quick.first?.label, "Display claude-old")
        XCTAssertEqual(choices.more.map(\.id), ["p1:extra"])
    }
    func testSelectedModelSettingsPreserveOtherFieldsAndRejectUnassignedChoice() throws {
        let settings = try JSONDecoder().decode(Settings.self, from: Data(#"{"activeProviderId":"p","providers":[{"id":"p","name":"one","model":"gpt-a","models":["gpt-a","deepseek-a"],"opaque":"keep"}],"effort":"high","appearance":"dark"}"#.utf8))
        let saved = try settings.replacingSelectedModel(providerID: "p", modelID: "deepseek-a")
        XCTAssertEqual(saved.providers.first?.model, "deepseek-a")
        XCTAssertEqual(saved.raw["providers"].array?.first?["opaque"].string, "keep")
        XCTAssertEqual(saved.raw["appearance"].string, "dark")
        XCTAssertThrowsError(try settings.replacingSelectedModel(providerID: "p", modelID: "unassigned"))
    }
    func testSavedModelChoiceRestoresOnlyAnOfferedModel() throws {
        let providers = try JSONDecoder().decode([Provider].self, from: Data(#"[{"id":"xai","name":"xAI","model":"grok-4.7","models":["grok-4.7","composer-2.5"],"protocol":"responses"}]"#.utf8))
        XCTAssertEqual(SavedModelChoice.key(account: " Me@Example.com "), "selectedModel.me@example.com")
        XCTAssertNil(SavedModelChoice.key(account: ""))
        let raw = SavedModelChoice.encode(providerID: "xai", modelID: "composer-2.5")
        XCTAssertEqual(SavedModelChoice.restore(raw, providers: providers)?.modelID, "composer-2.5")
        XCTAssertNil(SavedModelChoice.restore(SavedModelChoice.encode(providerID: "xai", modelID: "gone"), providers: providers))
        XCTAssertNil(SavedModelChoice.restore(nil, providers: providers))
    }
    func testCapacityRefusalReadsInChinese() {
        XCTAssertEqual(ServiceError.server("You already have as many runs going as your account allows. Wait for one to finish, then try again.", "CLAUDEX_WEB_CAPACITY").errorDescription, "同时运行的任务已达账户上限，请等待一个任务完成后再试。")
        XCTAssertEqual(ServiceError.server("Runner busy", "CLAUDEX_WEB_CAPACITY").errorDescription, "服务当前繁忙。请稍等片刻后重试。")
        XCTAssertEqual(ServiceError.server("其他错误", "OTHER").errorDescription, "其他错误")
    }
    func testTranscriptZoomFollowsSystemTextSize() {
        XCTAssertEqual(SharedConversationTextScale.zoom(bodyPointSize: 17), 1)
        XCTAssertEqual(SharedConversationTextScale.zoom(bodyPointSize: 23), 23.0 / 17, accuracy: 0.0001)
        XCTAssertEqual(SharedConversationTextScale.zoom(bodyPointSize: 80), 3)
        XCTAssertEqual(SharedConversationTextScale.zoom(bodyPointSize: 10), 0.8)
        XCTAssertEqual(SharedConversationTextScale.zoom(bodyPointSize: .nan), 1)
    }
    func testNanosecondStatusTimeIsLocalAndNeverRawISO() {
        let value = NativeDisplayTime.format("2026-10-04T00:16:08.845736971+08:00", locale: Locale(identifier: "zh_CN"), timeZone: TimeZone(secondsFromGMT: 0)!)
        XCTAssertTrue(value.contains("16:16")); XCTAssertFalse(value.contains("T")); XCTAssertFalse(value.contains("845"))
        XCTAssertEqual(NativeDisplayTime.format("invalid"), "时间未知")
        // A status slot's wall time stays the status page's own time (it read 08:00, UTC midnight).
        let shanghai = TimeZone(identifier: "Asia/Shanghai")!
        XCTAssertEqual(NativeDisplayTime.format("2026-10-04T10:50", locale: Locale(identifier: "zh_CN"), timeZone: TimeZone(secondsFromGMT: 0)!, wallClock: shanghai), "10月4日 10:50")
    }
    func testFallbackPromotesCurrentAndCapsOnlyWithoutCatalog() throws {
        let provider = try JSONDecoder().decode(Provider.self, from: Data(#"{"id":"p","name":"one","model":"gpt-a","models":["gpt-a","gpt-b","gpt-c","gpt-d","gpt-e","gpt-image-2"]}"#.utf8))
        let choices = ModelMenuPolicy.choices(providers: [provider], catalog: nil, providerID: "p", selected: "gpt-e")
        XCTAssertEqual(choices.quick.count, 4); XCTAssertEqual(choices.quick.first?.model.id, "gpt-e")
        XCTAssertFalse((choices.quick + choices.more).contains { $0.model.id == "gpt-image-2" })
        XCTAssertEqual(ModelMenuPolicy.vendor("provider/deepseek-v4"), "deepseek")
        XCTAssertEqual(ModelMenuPolicy.vendor("o4-mini"), "openai")
        XCTAssertEqual(ModelMenuPolicy.vendor("unknown"), "other")
        XCTAssertEqual(ModelMenuPolicy.efforts(nil), ["low","medium","high","xhigh","max"])
    }
}
