import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif
final class NativeDetailsTests: XCTestCase {
  override func setUp() { CoreTextForTests.install() }
    func testCodeChangesOnlyBelongsToCodeMenu() {
        XCTAssertFalse(NativeConversationDetails.showsCodeChanges(.chat)); XCTAssertFalse(NativeConversationDetails.showsCodeChanges(.cowork)); XCTAssertTrue(NativeConversationDetails.showsCodeChanges(.code))
    }
    func testRenameMatchesTrimmedUTF16ServerLimit() throws {
        XCTAssertEqual(try NativeConversationDetails.rename("  新标题\n"), .object(["title": .string("新标题")]))
        XCTAssertThrowsError(try NativeConversationDetails.rename(" \n")); XCTAssertThrowsError(try NativeConversationDetails.rename(String(repeating: "😀", count: 101)))
        XCTAssertNoThrow(try NativeConversationDetails.rename(String(repeating: "😀", count: 100)))
    }
    func testMoveAndRemoveUseActualProjectContractWithoutInventedDestination() throws {
        XCTAssertEqual(try NativeConversationDetails.move(to: "p1", availableIDs: ["p1"]), .object(["projectId": .string("p1")]))
        XCTAssertEqual(try NativeConversationDetails.move(to: nil, availableIDs: []), .object(["projectId": .null]))
        XCTAssertThrowsError(try NativeConversationDetails.move(to: "deleted", availableIDs: ["p1"]))
    }
    func testPhotoNamesAreReadableAndPreserveValidFormatWithoutUUID() {
        XCTAssertEqual(NativeConversationDetails.photoName(ordinal: 1, suffix: "HEIC"), "照片 1.heic")
        XCTAssertEqual(NativeConversationDetails.photoName(ordinal: 2, suffix: "png"), "照片 2.png")
        XCTAssertEqual(NativeConversationDetails.photoName(ordinal: 0, suffix: "../private"), "照片 1.img")
    }
}
