import ImageIO
import UIKit
import PhotosUI
import QuickLook
import SwiftUI

/// Downsample local bytes only; source files, uploads and the shared renderer are untouched.
enum LocalPhotoThumbnail {
  static func data(url: URL) -> Data? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 256,
            kCGImageSourceShouldCacheImmediately: true
          ] as CFDictionary) else { return nil }
    return UIImage(cgImage: image).pngData()
  }
}
struct LocalAttachmentThumbnail: View {
  let attachment: LocalAttachment
  @State private var image: UIImage?
  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().scaledToFill() }
      else { Image(systemName: "doc").font(.title2).foregroundStyle(.secondary) }
    }.frame(width: 52, height: 52).background(Brand.subtle).clipShape(RoundedRectangle(cornerRadius: 8))
      .accessibilityLabel(L(image == nil ? "file_preview_file_content_description" : "file_preview_image_content_description"))
      .task(id: attachment.id) {
        let url = attachment.url
        let bytes = await Task.detached(priority: .utility) { LocalPhotoThumbnail.data(url: url) }.value
        guard !Task.isCancelled else { return }; image = bytes.flatMap { UIImage(data: $0) }
      }.onDisappear { image = nil }
  }
}
struct AttachmentPreviewView: View {
  let attachment: LocalAttachment
  @Environment(\.dismiss) private var dismiss
  /// The official preview sheet: X and the file name, the file filling the sheet. No type line, share or notes.
  var body: some View {
    NavigationStack {
      QuickLookPreview(url: attachment.url).background(Brand.surface)
        .navigationTitle(attachment.name).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarLeading) { FilePreviewCloseButton { dismiss() } } }
    }
  }
}
struct QuickLookPreview: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url: url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }
  func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {
    context.coordinator.url = url
    uiViewController.reloadData()
  }
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> QLPreviewItem
    { url as NSURL }
  }
}

struct RemoteAttachmentDetailView: View {
  @EnvironmentObject private var store: AppStore
  let attachment: Attachment
  @State private var image: UIImage?
  @State private var failed = false
  @State private var loading = false
  /// The official preview sheet (FilePreviewSheet.swift): an image attachment fills the sheet and zooms;
  /// other attachments have no preview here ("Preview unavailable"). The service hands back a preview, not
  /// the original, so there is no Download (the official sheet shows it only for downloadable files).
  var body: some View {
    VStack(spacing: 0) {
      Group {
        if loading {
          ClaudeSpinner().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let image {
          ZoomableImage(image: image, label: attachment.name)
        } else if failed {
          FilePreviewLine(key: "document_preview_load_failed")
        } else {
          FilePreviewLine(key: "document_preview_bottom_sheet_unavailable")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .padding(.top, 12)
      .clipped()
    }
    .background(Palette.bg100).navigationTitle(attachment.name).navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar).task { await load() }
  }
  private func load() async {
    guard attachment.kind == "image", let remote = store.remote else { return }
    loading = true
    defer { loading = false }
    do {
      let value: String? = try await remote.rpc.call(
        "attachmentPreview", args: [.string(attachment.id)], as: Optional<String>.self)
      guard let value, value.hasPrefix("data:image/"), let separator = value.range(of: ";base64,"),
        value.count <= AttachmentLimits.clientMaximum * 2,
        let bytes = Data(base64Encoded: String(value[separator.upperBound...])),
        bytes.count <= AttachmentLimits.clientMaximum, let decoded = UIImage(data: bytes)
      else {
        failed = true
        return
      }
      image = decoded
    } catch {
      failed = true
      store.validateSessionError(error)
    }
  }
}
