import SwiftUI

/// The app's named icons, drawn with SF Symbols.
///
/// Each case is an interface name (so a screen spec's `icon` column maps 1:1) and draws the
/// closest SF Symbol in a 24pt box. `*Small` icons are the same glyph at 2/3 scale
/// (16pt inside the 24pt box): use `AppGlyphView(.add, small: true)`.
enum AppGlyph: String, CaseIterable {
  case activity, add, addCircle, addCircleFilled, agent, agentSimple, agentsSimple, alarm, android, ant
  case apple, appleFilled, archive, arrowClockwise, arrowCounterClockwise, arrowDown, arrowDownCircle
  case arrowInSquare, arrowLeft, arrowLeftCircle, arrowOutSquare, arrowOutSquareAlt, arrowReturn
  case arrowRight, arrowRightCircle, arrowSplitRight, arrowUp, arrowUpCircle, arrowsUpDown, artifactFile
  case artifacts, asterix, atom, attachment, bank, binoculars, bluetooth, bluetoothSlash, book, bookText
  case bookmark, box, branch, browse, calendar, camera, cards, caretDown, caretLeft, caretRight, caretUp
  case caretUpCaretDown, chart, chartLine, chat, chatAdd, chatAddFilled, chatSimple, chats, check
  case checkCircle, checkCircleFilled, checklist, click, clipboard, clock, cloud, code, codeAlt, codeBlock
  case coffeeCup, collapse, commandLinePrompt, computer, connector, connectors, copy, create, database
  case disconnect, dispatch, dna, dollarSign, dotsCircle, dotsHorizontal, dotsVertical, download, edit
  case email, expand, experiment, extendedThinking, eye, eyeSlash, fastForward, feedback, file, fileAdd
  case fileUpload, files, filter, flag, folder, ghost, ghostFilled, gift, gitFork, github, globe
  case globeSmallAlt, goal, graduationCap, grid, hammer, hand, handHeart, haptics, heart, help, history
  case home, image, images, info, infoCircle, infoFilled, infoSmallFilled, key, keyboard, knowledge
  case laptop, laptopSlash, library, lightbulb, lightning, link, linkSimple, location, locationQuestionMark
  case locationSlash, lock, lockOpen, lockShield, lockShieldAlt, logout, mailbox, map, memory, mention
  case menu, microphone, microphoneSlash, minimizeBottomRight, minus, mobilePhone, moon, moonStars, note
  case notification, orbit, organization, owl, palette, paperPlane, pause, phone, pin, pinFilled, pinSlash
  case placeholder, play, playCircle, playCircleFilled, plugin, prClosed, prDraft, prMerged, prOpen
  case progressQuarter, projects, projectsX, prompt, reorder, research, scale, scroll, search
  case searchCircle, select, settings, shapes, share, shuffle, signPost, slides, speaker, speakerSlash
  case spinner, spreadsheet, star, starFilled, starSlash, starSmallFilled, stop, stopCircle, stopFilled
  case stopSmallFilled, sun, sunHorizon, tasks, team, textAa, thumbsDown, thumbsDownFilled, thumbsUp
  case thumbsUpFilled, timer, toggles, tool, trash, trust, upload, user, userCircle, users, voice
  case walkieTalkie, walkieTalkieFilled, warning, warningCircle, warningFilled, warningShield, wrench, x
  case xCircle, xCircleFilled

  /// The closest SF Symbol.
  var symbol: String {
    switch self {
    case .activity: "waveform.path.ecg"
    case .add: "plus"
    case .addCircle: "plus.circle"
    case .addCircleFilled: "plus.circle.fill"
    case .agent, .agentSimple: "person.crop.square"
    case .agentsSimple: "person.2.crop.square.stack"
    case .alarm: "alarm"
    case .android: "iphone.gen3"
    case .ant: "ant"
    case .apple: "apple.logo"
    case .appleFilled: "apple.logo"
    case .archive: "archivebox"
    case .arrowClockwise: "arrow.clockwise"
    case .arrowCounterClockwise: "arrow.counterclockwise"
    case .arrowDown: "arrow.down"
    case .arrowDownCircle: "arrow.down.circle"
    case .arrowInSquare: "square.and.arrow.down"
    case .arrowLeft: "arrow.left"
    case .arrowLeftCircle: "arrow.left.circle"
    case .arrowOutSquare, .arrowOutSquareAlt: "arrow.up.forward.square"
    case .arrowReturn: "arrow.turn.down.left"
    case .arrowRight: "arrow.right"
    case .arrowRightCircle: "arrow.right.circle"
    case .arrowSplitRight: "arrow.triangle.branch"
    case .arrowUp: "arrow.up"
    case .arrowUpCircle: "arrow.up.circle"
    case .arrowsUpDown: "arrow.up.arrow.down"
    case .artifactFile: "doc.richtext"
    case .artifacts: "square.on.square.dashed"
    case .asterix: "asterisk"
    case .atom: "atom"
    case .attachment: "paperclip"
    case .bank: "building.columns"
    case .binoculars: "binoculars"
    case .bluetooth: "dot.radiowaves.left.and.right"
    case .bluetoothSlash: "antenna.radiowaves.left.and.right.slash"
    case .book: "book"
    case .bookText: "book.pages"
    case .bookmark: "bookmark"
    case .box: "shippingbox"
    case .branch: "arrow.triangle.branch"
    case .browse: "safari"
    case .calendar: "calendar"
    case .camera: "camera"
    case .cards: "rectangle.on.rectangle"
    case .caretDown: "chevron.down"
    case .caretLeft: "chevron.left"
    case .caretRight: "chevron.right"
    case .caretUp: "chevron.up"
    case .caretUpCaretDown: "chevron.up.chevron.down"
    case .chart: "chart.bar"
    case .chartLine: "chart.line.uptrend.xyaxis"
    case .chat, .chatSimple: "bubble.left"
    case .chatAdd: "square.and.pencil"
    case .chatAddFilled: "square.and.pencil"
    case .chats: "bubble.left.and.bubble.right"
    case .check: "checkmark"
    case .checkCircle: "checkmark.circle"
    case .checkCircleFilled: "checkmark.circle.fill"
    case .checklist: "checklist"
    case .click: "cursorarrow.click"
    case .clipboard: "clipboard"
    case .clock: "clock"
    case .cloud: "cloud"
    case .code, .codeAlt: "chevron.left.forwardslash.chevron.right"
    case .codeBlock: "curlybraces.square"
    case .coffeeCup: "cup.and.saucer"
    case .collapse: "arrow.down.right.and.arrow.up.left"
    case .commandLinePrompt: "apple.terminal"
    case .computer: "desktopcomputer"
    case .connector, .connectors: "point.3.connected.trianglepath.dotted"
    case .copy: "doc.on.doc"
    case .create: "square.and.pencil"
    case .database: "cylinder.split.1x2"
    case .disconnect: "bolt.horizontal.circle"
    case .dispatch: "paperplane"
    case .dna: "allergens"
    case .dollarSign: "dollarsign.circle"
    case .dotsCircle: "ellipsis.circle"
    case .dotsHorizontal: "ellipsis"
    case .dotsVertical: "ellipsis"
    case .download: "arrow.down.to.line"
    case .edit: "pencil"
    case .email: "envelope"
    case .expand: "arrow.up.left.and.arrow.down.right"
    case .experiment: "flask"
    case .extendedThinking: "lightbulb.max"
    case .eye: "eye"
    case .eyeSlash: "eye.slash"
    case .fastForward: "forward"
    case .feedback: "exclamationmark.bubble"
    case .file: "doc"
    case .fileAdd: "doc.badge.plus"
    case .fileUpload: "doc.badge.arrow.up"
    case .files: "doc.on.doc"
    case .filter: "slider.horizontal.3"
    case .flag: "flag"
    case .folder: "folder"
    case .ghost: "eye.slash"
    case .ghostFilled: "eye.slash.fill"
    case .gift: "gift"
    case .gitFork: "arrow.triangle.branch"
    case .github: "chevron.left.forwardslash.chevron.right"
    case .globe, .globeSmallAlt: "globe"
    case .goal: "target"
    case .graduationCap: "graduationcap"
    case .grid: "square.grid.2x2"
    case .hammer: "hammer"
    case .hand: "hand.raised"
    case .handHeart: "hand.raised.square"
    case .haptics: "iphone.radiowaves.left.and.right"
    case .heart: "heart"
    case .help: "questionmark.circle"
    case .history: "clock.arrow.circlepath"
    case .home: "house"
    case .image: "photo"
    case .images: "photo.on.rectangle"
    case .info, .infoCircle: "info.circle"
    case .infoFilled, .infoSmallFilled: "info.circle.fill"
    case .key: "key"
    case .keyboard: "keyboard"
    case .knowledge: "books.vertical"
    case .laptop: "laptopcomputer"
    case .laptopSlash: "laptopcomputer.slash"
    case .library: "books.vertical"
    case .lightbulb: "lightbulb"
    case .lightning: "bolt"
    case .link, .linkSimple: "link"
    case .location: "location"
    case .locationQuestionMark: "location.magnifyingglass"
    case .locationSlash: "location.slash"
    case .lock: "lock"
    case .lockOpen: "lock.open"
    case .lockShield, .lockShieldAlt: "lock.shield"
    case .logout: "rectangle.portrait.and.arrow.right"
    case .mailbox: "tray"
    case .map: "map"
    case .memory: "brain"
    case .mention: "at"
    case .menu: "line.3.horizontal"
    case .microphone: "mic"
    case .microphoneSlash: "mic.slash"
    case .minimizeBottomRight: "arrow.down.right.and.arrow.up.left"
    case .minus: "minus"
    case .mobilePhone: "iphone"
    case .moon: "moon"
    case .moonStars: "moon.stars"
    case .note: "note.text"
    case .notification: "bell"
    case .orbit: "circle.dotted"
    case .organization: "building.2"
    case .owl: "moon.stars"
    case .palette: "paintpalette"
    case .paperPlane: "paperplane"
    case .pause: "pause"
    case .phone: "phone"
    case .pin: "pin"
    case .pinFilled: "pin.fill"
    case .pinSlash: "pin.slash"
    case .placeholder: "square.dashed"
    case .play: "play"
    case .playCircle: "play.circle"
    case .playCircleFilled: "play.circle.fill"
    case .plugin: "puzzlepiece.extension"
    case .prClosed: "xmark.circle"
    case .prDraft: "circle.dashed"
    case .prMerged: "arrow.triangle.merge"
    case .prOpen: "arrow.triangle.pull"
    case .progressQuarter: "circle.lefthalf.filled"
    case .projects: "folder"
    case .projectsX: "folder.badge.minus"
    case .prompt: "text.cursor"
    case .reorder: "line.3.horizontal"
    case .research: "doc.text.magnifyingglass"
    case .scale: "scalemass"
    case .scroll: "scroll"
    case .search: "magnifyingglass"
    case .searchCircle: "magnifyingglass.circle"
    case .select: "checkmark.circle"
    case .settings: "gearshape"
    case .shapes: "square.on.circle"
    case .share: "square.and.arrow.up"
    case .shuffle: "shuffle"
    case .signPost: "signpost.right"
    case .slides: "rectangle.on.rectangle.angled"
    case .speaker: "speaker.wave.2"
    case .speakerSlash: "speaker.slash"
    case .spinner: "rays"
    case .spreadsheet: "tablecells"
    case .star: "star"
    case .starFilled, .starSmallFilled: "star.fill"
    case .starSlash: "star.slash"
    case .stop: "stop"
    case .stopCircle: "stop.circle"
    case .stopFilled, .stopSmallFilled: "stop.fill"
    case .sun: "sun.max"
    case .sunHorizon: "sun.horizon"
    case .tasks: "checklist"
    case .team: "person.3"
    case .textAa: "textformat"
    case .thumbsDown: "hand.thumbsdown"
    case .thumbsDownFilled: "hand.thumbsdown.fill"
    case .thumbsUp: "hand.thumbsup"
    case .thumbsUpFilled: "hand.thumbsup.fill"
    case .timer: "timer"
    case .toggles: "switch.2"
    case .tool: "wrench.adjustable"
    case .trash: "trash"
    case .trust: "checkmark.shield"
    case .upload: "arrow.up.to.line"
    case .user: "person"
    case .userCircle: "person.crop.circle"
    case .users: "person.2"
    case .voice: "waveform"
    case .walkieTalkie: "flipphone"
    case .walkieTalkieFilled: "flipphone"
    case .warning: "exclamationmark.triangle"
    case .warningCircle: "exclamationmark.circle"
    case .warningFilled: "exclamationmark.triangle.fill"
    case .warningShield: "exclamationmark.shield"
    case .wrench: "wrench"
    case .x: "xmark"
    case .xCircle: "xmark.circle"
    case .xCircleFilled: "xmark.circle.fill"
    }
  }
  /// Official icons that mirror in right-to-left layouts.
  var autoMirrors: Bool {
    switch self {
    case .arrowDown, .arrowDownCircle, .arrowLeft, .arrowLeftCircle, .arrowOutSquare, .arrowOutSquareAlt,
      .arrowReturn, .arrowRight, .arrowRightCircle, .arrowSplitRight, .arrowUpCircle, .caretLeft, .caretRight:
      true
    default: false
    }
  }
  /// Vertical dots are drawn by rotating the horizontal ellipsis.
  var rotation: Angle { self == .dotsVertical ? .degrees(90) : .zero }
}

/// Draws an AppGlyph at the official 24pt box (or `size`), tinted with the foreground style.
struct AppGlyphView: View {
  let icon: AppGlyph
  var size: CGFloat = 24
  /// `*Small` variant: the glyph at 2/3 of the box.
  var small = false
  @Environment(\.layoutDirection) private var direction
  init(_ icon: AppGlyph, size: CGFloat = 24, small: Bool = false) {
    self.icon = icon
    self.size = size
    self.small = small
  }
  var body: some View {
    // SF Symbols draw their glyph at about 0.8 of the point size inside the same box.
    let glyph = size * (small ? 2.0 / 3.0 : 1) * 0.78
    Image(systemName: icon.symbol)
      .font(.system(size: glyph, weight: .regular))
      .rotationEffect(icon.rotation)
      .scaleEffect(x: icon.autoMirrors && direction == .rightToLeft ? -1 : 1, y: 1)
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}
