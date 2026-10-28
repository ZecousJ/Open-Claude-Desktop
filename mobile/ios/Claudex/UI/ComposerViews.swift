import SwiftUI
import UIKit

/// The official floating composer: a 24pt card at 96 % `bg000` with a 0.5pt hairline (dashed 1pt in an incognito
/// chat) and the floating shadow; the attachment strip, the field (grows to 10 lines) and the toolbar inside;
/// usage-limit and waiting-message cards and dictation errors above it.
///
/// Toolbar: + (Add to chat), the model pill; on the right the microphone and Send / Stop. Dictation swaps the toolbar
/// for the recording strip (Cancel · waveform · Stop · Send), and holding the empty toolbar starts hold-to-talk.
struct ComposerView: View {
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @EnvironmentObject private var store: AppStore
  @ObservedObject private var usage = UsageLimitMonitor.shared
  /// A caller-provided placeholder; nil uses the official hints (`chat_input_hint*`).
  var placeholder: String?
  var mode: ChatMode?
  @State private var modelSheet = false
  @State private var attachmentsSheet = false
  @State private var queueSheet = false
  @State private var localPreview: LocalAttachment?
  @StateObject private var dictation = DictationController()
  @State private var dictationPrefix = ""
  @State private var holding = false
  @State private var holdCancelZone = false
  @State private var holdToTalk = DictationController.holdToTalkAvailable
  @FocusState private var focused: Bool

  private var composerMode: ChatMode { mode ?? store.activeConversation?.mode ?? store.mode }
  private var hasContent: Bool {
    !store.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.attachments.isEmpty
  }
  private var action: ComposerPresentation.Action {
    ComposerPresentation.action(hasContent: hasContent, responding: store.running)
  }
  private var uploading: Bool { store.uploadProgress != nil || (store.isSending && store.attachments.contains { $0.uploaded == nil }) }
  private var incognito: Bool { store.activeConversation?.extensionFields["incognito"]?.bool == true }
  private var projectName: String? {
    let id = store.activeConversation?.projectId ?? store.preparedProjectID
    return id.flatMap { id in store.snapshot?.projects.first { $0.id == id }?.name }
  }
  private var hint: String {
    if let placeholder, !store.isSending { return placeholder }
    let value = ComposerPresentation.hint(
      sending: store.isSending, newChat: store.activeConversationID == nil, projectName: projectName,
      holdToTalk: holdToTalk && !store.isSending)
    return value.argument.map { L(value.key, $0) } ?? L(value.key)
  }
  private var effortValue: String {
    composerMode == .code ? store.snapshot?.settings.codeEffort ?? "" : store.snapshot?.settings.effort ?? ""
  }
  private var modelName: String {
    store.selectedModel?.displayName ?? (store.selectedModelID.isEmpty ? L("chat_select_model") : store.selectedModelID)
  }

  var body: some View {
    VStack(spacing: 0) {
      if let notice = usage.notice {
        UsageLimitBanner(notice: notice).padding(.bottom, 8)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      if !store.queuedMessages.isEmpty {
        WaitingMessagesStrip(open: { queueSheet = true }).padding(.bottom, 8)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      if let failure = dictation.failure {
        Button { dictation.clearFailure() } label: {
          Text(sttMessage(L(failure.key))).typeStyle(.bodyLarge).italic().foregroundStyle(Palette.text300)
            .lineLimit(3).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain).padding(.horizontal, 8).padding(.bottom, 8)
          .transition(.opacity.combined(with: .move(edge: .bottom)))
          .accessibilityIdentifier("dictation-error")
      }
      card
    }
    .frame(maxWidth: 768)
    .animation(reduceMotion ? nil : Motion.spring, value: usage.notice)
    .animation(reduceMotion ? nil : Motion.spring, value: store.queuedMessages.count)
    .animation(reduceMotion ? nil : Motion.spring, value: dictation.failure)
    .claudeSheet(item: $localPreview, detents: [.large]) { AttachmentPreviewView(attachment: $0) }
    .claudeSheet(isPresented: $queueSheet) { WaitingMessagesSheet() }
    .claudeSheet(isPresented: $modelSheet) {
      // Inside a Code session the pill names, and changes, the session's own model.
      ModelSheet(mode: composerMode, conversation: store.activeConversation?.mode == .code ? store.activeConversation : nil)
    }
    .claudeSheet(isPresented: $attachmentsSheet) { AttachmentSheet(mode: composerMode) }
    .task(id: store.accountGeneration) { await usage.refresh(store) }
    .onChange(of: store.running) { _, running in if !running { Task { await usage.refresh(store) } } }
    .onChange(of: store.composerText) { _, text in if !text.isEmpty, dictation.failure != nil { dictation.clearFailure() } }
    .onDisappear { dictation.cancel() }
    // A system permission alert may make the scene inactive while a request is pending;
    // live recording always stops in the background.
    .onChange(of: scenePhase) { _, phase in
      if phase == .background || (phase == .inactive && dictation.isListening) { dictation.interrupt() }
    }
    .onChange(of: store.sidebarPresented) { _, showing in if showing { dictation.cancel() } }
    .onChange(of: modelSheet) { _, showing in if showing { dictation.cancel() } }
    .onChange(of: attachmentsSheet) { _, showing in if showing { dictation.cancel() } }
    .onChange(of: queueSheet) { _, showing in if showing { dictation.cancel() } }
  }

  // MARK: Card

  private var card: some View {
    let shape = RoundedRectangle(cornerRadius: Radius.r24, style: .continuous)
    return VStack(spacing: 0) {
      if !store.attachments.isEmpty && !dictation.isActive { attachmentStrip }
      textRow
      toolbar
    }
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, minHeight: 48)
    .foregroundStyle(Palette.text100)
    // The floating shadow belongs to the card only, not to the controls inside it.
    .background(shape.fill(Palette.bg000.opacity(0.96)).claudeShadow(Shadow.medium))
    .overlay {
      if incognito {
        shape.strokeBorder(Palette.border300, style: StrokeStyle(lineWidth: 1, dash: [5, 5]))
      } else {
        shape.strokeBorder(Palette.border300, lineWidth: 0.5)
      }
    }
  }

  private var textRow: some View {
    TextField("", text: $store.composerText, prompt: Text(hint).foregroundStyle(Palette.text500), axis: .vertical)
      .typeStyle(.bodyLarge)
      .foregroundStyle(Palette.text100)
      .tint(Palette.text500)
      .lineLimit(1...10)
      .textInputAutocapitalization(.sentences)
      .focused($focused)
      .padding(.vertical, 8)
      .frame(minHeight: 36)
      .padding(.horizontal, 13)
      .opacity(dictation.isActive ? 0 : 1)
      .frame(maxHeight: dictation.isActive ? 0 : nil)
      .clipped()
      .allowsHitTesting(!dictation.isActive)
      .accessibilityHidden(dictation.isActive)
      .accessibilityIdentifier("composer-input")
  }

  // MARK: Attachments

  private var attachmentStrip: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(store.attachments) { file in
          ComposerAttachmentTile(
            attachment: file, uploading: store.isSending && file.uploaded == nil,
            progress: store.uploadProgress, open: { localPreview = file },
            remove: { store.removeAttachment(file.id) }
          ).disabled(store.isSending)
        }
      }.padding(.horizontal, 8)
    }.frame(height: 96).padding(.bottom, 4)
  }

  // MARK: Toolbar

  @ViewBuilder private var toolbar: some View {
    // The normal toolbar stays in place (hidden) while recording, so a hold that started on it
    // keeps its gesture until the finger lifts.
    ZStack {
      normalToolbar
        .opacity(dictation.isActive ? 0 : 1)
        .allowsHitTesting(!dictation.isActive || holding)
        .accessibilityHidden(dictation.isActive)
      if dictation.isActive {
        DictationToolbar(
          controller: dictation, holding: holding, cancelZone: holdCancelZone,
          cancel: cancelDictation, stop: { Task { await finishDictation(send: false) } },
          send: { Task { await finishDictation(send: true) } })
          .allowsHitTesting(!holding)
          .transition(.opacity)
      }
    }
    .padding(.horizontal, 8)
    .frame(minHeight: store.attachments.isEmpty ? 48 : nil)
    .animation(reduceMotion ? nil : Motion.spring, value: dictation.isActive)
  }

  private var normalToolbar: some View {
    HStack(spacing: 0) {
      HStack(spacing: 4) {
        ComposerRoundButton(
          icon: .add, fill: Palette.tileFill, tint: Palette.text100, label: L("chat_input_add_to_chat")
        ) { attachmentsSheet = true }
          .accessibilityIdentifier("open-attachments")
        modelPill.padding(.leading, 2)
      }
      .layoutPriority(1)
      // The empty part of the toolbar: hold here to talk (official walkie-talkie).
      Color.clear.frame(minWidth: 8, maxWidth: .infinity).frame(height: 48)
        .contentShape(Rectangle())
        .gesture(holdGesture, including: holdToTalk ? .all : .none)
        .accessibilityHidden(true)
      HStack(spacing: 0) {
        ComposerRoundButton(
          icon: .microphone, fill: Palette.tileFill, tint: Palette.text300, label: L("chat_input_start_speech_input")
        ) { startDictation() }
          .padding(.trailing, action == .none ? 8 : 0)
          .accessibilityIdentifier("start-dictation")
        switch action {
        case .send: sendButton.transition(.scale(scale: 0.01).combined(with: .opacity))
        case .stop: stopButton.transition(.scale(scale: 0.01).combined(with: .opacity))
        case .none: EmptyView()
        }
      }
    }
    .animation(reduceMotion ? nil : Motion.spring, value: action)
  }

  private var modelPill: some View {
    let scale = UIFontMetrics.default.scaledValue(for: 1)
    let maxWidth = ComposerPresentation.modelPillMaxWidth(
      screenWidth: Double(UIScreen.main.bounds.width), fontScale: Double(scale))
    return Button { modelSheet = true } label: {
      HStack(spacing: 4) {
        Text(modelName).foregroundStyle(Palette.text100).lineLimit(1)
        if !effortValue.isEmpty {
          Text(effortName(effortValue)).foregroundStyle(Palette.text300).lineLimit(1).layoutPriority(-1)
        }
      }
      .typeStyle(.caption)
      .padding(.horizontal, 16)
      .frame(minHeight: 36)
      .background(Palette.tileFill, in: Capsule())
      .frame(maxWidth: CGFloat(maxWidth), alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.vertical, 4)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(L("model_selector_chip_a11y", modelName))
    .accessibilityIdentifier("open-models")
  }

  private var sendButton: some View {
    let enabled = store.canSend
    return Button {
      if uploading { store.cancelUpload(); return }
      focused = false
      store.send()
    } label: {
      ZStack {
        Circle().fill(enabled || uploading ? Palette.accentMain100 : Palette.text100.opacity(0.10))
        if uploading {
          ClaudeSpinner(size: .small, color: .white)
        } else {
          AppGlyphView(.arrowUp, size: 20)
            .foregroundStyle(enabled ? Color.white : Palette.text100.opacity(0.38))
        }
      }
      .frame(width: 36, height: 36).frame(width: 48, height: 48).contentShape(Circle())
    }
    .buttonStyle(IconPressStyle())
    .disabled(!enabled && !uploading)
    .accessibilityLabel(L(uploading ? "chat_input_send_button_waiting_for_uploads" : "chat_input_send_button_content_description"))
    .accessibilityHint(uploading ? L("claudex_upload_cancel_hint") : "")
    .accessibilityIdentifier("send-message")
  }

  private var stopButton: some View {
    ComposerRoundButton(
      icon: .stop, fill: Palette.tileFill, tint: Palette.text100, label: L("chat_input_stop_button_content_description")
    ) {
      cancelDictation()
      focused = false
      Task { await store.stopGeneration() }
    }.accessibilityIdentifier("stop-generation")
  }

  // MARK: Dictation

  private func startDictation() {
    focused = false
    dictationPrefix = store.composerText
    Task { await dictation.start() }
  }

  private func cancelDictation() {
    dictation.cancel()
    holding = false
    holdCancelZone = false
  }

  private func finishDictation(send: Bool) async {
    holding = false
    guard let text = await dictation.finish() else { return }
    store.composerText = ComposerPresentation.merge(prefix: dictationPrefix, transcript: text)
    if send && store.canSend { store.send() }
  }

  /// Long-press the empty toolbar, talk, release to send; slide left onto × to cancel.
  private var holdGesture: some Gesture {
    LongPressGesture(minimumDuration: 0.35)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
      .onChanged { value in
        guard case .second(true, let drag) = value else { return }
        if !holding {
          holding = true
          UIImpactFeedbackGenerator(style: .medium).impactOccurred()
          startDictation()
        }
        holdCancelZone = (drag?.translation.width ?? 0) < -60
      }
      .onEnded { _ in
        guard holding else { return }
        if holdCancelZone { cancelDictation() } else { Task { await finishDictation(send: true) } }
      }
  }
}

// MARK: Pieces

/// The composer's round button: 48pt touch target, 36pt filled circle, 20pt icon; disabled at 40 %.
struct ComposerRoundButton: View {
  let icon: AppGlyph
  let fill: Color
  let tint: Color
  let label: String
  let action: () -> Void
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    Button(action: action) {
      ZStack {
        Circle().fill(fill)
        AppGlyphView(icon, size: 20).foregroundStyle(tint)
      }
      .frame(width: 36, height: 36).frame(width: 48, height: 48).contentShape(Circle())
      .opacity(enabled ? 1 : 0.4)
    }
    .buttonStyle(IconPressStyle())
    .accessibilityLabel(label)
  }
}

/// A 96pt attachment tile: image (16pt corners on `bg100`) or a file face with its extension
/// badge; remove button top-trailing; upload progress over a dimmed tile.
struct ComposerAttachmentTile: View {
  let attachment: LocalAttachment
  var uploading = false
  var progress: Double?
  let open: () -> Void
  let remove: () -> Void
  @State private var image: UIImage?
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Radius.r16, style: .continuous)
    Button(action: open) {
      ZStack(alignment: .bottomLeading) {
        if let image {
          Image(uiImage: image).resizable().scaledToFill().frame(width: 96, height: 96).clipped()
        } else {
          Palette.bg300
          Text(attachment.name).typeStyle(.caption).foregroundStyle(Palette.text300).lineLimit(3)
            .padding(10).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          let ext = attachment.url.pathExtension.uppercased()
          if !ext.isEmpty {
            Text(ext).typeStyle(.badge).foregroundStyle(Palette.text300).lineLimit(1)
              .padding(.horizontal, 6).padding(.vertical, 1)
              .background(Palette.bg000, in: RoundedRectangle(cornerRadius: Radius.r8, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: Radius.r8, style: .continuous).strokeBorder(Palette.border200, lineWidth: 0.5))
              .padding(8)
          }
        }
        if uploading {
          Color.black.opacity(0.25)
          ClaudeSpinner(size: .small, color: .white, progress: progress)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .frame(width: 96, height: 96)
      .background(Palette.bg100)
      .clipShape(shape)
    }
    .buttonStyle(.plain)
    .overlay(alignment: .topTrailing) {
      if !uploading {
        Button(action: remove) {
          AppGlyphView(.x, size: 14).foregroundStyle(Palette.text100)
            .frame(width: 22, height: 22).background(Palette.bg000.opacity(0.9), in: Circle())
            .overlay(Circle().strokeBorder(Palette.border300, lineWidth: 0.5))
            .frame(width: 34, height: 34).contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.top, 1).padding(.trailing, 1)
        .accessibilityLabel(L("chat_input_image_remove_button_content_description") + " " + attachment.name)
      }
    }
    .accessibilityLabel(attachment.name)
    .task(id: attachment.id) {
      let url = attachment.url
      let bytes = await Task.detached(priority: .utility) { LocalPhotoThumbnail.data(url: url) }.value
      guard !Task.isCancelled else { return }
      image = bytes.flatMap { UIImage(data: $0) }
    }
  }
}

/// The recording strip that replaces the toolbar.
struct DictationToolbar: View {
  @ObservedObject var controller: DictationController
  let holding: Bool
  let cancelZone: Bool
  let cancel: () -> Void
  let stop: () -> Void
  let send: () -> Void
  var body: some View {
    let transcribing = controller.phase == .transcribing
    HStack(spacing: 12) {
      if holding {
        HoldTarget(icon: .x, activeColor: Palette.danger100, active: cancelZone)
      } else {
        dictationButton(.x, fill: Palette.tileFill, tint: Palette.text100, label: L("generic_button_cancel"), action: cancel)
          .accessibilityIdentifier("dictation-cancel")
      }
      ZStack {
        if transcribing {
          Text(L("stt_input_transcribing")).typeStyle(.caption).foregroundStyle(Palette.text300)
            .transition(.opacity)
        } else if holding {
          VStack(spacing: 8) {
            Text(L(cancelZone ? "stt_release_to_cancel" : "stt_release_to_send")).typeStyle(.caption)
              .foregroundStyle(Palette.text500).lineLimit(1)
            DictationWaveformView(levels: controller.levels, silentFor: controller.silentFor)
              .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.2)], startPoint: .leading, endPoint: .trailing))
          }.transition(.opacity)
        } else {
          DictationWaveformView(levels: controller.levels, silentFor: controller.silentFor).transition(.opacity)
        }
      }
      .frame(maxWidth: .infinity)
      .animation(Motion.spring, value: transcribing)
      if holding {
        HoldTarget(icon: .arrowUp, activeColor: Palette.accentMain100, active: !cancelZone)
      } else {
        dictationButton(.stopFilled, fill: Palette.tileFill, tint: Palette.text100, label: L("stt_input_stop_dictation"), spinning: transcribing, action: stop)
          .disabled(transcribing)
          .accessibilityIdentifier("dictation-stop")
        dictationButton(.arrowUp, fill: Palette.accentMain100, tint: .white, label: L("stt_input_send_dictation"), action: send)
          .disabled(transcribing)
          .accessibilityIdentifier("dictation-send")
      }
    }
    .frame(minHeight: 48)
  }

  private func dictationButton(
    _ icon: AppGlyph, fill: Color, tint: Color, label: String, spinning: Bool = false, action: @escaping () -> Void
  ) -> some View {
    DictationButton(icon: icon, fill: fill, tint: tint, label: label, spinning: spinning, action: action)
  }
}

/// 36pt dictation button; disabled at 38 % of its colours.
private struct DictationButton: View {
  let icon: AppGlyph
  let fill: Color
  let tint: Color
  let label: String
  let spinning: Bool
  let action: () -> Void
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    Button(action: action) {
      ZStack {
        Circle().fill(fill.opacity(enabled ? 1 : 0.38))
        if spinning {
          ClaudeSpinner(size: .xSmall, color: tint)
        } else {
          AppGlyphView(icon, size: 20).foregroundStyle(tint.opacity(enabled ? 1 : 0.38))
        }
      }
      .frame(width: 36, height: 36).frame(minWidth: 44, minHeight: 44).contentShape(Circle())
    }
    .buttonStyle(IconPressStyle())
    .accessibilityLabel(label)
  }
}

/// Hold-to-talk target: 36pt circle; active = target colour and 1.2×.
private struct HoldTarget: View {
  let icon: AppGlyph
  let activeColor: Color
  let active: Bool
  var body: some View {
    ZStack {
      Circle().fill(active ? activeColor : Palette.bg300)
      AppGlyphView(icon, size: 20).foregroundStyle(active ? Color.white : Palette.text500)
    }
    .frame(width: 36, height: 36)
    .scaleEffect(active ? 1.2 : 1)
    .animation(.interpolatingSpring(mass: 1, stiffness: 1500, damping: 2 * 1500.0.squareRoot()), value: active)
    .accessibilityHidden(true)
  }
}

/// Scrolling waveform: 3pt bars, 3pt gaps, 25pt high, newest at the right.
struct DictationWaveformView: View {
  let levels: [Double?]
  let silentFor: TimeInterval
  var body: some View {
    Canvas { context, size in
      let count = DictationWaveform.capacity(width: size.width)
      guard count > 0 else { return }
      let visible = Array(levels.suffix(count))
      let offset = count - visible.count
      let silent = silentFor > DictationWaveform.silenceInterval
      for (index, sample) in visible.enumerated() {
        guard let sample else { continue }
        let slot = offset + index
        let height = DictationWaveform.barHeight(level: sample, index: slot, count: count, height: size.height)
        let x = size.width - Double(count - slot) * (DictationWaveform.barWidth + DictationWaveform.gap) + DictationWaveform.gap
        let rect = CGRect(x: x, y: (size.height - height) / 2, width: DictationWaveform.barWidth, height: height)
        let color = sample > 0.02 && !silent ? Palette.text100 : Palette.text300
        context.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(color))
      }
    }
    .frame(height: DictationWaveform.height)
    .accessibilityHidden(true)
  }
}

/// The rate-limit card near the composer: 16pt corners on `bg300`, 12pt padding, 13pt strong title and 11pt `text300`
/// subtitle. No upgrade action: Claudex sells no plans in-app.
struct UsageLimitBanner: View {
  let notice: UsageLimitNotice
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(L(notice.kind == .reached ? "rate_limit_reached" : "rate_limit_approaching"))
        .typeStyle(.captionStrong).foregroundStyle(Palette.text100)
      Text(subtitle).typeStyle(.micro).foregroundStyle(Palette.text300)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("usage-limit-banner")
  }
  private var subtitle: String {
    guard let reset = notice.resetsAt else { return L("rate_limit_try_again_later") }
    let time = reset.formatted(date: .omitted, time: .shortened)
    if Calendar.current.isDateInToday(reset) { return L("rate_limit_resets_at_time", time) }
    let day = reset.formatted(.dateTime.weekday(.wide))
    return L("rate_limit_resets_day_at_time", day, time)
  }
}

/// Waiting messages above the composer: the next waiting message, breathing like the official
/// queued bubble, with "N waiting · show all waiting messages" and "Send now".
struct WaitingMessagesStrip: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let open: () -> Void
  @State private var breathe = false
  var body: some View {
    if let first = store.queuedMessages.first {
      VStack(alignment: .leading, spacing: 6) {
        Button(action: open) {
          Text(first.text.isEmpty ? L10n.plural("claudex_attachments_count", count: first.attachments.count) : first.text)
            .typeStyle(.body).foregroundStyle(Palette.text100).lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(reduceMotion ? 0.7 : (breathe ? 0.9 : 0.65))
        }.buttonStyle(.plain)
          .accessibilityHint(L("chat_message_queued_state_description"))
        if let error = first.error {
          Text(error).typeStyle(.caption).foregroundStyle(Palette.dangerText).lineLimit(2)
        }
        HStack(spacing: 12) {
          if store.queuedMessages.count > 1 {
            Button(action: open) {
              Text(L10n.plural("chat_waiting_messages_count", count: store.queuedMessages.count) + " · "
                + L("chat_waiting_messages_show_all"))
            }.buttonStyle(.plain).foregroundStyle(Palette.text300)
          } else if first.state == .steered {
            Text(L("claudex_waiting_message_steered")).foregroundStyle(Palette.text300)
          } else {
            Text(L("chat_message_queued_state_description")).foregroundStyle(Palette.text300)
          }
          Spacer(minLength: 0)
          if first.state == .queued {
            Button(L("chat_waiting_message_menu_send_now")) { store.sendQueuedNow(first) }
              .buttonStyle(.plain).typeStyle(.captionStrong).foregroundStyle(Palette.textSecondary)
              .disabled(store.composerBusy)
              .accessibilityIdentifier("waiting-send-now")
          }
        }.typeStyle(.caption).lineLimit(1)
      }
      .padding(12)
      .background(Palette.bg300, in: RoundedRectangle(cornerRadius: Radius.r16, style: .continuous))
      .accessibilityIdentifier("open-queued-messages")
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.timingCurve(0.4, 0, 0.2, 1, duration: 1.4).repeatForever(autoreverses: true)) { breathe = true }
      }
    }
  }
}

/// Official STT copy marks its lead sentence with `<b>…</b>`.
func sttMessage(_ value: String) -> AttributedString {
  var result = AttributedString()
  var rest = Substring(value)
  while let open = rest.range(of: "<b>") {
    result.append(AttributedString(String(rest[..<open.lowerBound])))
    rest = rest[open.upperBound...]
    let close = rest.range(of: "</b>")
    var bold = AttributedString(String(rest[..<(close?.lowerBound ?? rest.endIndex)]))
    bold.inlinePresentationIntent = .stronglyEmphasized
    result.append(bold)
    rest = close.map { rest[$0.upperBound...] } ?? ""
  }
  result.append(AttributedString(String(rest)))
  return result
}

func effortName(_ value: String) -> String {
  ["none", "minimal", "low", "medium", "high", "xhigh", "max"].contains(value) ? L("claudex_effort_" + value) : value
}

/// Reads the account's plan windows (the same `planUsage` the Balance & usage page shows) for
/// the composer's limit card; at most once a minute.
@MainActor
final class UsageLimitMonitor: ObservableObject {
  static let shared = UsageLimitMonitor()
  @Published private(set) var notice: UsageLimitNotice?
  private var lastLoad: Date?
  private var account: UUID?
  private var loading = false
  func refresh(_ store: AppStore) async {
    if account != store.accountGeneration { account = store.accountGeneration; notice = nil; lastLoad = nil }
    guard store.account != nil, !loading else { return }
    if let lastLoad, Date().timeIntervalSince(lastLoad) < 60 { return }
    loading = true
    defer { loading = false }
    let generation = store.accountGeneration
    guard let value = try? await store.accountRequest({ try await $0.rpc.call("planUsage", args: [.bool(true)], as: JSONValue.self) }),
      generation == store.accountGeneration
    else { return }
    lastLoad = Date()
    notice = UsageLimitNotice.from(value)
  }
}
