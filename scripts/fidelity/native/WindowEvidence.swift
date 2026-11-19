import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreGraphics

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}
struct EvidenceError: Error, CustomStringConvertible { let description: String }
func option(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "claudex.evidence.frames")
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    var first: CMTime?
    var frames: [[String: Any]] = []
    var dropped = 0
    var droppedTimestamps: [Double] = []
    var callbackStatuses: [String: Int] = [:]
    var failure: String?
    init(url: URL, width: Int, height: Int) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(12_000_000, width * height * 8), AVVideoMaxKeyFrameIntervalKey: 60]
        ])
        input.expectsMediaDataInRealTime = true
        super.init()
        guard writer.canAdd(input) else { throw EvidenceError(description: "Cannot initialize video encoder") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? EvidenceError(description: "Cannot start video writer") }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { failure = error.localizedDescription }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        let status = attachments?.first?[.status] as? Int ?? -1
        callbackStatuses[String(status), default: 0] += 1
        guard status == SCFrameStatus.complete.rawValue else { return }
        if first == nil { first = pts; writer.startSession(atSourceTime: pts) }
        guard input.isReadyForMoreMediaData else { dropped += 1; droppedTimestamps.append(CMTimeGetSeconds(CMTimeSubtract(pts, first!))); return }
        if !input.append(sample) { failure = writer.error?.localizedDescription ?? "Failed to append frame"; return }
        frames.append(["index": frames.count, "sourceTimestampSeconds": CMTimeGetSeconds(pts), "relativeTimestampSeconds": CMTimeGetSeconds(CMTimeSubtract(pts, first!))])
    }
    func finish() async {
        queue.sync { input.markAsFinished() }
        await writer.finishWriting()
    }
}
@main struct WindowEvidence {
    static func main() async {
        do {
            let mode = CommandLine.arguments.dropFirst().first ?? "list"
            if mode == "record" || mode == "record-composited" { _ = NSApplication.shared }
            let bundle = option("--bundle") ?? "com.anthropic.claudefordesktop"
            guard ["com.anthropic.claudefordesktop", "com.github.Electron", "dev.claudex.desktop"].contains(bundle) else {
                throw EvidenceError(description: "Only Claude and our local implementation are supported")
            }
            if mode == "hover" {
                guard let id = option("--window-id").flatMap(UInt32.init),
                      let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String:Any]],
                      let row = rows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }),
                      let pid = row[kCGWindowOwnerPID as String] as? Int32,
                      NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bundle,
                      let bounds = row[kCGWindowBounds as String] as? [String:Any],
                      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                      let x = option("--x").flatMap(Double.init), let y = option("--y").flatMap(Double.init),
                      x >= 0, y >= 0, x < frame.width, y < frame.height
                else { throw EvidenceError(description: "Pointer requires a valid selected app window and in-window coordinates") }
                let point = CGPoint(x: frame.minX + x, y: frame.minY + y)
                guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { throw EvidenceError(description: "Cannot create pointer movement") }
                let hostTimestamp = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
                let route = option("--route") ?? "system"
                guard ["system", "application"].contains(route) else { throw EvidenceError(description: "Hover route must be system or application") }
                if route == "application" {
                    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(id))
                    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(id))
                    event.postToPid(pid)
                } else {
                    event.post(tap: .cghidEventTap)
                }
                try await Task.sleep(nanoseconds: 50_000_000)
                let actual = CGEvent(source: nil)?.location
                let hitWindows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []).filter { candidate in
                    guard let rect = candidate[kCGWindowBounds as String] as? [String:Any], let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return false }
                    return bounds.contains(point)
                }.prefix(3).map { candidate -> [String:Any] in
                    let owner = candidate[kCGWindowOwnerPID as String] as? Int32 ?? 0
                    return ["windowID": candidate[kCGWindowNumber as String] ?? 0,
                            "bundle": NSRunningApplication(processIdentifier: owner)?.bundleIdentifier ?? "unknown",
                            "layer": candidate[kCGWindowLayer as String] ?? 0]
                }
                emit(["event":"pointerMoved", "route":route, "windowID":id,"windowX":x,"windowY":y,"hostTimestampSeconds":hostTimestamp,
                      "postEventAccess": CGPreflightPostEventAccess(), "windowsAtPoint": hitWindows,
                      "expectedScreenX": point.x, "expectedScreenY": point.y,
                      "observedScreenX": actual?.x ?? -1, "observedScreenY": actual?.y ?? -1,
                      "frontmostBundle": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"] )
                return
            }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let windows = content.windows.filter { $0.owningApplication?.bundleIdentifier == bundle && $0.windowLayer == 0 }
            if mode == "list" {
                emit(["bundle":bundle, "windows":windows.map { ["id":$0.windowID,"title":$0.title ?? "", "x":$0.frame.minX,"y":$0.frame.minY,"width":$0.frame.width,"height":$0.frame.height] as [String:Any] }])
                return
            }
            guard let id = option("--window-id").flatMap(UInt32.init), let window = windows.first(where: { $0.windowID == id }) else {
                throw EvidenceError(description: "Choose an on-screen window ID from list; no implicit window selection")
            }
            let composited = mode == "record-composited"
            guard ["record", "record-composited"].contains(mode), let output = option("--output"),
                  let duration = option("--duration").flatMap(Double.init), duration > 0, duration <= 120
            else { throw EvidenceError(description: "record requires --output and --duration (0,120]") }
            if composited {
                guard ["com.github.Electron", "dev.claudex.desktop"].contains(bundle) else { throw EvidenceError(description: "Composited capture is restricted to Claudex") }
                guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundle else { throw EvidenceError(description: "Claudex must be frontmost for composited capture") }
            }
            let outputURL = URL(fileURLWithPath: output)
            guard !FileManager.default.fileExists(atPath: output) else { throw EvidenceError(description: "Refusing to overwrite existing recording") }
            var crop: CGRect? = nil
            if let raw = option("--crop") {
                let parts = raw.split(separator: ",").compactMap { Double($0) }
                guard parts.count == 4, parts[0] >= 0, parts[1] >= 0, parts[2] > 0, parts[3] > 0,
                      parts[0] + parts[2] <= window.frame.width, parts[1] + parts[3] <= window.frame.height
                else { throw EvidenceError(description: "Crop must be x,y,width,height within selected window") }
                crop = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
            }
            if composited && crop == nil { throw EvidenceError(description: "Composited capture requires a window-relative crop") }
            let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
            let display = content.displays.first(where: { $0.frame.contains(center) })
            let filter: SCContentFilter
            if composited {
                guard let display else { throw EvidenceError(description: "Selected window is not centered on a capturable display") }
                filter = SCContentFilter(display: display, including: [window])
            } else {
                filter = SCContentFilter(desktopIndependentWindow: window)
            }
            let nativeScale = Double(filter.pointPixelScale)
            let scale = option("--scale").flatMap(Double.init) ?? nativeScale
            guard scale > 0, scale <= nativeScale else { throw EvidenceError(description: "Scale must be positive and no larger than native scale") }
            let width = Int((crop?.width ?? filter.contentRect.width) * scale) / 2 * 2
            let height = Int((crop?.height ?? filter.contentRect.height) * scale) / 2 * 2
            let config = SCStreamConfiguration()
            config.width = width; config.height = height
            let sourceRect: CGRect? = crop.map { rect in
                guard composited, let display else { return rect }
                return CGRect(x: window.frame.minX + rect.minX - display.frame.minX,
                              y: window.frame.minY + rect.minY - display.frame.minY,
                              width: rect.width, height: rect.height)
            }
            if let sourceRect { config.sourceRect = sourceRect }
            config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
            config.queueDepth = 8
            config.showsCursor = false
            config.capturesAudio = false
            config.ignoreShadowsSingleWindow = true
            let recorder = try Recorder(url: outputURL, width: width, height: height)
            let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
            try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
            try await stream.startCapture()
            emit(["event":"recordingStarted","output":output,"windowID":id,"width":width,"height":height,"scale":scale,"requestedFPS":60,"durationSeconds":duration,"mode":mode,"sourceRect":sourceRect.map { ["x":$0.minX,"y":$0.minY,"width":$0.width,"height":$0.height] } as Any? ?? NSNull()])
            try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            do { try await stream.stopCapture() }
            catch { recorder.failure = recorder.failure ?? error.localizedDescription }
            await recorder.finish()
            let metadata: [String:Any] = ["bundle":bundle,"windowID":id,"width":width,"height":height,"scale":scale,"nativeScale":nativeScale,"mode":mode,"sourceRect":sourceRect.map { ["x":$0.minX,"y":$0.minY,"width":$0.width,"height":$0.height] } as Any? ?? NSNull(),"crop":crop.map { ["x":$0.minX,"y":$0.minY,"width":$0.width,"height":$0.height] } as Any? ?? NSNull(),"requestedFPS":60,"requestedDurationSeconds":duration,"droppedFrames":recorder.dropped,"droppedTimestamps":recorder.droppedTimestamps,"callbackStatuses":recorder.callbackStatuses,"frames":recorder.frames,"note":"Only complete ScreenCaptureKit frames are written. Idle periods may be variable-rate. No invented intermediate frames.","failure":recorder.failure ?? ""]
            try JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted,.sortedKeys]).write(to: URL(fileURLWithPath: output + ".json"))
            guard recorder.writer.status == .completed, recorder.failure == nil, !recorder.frames.isEmpty else { throw EvidenceError(description: recorder.failure ?? "Recording did not complete") }
            emit(["event":"recordingCompleted","output":output,"frameCount":recorder.frames.count,"droppedFrames":recorder.dropped])
        } catch {
            emit(["error":String(describing:error)])
            exit(1)
        }
    }
}
