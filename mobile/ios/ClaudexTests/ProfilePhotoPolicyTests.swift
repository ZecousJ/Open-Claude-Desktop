import XCTest
@testable import ClaudexCore

final class ProfilePhotoPolicyTests: XCTestCase {
    func testAPngDataUrlOfTheSavedSizeIsKept() {
        let png = Data(repeating: 1, count: 32)
        let url = "data:image/png;base64," + png.base64EncodedString()
        XCTAssertTrue(ProfilePhotoPolicy.accepts(url))
        XCTAssertEqual(ProfilePhotoPolicy.dataURL(png: png), url)
    }

    func testAnythingElseIsNotAProfilePhoto() {
        XCTAssertFalse(ProfilePhotoPolicy.accepts(""))
        XCTAssertFalse(ProfilePhotoPolicy.accepts("data:image/jpeg;base64,YQ=="))
        XCTAssertNil(ProfilePhotoPolicy.dataURL(png: Data()))
        XCTAssertNil(ProfilePhotoPolicy.dataURL(png: Data(count: ProfilePhotoPolicy.byteLimit + 1)))
        XCTAssertNil(ProfilePhotoPolicy.crop(width: 0, height: 10))
        XCTAssertEqual(ProfilePhotoPolicy.crop(width: 400, height: 200).map { ($0.x, $0.y, $0.side) }.map { "\($0.0),\($0.1),\($0.2)" }, "100,0,200")
    }
}
