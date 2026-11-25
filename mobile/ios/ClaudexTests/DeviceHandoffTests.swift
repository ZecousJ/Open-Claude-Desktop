import XCTest
@testable import ClaudexCore

final class DeviceHandoffTests: XCTestCase {
    func testAPhoneLinkOpensTheDialerAndAMessageStaysADraft() {
        XCTAssertEqual(DeviceHandoff.canonical("tel:+1 (555) 1212"), "tel:+15551212")
        XCTAssertNil(DeviceHandoff.canonical("tel:12"))
        XCTAssertNil(DeviceHandoff.canonical("tel:+15551212?send=1"))
        XCTAssertEqual(DeviceHandoff.canonical("sms:+15551212?body=hello%20there"), "sms:+15551212?body=hello%20there")
        XCTAssertEqual(DeviceHandoff.canonical("smsto:?body=See%20you"), "smsto:?body=See%20you")
        XCTAssertNil(DeviceHandoff.canonical("sms:+15551212?send=1"))
        XCTAssertTrue(DeviceHandoff.mentions("Call tel:+1 (555) 1212.", "tel:+15551212"))
    }

    func testIOSDoesNotSetAClockSilently() {
        let input = JSONValue.object(["hour": .number(7), "minute": .number(30), "message": .string("Stand up")])
        guard case .failed(let reason) = DeviceHandoff.clock(name: "alarm_create_v0", input: input, platform: "ios", foreground: true) else {
            return XCTFail("iOS must not report a silent alarm")
        }
        XCTAssertEqual(reason, "Failed to set alarm.")
        let hidden = DeviceHandoff.clock(name: "timer_create_v0", input: .object(["duration_seconds": .number(60), "message": .string("Tea")]), platform: "android", foreground: false)
        guard case .failed(let background) = hidden else { return XCTFail("a hidden timer is not set") }
        XCTAssertTrue(background.contains("open on screen"))
        XCTAssertNil(DeviceHandoff.clock(name: "other", input: .object([:]), platform: "android", foreground: true))
    }
}
