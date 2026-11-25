import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

final class AppReleasePolicyTests: XCTestCase {
    private func apps(url: String, version: String = "0.8.0", notes: String? = nil) -> JSONValue {
        var fields: [String: JSONValue] = ["version": .string(version), "url": .string(url)]
        if let notes { fields["notes"] = .string(notes) }
        return .object(["code": .number(0), "data": .object(["ios": .object(fields)])])
    }

    func testVersionsCompareAsNumbers() {
        XCTAssertTrue(AppReleasePolicy.newer("0.10.0", than: "0.9.3"))
        XCTAssertTrue(AppReleasePolicy.newer("0.8.0", than: "0.7.0"))
        XCTAssertFalse(AppReleasePolicy.newer("0.7.0", than: "0.7.0"))
        XCTAssertFalse(AppReleasePolicy.newer("0.6.9", than: "0.7.0"))
        XCTAssertFalse(AppReleasePolicy.newer("latest", than: "0.7.0"))
        XCTAssertTrue(AppReleasePolicy.newer("0.8.0", than: "0.7.0-debug"))
    }

    func testAReleaseOpensOnlyTheStoreOrThisServiceOverHttps() {
        let origin = "https://claudex.zecous.cn"
        let flight = AppReleasePolicy.release(apps(url: "https://testflight.apple.com/join/AbCdEf", notes: "  修复连接  "), origin: origin)
        XCTAssertEqual(flight?.version, "0.8.0")
        XCTAssertEqual(flight?.notes, "修复连接")
        XCTAssertEqual(flight?.url.absoluteString, "https://testflight.apple.com/join/AbCdEf")
        XCTAssertNotNil(AppReleasePolicy.release(apps(url: "https://apps.apple.com/app/id000000000"), origin: origin))
        XCTAssertNotNil(AppReleasePolicy.release(apps(url: "https://claudex.zecous.cn/downloads/ios"), origin: origin))
        XCTAssertNil(AppReleasePolicy.release(apps(url: "https://evil.example/join/AbCdEf"), origin: origin))
        XCTAssertNil(AppReleasePolicy.release(apps(url: "http://testflight.apple.com/join/AbCdEf"), origin: origin))
        XCTAssertNil(AppReleasePolicy.release(apps(url: "https://user@testflight.apple.com/join/AbCdEf"), origin: origin))
        XCTAssertNil(AppReleasePolicy.release(apps(url: "https://testflight.apple.com"), origin: origin))
        XCTAssertNil(AppReleasePolicy.release(apps(url: "https://apps.apple.com/app/id1", version: "latest"), origin: origin))
    }
}
