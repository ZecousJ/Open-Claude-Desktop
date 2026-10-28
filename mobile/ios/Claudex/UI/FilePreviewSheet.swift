import SwiftUI
import UIKit

/// Pieces of the file preview sheet, after the official Android document preview sheet: the file name and a close
/// button in the header, the preview filling the sheet 12 pt under it (an image zooms by pinch and double tap), one
/// full-width Download button at the bottom, and the official `document_preview_*` lines for the states. iOS keeps
/// its native controls: the close button sits in the navigation bar, and Download saves through the system's file
/// exporter (the counterpart of Downloads).

/// One of the official `document_preview_*` lines, centred in the preview area.
struct FilePreviewLine: View {
    let key: String
    var body: some View {
        Text(L(key)).typeStyle(.body).foregroundStyle(Palette.text300)
            .multilineTextAlignment(.center).padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The full-width Download button under the preview.
struct FilePreviewDownloadButton: View {
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(L("document_preview_bottom_sheet_download_button"), action: action)
            .buttonStyle(ClaudeButtonStyle(variant: .primary, size: .large, fullWidth: true))
            .disabled(!enabled)
            .padding(.horizontal, 24).padding(.vertical, 12)
            .accessibilityIdentifier("file-preview-download")
    }
}

/// An image that fills the preview and zooms by pinch and double tap (UIScrollView zooming).
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let label: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = FittingScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 5
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.bouncesZoom = true
        scroll.backgroundColor = .clear
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        view.isAccessibilityElement = true
        view.accessibilityLabel = label
        view.accessibilityTraits = .image
        scroll.addSubview(view)
        context.coordinator.imageView = view
        scroll.imageView = view
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(tap)
        return scroll
    }
    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.imageView?.image = image
        scroll.setNeedsLayout()
    }
    /// Fits the picture to the view whenever the view's size changes (and only then, so a zoom survives).
    final class FittingScrollView: UIScrollView {
        weak var imageView: UIImageView?
        private var fittedSize: CGSize = .zero
        override func layoutSubviews() {
            super.layoutSubviews()
            guard let imageView, bounds.size != .zero, bounds.size != fittedSize else { return }
            fittedSize = bounds.size
            zoomScale = 1
            contentInset = .zero
            imageView.frame = CGRect(origin: .zero, size: bounds.size)
            contentSize = bounds.size
        }
    }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ scroll: UIScrollView) {
            // Keeps a picture smaller than the view centred while zooming.
            let x = max(0, (scroll.bounds.width - scroll.contentSize.width) / 2)
            let y = max(0, (scroll.bounds.height - scroll.contentSize.height) / 2)
            scroll.contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
        }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView, let imageView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true); return }
            let point = gesture.location(in: imageView)
            let scale: CGFloat = 2.5
            let size = CGSize(width: scroll.bounds.width / scale, height: scroll.bounds.height / scale)
            scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

/// The sheet's close button (the official header's X, "Close sheet").
struct FilePreviewCloseButton: View {
    let close: () -> Void
    var body: some View {
        Button(action: close) { Image(systemName: "xmark") }
            .accessibilityLabel(L("close_sheet")).accessibilityIdentifier("file-preview-close")
    }
}
