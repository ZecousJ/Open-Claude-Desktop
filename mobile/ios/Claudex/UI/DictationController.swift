import AVFoundation
import Speech
import SwiftUI

/// Dictation is deliberately on-device only. It never sends audio to Claudex.
///
/// Follows the official speech-to-text pattern: while recording the composer shows a waveform fed by `levels` (one
/// sample per 60 ms); "Stop" / "Send" end the audio and wait for the final transcript ("Transcribing…"); "Cancel"
/// throws the recording away.
@MainActor
final class DictationController: ObservableObject {
  enum Phase: Equatable { case idle, starting, listening, transcribing }
  /// Official STT errors plus the two the device itself can raise.
  enum Failure: Equatable {
    case microphone, interrupted, empty, languageUnavailable, permission, unsupported
    var key: String {
      switch self {
      case .microphone: "stt_error_microphone"
      case .interrupted: "stt_error_microphone_interrupted"
      case .empty: "stt_error_transcription_empty"
      case .languageUnavailable: "stt_error_language_not_found"
      case .permission: "claudex_stt_error_permission"
      case .unsupported: "claudex_stt_error_unsupported"
      }
    }
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var transcript = ""
  @Published private(set) var failure: Failure?
  /// Waveform samples, newest last; nil = no sample for that 60 ms slot.
  @Published private(set) var levels: [Double?] = []
  /// Seconds since the last sample louder than silence.
  @Published private(set) var silentFor: TimeInterval = 0

  var isListening: Bool { phase == .listening || phase == .starting }
  var isActive: Bool { phase != .idle }

  /// Hold-to-talk needs on-device Chinese recognition; without it the gesture is not offered.
  static var holdToTalkAvailable: Bool {
    SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))?.supportsOnDeviceRecognition == true
  }

  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var installedTap = false
  private var audioSessionActive = false
  private var recognizer: SFSpeechRecognizer?
  private var generation = 0
  private var sampler: Timer?
  private let meter = LevelMeter()
  private var finalWaiter: CheckedContinuation<Void, Never>?
  private static let maxSamples = 160

  func clearFailure() { failure = nil }

  func start() async {
    teardown()
    failure = nil
    transcript = ""
    levels = []
    silentFor = 0
    phase = .starting
    generation += 1
    let epoch = generation
    let speech = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard epoch == generation else { return }
    guard speech == .authorized else { return fail(.permission) }
    let microphone = await withCheckedContinuation { continuation in
      AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
    }
    guard epoch == generation else { return }
    guard microphone else { return fail(.permission) }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else { return fail(.languageUnavailable) }
    guard recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return fail(.unsupported) }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement)
      try session.setActive(true)
      audioSessionActive = true
      self.recognizer = recognizer
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true
      request.shouldReportPartialResults = true
      self.request = request
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else { throw DictationStartError.noInput }
      let meter = self.meter
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
        meter.record(buffer)
      }
      installedTap = true
      task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        let text = result?.bestTranscription.formattedString
        let final = result?.isFinal == true
        let failed = error != nil
        Task { @MainActor in self?.recognized(text, final: final, failed: failed, epoch: epoch) }
      }
      engine.prepare()
      try engine.start()
      phase = .listening
      startSampling()
    } catch {
      fail(.microphone)
    }
  }

  /// Ends the audio and waits (at most 2 s) for the final transcript.
  /// Returns the transcript, or nil after a failure / cancel.
  func finish() async -> String? {
    guard phase == .listening || phase == .starting else { return nil }
    if phase == .starting { cancel(); return nil }
    let epoch = generation
    phase = .transcribing
    stopAudio()
    request?.endAudio()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      finalWaiter = continuation
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(2))
        self?.resumeWaiter()
      }
    }
    guard epoch == generation else { return nil }
    let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    teardown()
    if text.isEmpty { failure = .empty; return nil }
    return text
  }

  /// Throws the recording away.
  func cancel() {
    generation += 1
    teardown()
    transcript = ""
  }

  /// Stopped by the system (background, sheet, drawer): an official "interrupted" note when audio
  /// was actually recording.
  func interrupt() {
    let wasRecording = phase == .listening
    cancel()
    if wasRecording { failure = .interrupted }
  }

  private func recognized(_ text: String?, final: Bool, failed: Bool, epoch: Int) {
    guard epoch == generation else { return }
    if let text { transcript = text }
    if final || failed {
      if phase == .transcribing { resumeWaiter(); return }
      if failed && phase == .listening && transcript.isEmpty { fail(.microphone) }
    }
  }

  private func resumeWaiter() {
    finalWaiter?.resume()
    finalWaiter = nil
  }

  private func fail(_ reason: Failure) {
    teardown()
    failure = reason
  }

  private func startSampling() {
    sampler?.invalidate()
    let timer = Timer(timeInterval: DictationWaveform.sampleInterval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.sample() }
    }
    RunLoop.main.add(timer, forMode: .common)
    sampler = timer
  }

  private func sample() {
    guard phase == .listening else { return }
    let level = meter.take()
    if let level, level > 0.02 { silentFor = 0 } else { silentFor += DictationWaveform.sampleInterval }
    levels.append(level)
    if levels.count > Self.maxSamples { levels.removeFirst(levels.count - Self.maxSamples) }
  }

  private func stopAudio() {
    sampler?.invalidate()
    sampler = nil
    engine.stop()
    if installedTap {
      engine.inputNode.removeTap(onBus: 0)
      installedTap = false
    }
  }

  private func teardown() {
    stopAudio()
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    resumeWaiter()
    if audioSessionActive {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      audioSessionActive = false
    }
    recognizer = nil
    phase = .idle
  }
}

private enum DictationStartError: Error { case noInput }

/// Audio-thread side of the waveform: the loudest RMS level since the last 60 ms sample.
private final class LevelMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var peak: Double?
  func record(_ buffer: AVAudioPCMBuffer) {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    for index in 0..<count { sum += channel[index] * channel[index] }
    let level = DictationWaveform.level(rms: Double((sum / Float(count)).squareRoot()))
    lock.lock()
    peak = max(peak ?? 0, level)
    lock.unlock()
  }
  func take() -> Double? {
    lock.lock()
    defer { lock.unlock() }
    let value = peak
    peak = nil
    return value
  }
}
