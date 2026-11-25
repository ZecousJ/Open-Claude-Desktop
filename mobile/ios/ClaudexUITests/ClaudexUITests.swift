import XCTest

final class ClaudexUITests: XCTestCase {
  override func setUpWithError() throws { continueAfterFailure = false }
  @MainActor private func waitUntilInteractive(_ element: XCUIElement) {
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true AND hittable == true AND enabled == true"), object: element)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
  }
  @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  @MainActor private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    // Skips persisted session restoration; never creates an authenticated fixture.
    app.launchArguments = ["-ui-testing"]
    app.launch()
    XCTAssertTrue(app.textFields["login-email"].waitForExistence(timeout: 10))
    waitUntilInteractive(app.buttons["open-registration"])
    return app
  }
  @MainActor func testSignedOutLaunchShowsLoginBeforeChat() throws {
    let app = launch()
    XCTAssertFalse(app.buttons["open-sidebar"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["composer-input"].exists)
    XCTAssertFalse(app.buttons["close-login"].exists)
    XCTAssertEqual(app.tabBars.count, 0)
    capture(app, "signed-out-authentication-entry")
  }
  @MainActor func testRegistrationCancelNeverRevealsChatRepeatedly() throws {
    let app = launch()
    // The login entry has no close action after #8. Its nested registration
    // sheet is the cancellable auth route, and must return to that same entry.
    for attempt in 1...3 {
      waitUntilInteractive(app.buttons["open-registration"])
      app.buttons["open-registration"].tap()
      XCTAssertTrue(app.descendants(matching: .any)["registration-form"].waitForExistence(timeout: 10))
      waitUntilInteractive(app.buttons["close-registration"])
      capture(app, "registration-open-\(attempt)")
      app.buttons["close-registration"].tap()
      XCTAssertTrue(app.buttons["close-registration"].waitForNonExistence(timeout: 10))
      waitUntilInteractive(app.textFields["login-email"])
      XCTAssertFalse(app.buttons["close-login"].exists)
      XCTAssertFalse(app.buttons["open-sidebar"].exists)
      XCTAssertFalse(app.descendants(matching: .any)["composer-input"].exists)
      capture(app, "registration-cancel-login-entry-\(attempt)")
    }
  }
  @MainActor func testInvalidEmailCannotEnterChat() throws {
    let app = launch()
    let email = app.textFields["login-email"]
    email.tap(); email.typeText("LOCAL_INVALID_EMAIL")
    // Official welcome: the trailing submit appears once there is text; an invalid address shows
    // the field error and stays on the welcome page.
    waitUntilInteractive(app.buttons["login-continue"])
    app.buttons["login-continue"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["auth-error"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.descendants(matching: .any)["login-password"].exists)
    XCTAssertFalse(app.buttons["open-sidebar"].exists)
    capture(app, "invalid-email-stays-at-login")
  }
}
