import XCTest
@testable import ClaudexCore

final class AppLinkTests: XCTestCase {
    func testAChatLinkOpensThatConversation() {
        XCTAssertEqual(AppLinks.parse("claudex://chat/abc_1"), .chat("abc_1"))
        XCTAssertEqual(AppLinks.parse("https://claudex.zecous.cn/conversation/abc_1"), .chat("abc_1"))
        XCTAssertEqual(AppLinks.parse("claudex://claude.ai/chat/abc_1"), .chat("abc_1"))
        XCTAssertNil(AppLinks.parse("https://claude.ai/chat/abc_1"))
        XCTAssertNil(AppLinks.parse("claudex://chat/../secret"))
    }

    func testANewLinkOnlyFillsTheComposer() {
        XCTAssertEqual(AppLinks.parse("claudex://new?q=hello"), .composer(.chat, "hello"))
        XCTAssertEqual(AppLinks.parse("https://claudex.zecous.cn/cowork/new?q=plan"), .composer(.cowork, "plan"))
        XCTAssertEqual(AppLinks.parse("claudex://code/new"), .composer(.code, nil))
        XCTAssertNil(AppLinks.parse("claudex://code/new?ssh_host=example"))
        XCTAssertEqual(AppLinks.parse("claudex://project/proj_1"), .project("proj_1"))
        XCTAssertEqual(AppLinks.parse("claudex://code/continue?session=sess_1"), .chat("sess_1"))
    }
}
