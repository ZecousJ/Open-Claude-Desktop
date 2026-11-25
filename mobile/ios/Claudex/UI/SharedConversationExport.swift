import SwiftUI

/// The transcript retains this small native presenter. Save promises settle only
/// after UIKit finishes dismissing the chooser, so a batch cannot overlap pickers.
@MainActor final class SharedConversationExporter: NSObject, ObservableObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    @Published private(set) var isExporting = false
    private weak var presenter: UIViewController?
    private var picker: UIDocumentPickerViewController?
    private var loadingID: UUID?
    private var completing = false
    private var pending: (id: UUID, source: URL, continuation: CheckedContinuation<String?, Error>)?

    func attach(_ controller: UIViewController) { presenter = controller }
    func detach(_ controller: UIViewController) {
        guard presenter === controller else { return }
        presenter = nil; cancel()
    }
    func export(_ file: GeneratedFile, store: AppStore, validate: @MainActor () throws -> Void) async throws -> String? {
        guard pending == nil, loadingID == nil, let presenter, presenter.viewIfLoaded?.window != nil,
              presenter.presentedViewController == nil else { throw ServiceError.server(L("claudex_msg_save_in_progress"), "EXPORT_BUSY") }
        let id = UUID(); loadingID = id; isExporting = true
        defer { if loadingID == id { loadingID = nil }; if pending == nil { isExporting = false } }
        try validate()
        let materialized: (url: URL, data: Data)
        do { materialized = try await store.materializeGeneratedFile(file) }
        catch { store.validateSessionError(error); throw error }
        do { try Task.checkCancellation(); try validate() } catch {
            try? FileManager.default.removeItem(at: materialized.url.deletingLastPathComponent()); throw error
        }
        loadingID = nil
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard pending == nil, self.presenter === presenter, presenter.viewIfLoaded?.window != nil,
                      presenter.presentedViewController == nil else {
                    try? FileManager.default.removeItem(at: materialized.url.deletingLastPathComponent())
                    continuation.resume(throwing: ServiceError.server(L("claudex_msg_save_failed"), "EXPORT_UNAVAILABLE")); return
                }
                pending = (id, materialized.url, continuation); completing = false
                let controller = UIDocumentPickerViewController(forExporting: [materialized.url], asCopy: true)
                controller.delegate = self
                picker = controller
                presenter.present(controller, animated: true)
                controller.presentationController?.delegate = self
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(id: id) }
        }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker else { return }
        dismiss(result: urls.first?.lastPathComponent)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === picker else { return }; dismiss(result: nil)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard !completing, presentationController.presentedViewController === picker, let operation = pending else { return }
        // Interactive dismissal has already ended; it is a user cancellation.
        finish(id: operation.id, result: nil)
    }
    func cancel(id: UUID? = nil) {
        guard let operation = pending, id == nil || operation.id == id else { return }
        dismiss(result: nil)
    }
    private func dismiss(result: String?) {
        guard let operation = pending, let picker, !completing else { return }
        completing = true
        // Keep pending reserved until dismissal completes for both save and
        // cancellation. No successor can present while a chooser is closing.
        if picker.presentingViewController != nil {
            picker.dismiss(animated: presenter?.viewIfLoaded?.window != nil) { [weak self] in
                self?.finish(id: operation.id, result: result)
            }
        } else { finish(id: operation.id, result: result) }
    }
    private func finish(id: UUID, result: String?) {
        guard let operation = pending, operation.id == id else { return }
        pending = nil; picker = nil; completing = false; isExporting = false
        try? FileManager.default.removeItem(at: operation.source.deletingLastPathComponent())
        // Report only a display name, not an unrelated system filesystem path.
        operation.continuation.resume(returning: result)
    }
}

struct SharedConversationExportHost: UIViewControllerRepresentable {
    let exporter: SharedConversationExporter
    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController(); controller.view.backgroundColor = .clear
        exporter.attach(controller); return controller
    }
    func updateUIViewController(_ controller: UIViewController, context: Context) {}
    func makeCoordinator() -> SharedConversationExporter { exporter }
    static func dismantleUIViewController(_ controller: UIViewController, coordinator: SharedConversationExporter) { coordinator.detach(controller) }
}
