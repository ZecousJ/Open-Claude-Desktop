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
        let catalog = ModelCatalog(defaultModel: "gpt-a", items: [item("deepseek-a", 0), item("gpt-a", 1), item("claude-old", 2, hidden: true), item("unassigned", 3)])
        let available = ModelMenuPolicy.available(providers: providers, catalog: catalog)
        let selected = ModelChoice.Key(providerID: "p1", modelID: "claude-old")
        let choices = ModelMenuPolicy.choices(available, selected: selected)
        XCTAssertEqual(choices.quick.map(\.id), ["p1:deepseek-a", "p1:gpt-a", "p2:gpt-a", "p1:claude-old"])
        XCTAssertEqual(choices.quick.last?.label, "Display claude-old")
        XCTAssertTrue(choices.more.isEmpty)
        XCTAssertEqual(ModelMenuPolicy.choices(available, selected: nil).more.map(\.id), ["p1:claude-old"])
        XCTAssertEqual(ModelMenuPolicy.initialChoice(available, catalog: catalog, providerID: "p2", saved: selected)?.key, selected)
        XCTAssertEqual(ModelMenuPolicy.initialChoice(available, catalog: catalog, providerID: "p2", saved: .init(providerID: "p1", modelID: "extra"))?.id, "p2:gpt-a")
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
    func testEmptyCatalogDoesNotAdvertiseAssignedModels() throws {
        let provider = try JSONDecoder().decode(Provider.self, from: Data(#"{"id":"p","name":"one","model":"gpt-a","models":["gpt-a","gpt-b","gpt-c","gpt-d","gpt-e","gpt-image-2"]}"#.utf8))
        XCTAssertTrue(ModelMenuPolicy.available(providers: [provider], catalog: nil).isEmpty)
        XCTAssertTrue(ModelMenuPolicy.available(providers: [provider], catalog: .init(defaultModel: "gpt-a", items: [])).isEmpty)
    }
}
