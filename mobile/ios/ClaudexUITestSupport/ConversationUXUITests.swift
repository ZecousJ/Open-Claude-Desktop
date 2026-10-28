import XCTest

final class ConversationUXUITests: XCTestCase {
  override func setUpWithError() throws { continueAfterFailure = false }
  @MainActor private func ready(_ element: XCUIElement) {
    let wait = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true AND enabled == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [wait], timeout: 15), .completed)
  }
  @MainActor private func state(_ app: XCUIApplication, contains text: String) {
    let wait = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", text), object: app.staticTexts["synthetic-ux-state"])
    XCTAssertEqual(XCTWaiter.wait(for: [wait], timeout: 20), .completed)
  }
  @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-AX"; tree.lifetime = .keepAlways; add(tree)
    print("SYNTHETIC_UI_CAPTURE \(name) \(Date().timeIntervalSince1970)")
  }
  @MainActor private func launch() -> XCUIApplication {
    let app = XCUIApplication(); app.launchArguments = ["-ui-testing"]; app.launch()
    ready(app.buttons["open-models"]); state(app, contains: "surface=nil")
    XCTAssertEqual(app.tabBars.count, 0)
    return app
  }
  @MainActor func testModelSelectionClosesSheetEffortPageAndSwipeDismiss() {
    let app = launch(); capture(app, "phone-welcome")
    app.buttons["open-models"].tap()
    ready(app.buttons["model-choice-p:gpt-synthetic-b"])
    XCTAssertTrue(app.staticTexts["model-sheet-header"].exists)
    capture(app, "phone-select-model")
    // Official: choosing a model closes the sheet.
    app.buttons["model-choice-p:gpt-synthetic-b"].tap()
    XCTAssertTrue(app.staticTexts["model-sheet-header"].waitForNonExistence(timeout: 10))
    state(app, contains: "model=gpt-synthetic-b")
    // Effort is its own page; choosing one returns to Select model.
    ready(app.buttons["open-models"]); app.buttons["open-models"].tap()
    ready(app.buttons["model-effort-row"]); app.buttons["model-effort-row"].tap()
    ready(app.buttons["model-effort-low"])
    capture(app, "phone-effort-page")
    app.buttons["model-effort-low"].tap()
    ready(app.buttons["model-effort-row"])
    state(app, contains: "model=gpt-synthetic-b;effort=low")
    let header = app.staticTexts["model-sheet-header"]; ready(header)
    let start = header.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
    let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
    start.press(forDuration: 0.1, thenDragTo: end)
    XCTAssertTrue(header.waitForNonExistence(timeout: 10))
    ready(app.buttons["open-models"])
    state(app, contains: "model=gpt-synthetic-b;effort=low")
    capture(app, "phone-model-swipe-dismiss")
  }
  @MainActor func testFirstSendPreservesOpenComposerSheetAndRootNavigation() {
    let app = launch()
    let input = app.descendants(matching: .any)["composer-input"].firstMatch
    ready(input); input.tap(); input.typeText("SYNTHETIC_PHONE_PROMPT")
    ready(app.buttons["send-message"])
    capture(app, "phone-first-send-before")
    print("SYNTHETIC_SEND_TAP \(Date().timeIntervalSince1970)")
    app.buttons["send-message"].tap()
    state(app, contains: "sending=true")
    ready(app.buttons["open-models"]); app.buttons["open-models"].tap()
    ready(app.buttons["close-sheet"])
    capture(app, "phone-first-send-pending-sheet")
    // Opening this sheet before the delayed reply returns probes the composer's
    // local presentation state through the welcome -> conversation transition.
    XCTAssertTrue(app.staticTexts["model-sheet-header"].exists)
    sleep(9)
    XCTAssertTrue(app.staticTexts["model-sheet-header"].exists)
    capture(app, "phone-first-send-returned-sheet-still-open")
    app.buttons["close-sheet"].tap()
    state(app, contains: "path=0;surface=synthetic-c;sending=false")
    capture(app, "phone-first-send-after-done")
    let reply = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "SYNTHETIC_PHONE_REPLY")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 35))
    XCTAssertFalse(app.staticTexts["共享对话资源未能启动，请重新加载"].exists)
    state(app, contains: "codeRendered=true")
    XCTAssertTrue(app.buttons["open-sidebar"].isHittable)
    capture(app, "phone-first-send-in-place")
  }
  @MainActor func testSidebarNewChatClosesAsOnePanelOnPhone() {
    let app = launch(); app.buttons["open-sidebar"].tap()
    ready(app.buttons["sidebar-new-chat"])
    capture(app, "phone-sidebar-before-new-chat")
    print("SYNTHETIC_NEW_CHAT_TAP \(Date().timeIntervalSince1970)")
    app.buttons["sidebar-new-chat"].tap()
    let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == false"), object: app.buttons["sidebar-new-chat"])
    XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 10), .completed)
    ready(app.buttons["open-models"])
    state(app, contains: "path=0;surface=nil")
    state(app, contains: "sidebar=false")
    capture(app, "phone-sidebar-after-new-chat")
  }
  @MainActor func testSidebarReversalAndSearchKeyboard() {
    let app = launch()
    for _ in 0..<2 {
      app.buttons["open-sidebar"].tap()
      capture(app, "phone-sidebar-before-close"); ready(app.buttons["close-sidebar"]); app.buttons["close-sidebar"].tap()
      ready(app.buttons["open-sidebar"])
    }
    app.buttons["open-sidebar"].tap()
    let search = app.textFields["搜索对话"].firstMatch
    ready(search); search.tap(); search.typeText("SYNTHETIC_SEARCH")
    ready(app.buttons["sidebar-new-chat"])
    capture(app, "phone-sidebar-search-keyboard")
    app.buttons["sidebar-new-chat"].tap()
    ready(app.buttons["open-models"]); state(app, contains: "sidebar=false")
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    capture(app, "phone-sidebar-keyboard-closed")
  }
}
