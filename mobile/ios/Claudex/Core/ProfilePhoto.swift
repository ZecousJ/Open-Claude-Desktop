import Foundation

/// The account's profile photo, saved with the other settings as a 256 px PNG data URL.
/// A photo that is not a PNG of that form, or that is larger than the settings limit, is not kept.
public enum ProfilePhotoPolicy {
    public static let edge = 256
    public static let byteLimit = 512 * 1024

    public static func accepts(_ value: String) -> Bool {
        guard value.count <= 700_000,
              let range = value.range(of: "^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$", options: .regularExpression),
              range.lowerBound == value.startIndex, range.upperBound == value.endIndex,
              let bytes = Data(base64Encoded: String(value.dropFirst("data:image/png;base64,".count)))
        else { return false }
        return !bytes.isEmpty && bytes.count <= byteLimit
    }

    public static func dataURL(png: Data) -> String? {
        guard !png.isEmpty, png.count <= byteLimit else { return nil }
        let url = "data:image/png;base64," + png.base64EncodedString()
        return accepts(url) ? url : nil
    }

    /// The centered square of an image, in pixels.
    public static func crop(width: Int, height: Int) -> (x: Int, y: Int, side: Int)? {
        guard width > 0, height > 0 else { return nil }
        let side = min(width, height)
        return ((width - side) / 2, (height - side) / 2, side)
    }
}
