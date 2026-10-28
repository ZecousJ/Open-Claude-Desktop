package com.claudex.mobile

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.*
import androidx.compose.material.icons.automirrored.outlined.*
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The app's named icons, drawn with the Material Symbols the app already ships
 * (material-icons-extended). Every screen asks for an icon by name, so a swap is one file.
 * `*Small` icons are the same glyph drawn at 16 dp inside a 24 dp box: use [ClaudeIcon] with small = true.
 * Default tint is LocalContentColor; typical tints are Claude.colors.textTertiary / textSecondary / text300.
 */
object AppGlyphs {
    val activity: ImageVector get() = Icons.Outlined.Timeline
    val add: ImageVector get() = Icons.Outlined.Add
    val addCircle: ImageVector get() = Icons.Outlined.AddCircleOutline
    val addCircleFilled: ImageVector get() = Icons.Filled.AddCircle
    val agent: ImageVector get() = Icons.Outlined.SmartToy
    val agentSimple: ImageVector get() = Icons.Outlined.SmartToy
    val agentsSimple: ImageVector get() = Icons.Outlined.Groups
    val alarm: ImageVector get() = Icons.Outlined.Alarm
    val android: ImageVector get() = Icons.Outlined.Android
    val ant: ImageVector get() = Icons.Outlined.BugReport
    val apple: ImageVector get() = Icons.Outlined.PhoneIphone
    val appleFilled: ImageVector get() = Icons.Outlined.PhoneIphone
    val archive: ImageVector get() = Icons.Outlined.Archive
    val arrowClockwise: ImageVector get() = Icons.Outlined.Refresh
    val arrowCounterClockwise: ImageVector get() = Icons.AutoMirrored.Outlined.Undo
    val arrowDown: ImageVector get() = Icons.Outlined.ArrowDownward
    val arrowDownCircle: ImageVector get() = Icons.Outlined.ArrowCircleDown
    val arrowInSquare: ImageVector get() = Icons.AutoMirrored.Outlined.Input
    val arrowLeft: ImageVector get() = Icons.AutoMirrored.Outlined.ArrowBack
    val arrowLeftCircle: ImageVector get() = Icons.Outlined.ArrowCircleLeft
    val arrowOutSquare: ImageVector get() = Icons.AutoMirrored.Outlined.OpenInNew
    val arrowOutSquareAlt: ImageVector get() = Icons.AutoMirrored.Outlined.Launch
    val arrowReturn: ImageVector get() = Icons.AutoMirrored.Outlined.KeyboardReturn
    val arrowRight: ImageVector get() = Icons.AutoMirrored.Outlined.ArrowForward
    val arrowRightCircle: ImageVector get() = Icons.Outlined.ArrowCircleRight
    val arrowSplitRight: ImageVector get() = Icons.AutoMirrored.Outlined.CallSplit
    val arrowUp: ImageVector get() = Icons.Outlined.ArrowUpward
    val arrowUpCircle: ImageVector get() = Icons.Outlined.ArrowCircleUp
    val arrowsUpDown: ImageVector get() = Icons.Outlined.SwapVert
    val artifactFile: ImageVector get() = Icons.Outlined.Description
    val artifacts: ImageVector get() = Icons.Outlined.Inventory2
    val asterix: ImageVector get() = Icons.Outlined.Emergency
    val atom: ImageVector get() = Icons.Outlined.Science
    val attachment: ImageVector get() = Icons.Outlined.AttachFile
    val bank: ImageVector get() = Icons.Outlined.AccountBalance
    val binoculars: ImageVector get() = Icons.Outlined.TravelExplore
    val bluetooth: ImageVector get() = Icons.Outlined.Bluetooth
    val bluetoothSlash: ImageVector get() = Icons.Outlined.BluetoothDisabled
    val book: ImageVector get() = Icons.Outlined.Book
    val bookText: ImageVector get() = Icons.AutoMirrored.Outlined.MenuBook
    val bookmark: ImageVector get() = Icons.Outlined.BookmarkBorder
    val box: ImageVector get() = Icons.Outlined.Inventory
    val branch: ImageVector get() = Icons.AutoMirrored.Outlined.CallSplit
    val browse: ImageVector get() = Icons.Outlined.Explore
    val calendar: ImageVector get() = Icons.Outlined.CalendarToday
    val camera: ImageVector get() = Icons.Outlined.PhotoCamera
    val cards: ImageVector get() = Icons.Outlined.ViewAgenda
    val caretDown: ImageVector get() = Icons.Outlined.KeyboardArrowDown
    val caretLeft: ImageVector get() = Icons.AutoMirrored.Outlined.KeyboardArrowLeft
    val caretRight: ImageVector get() = Icons.AutoMirrored.Outlined.KeyboardArrowRight
    val caretUp: ImageVector get() = Icons.Outlined.KeyboardArrowUp
    val caretUpCaretDown: ImageVector get() = Icons.Outlined.UnfoldMore
    val chart: ImageVector get() = Icons.Outlined.BarChart
    val chartLine: ImageVector get() = Icons.AutoMirrored.Outlined.ShowChart
    val chat: ImageVector get() = Icons.Outlined.ChatBubbleOutline
    val chatAdd: ImageVector get() = Icons.Outlined.AddComment
    val chatAddFilled: ImageVector get() = Icons.Filled.AddComment
    val chatSimple: ImageVector get() = Icons.Outlined.ChatBubbleOutline
    val chats: ImageVector get() = Icons.Outlined.Forum
    val check: ImageVector get() = Icons.Outlined.Check
    val checkCircle: ImageVector get() = Icons.Outlined.CheckCircleOutline
    val checkCircleFilled: ImageVector get() = Icons.Filled.CheckCircle
    val checklist: ImageVector get() = Icons.Outlined.Checklist
    val click: ImageVector get() = Icons.Outlined.TouchApp
    val clipboard: ImageVector get() = Icons.Outlined.ContentPaste
    val clock: ImageVector get() = Icons.Outlined.Schedule
    val cloud: ImageVector get() = Icons.Outlined.Cloud
    val code: ImageVector get() = Icons.Outlined.Code
    val codeAlt: ImageVector get() = Icons.Outlined.DataObject
    val codeBlock: ImageVector get() = Icons.Outlined.Terminal
    val coffeeCup: ImageVector get() = Icons.Outlined.Coffee
    val collapse: ImageVector get() = Icons.Outlined.CloseFullscreen
    val commandLinePrompt: ImageVector get() = Icons.Outlined.Terminal
    val computer: ImageVector get() = Icons.Outlined.Computer
    val connector: ImageVector get() = Icons.Outlined.Cable
    val connectors: ImageVector get() = Icons.Outlined.Hub
    val copy: ImageVector get() = Icons.Outlined.ContentCopy
    val create: ImageVector get() = Icons.Outlined.Create
    val database: ImageVector get() = Icons.Outlined.Storage
    val disconnect: ImageVector get() = Icons.Outlined.LinkOff
    val dispatch: ImageVector get() = Icons.AutoMirrored.Outlined.SendToMobile
    val dna: ImageVector get() = Icons.Outlined.Biotech
    val dollarSign: ImageVector get() = Icons.Outlined.AttachMoney
    val dotsCircle: ImageVector get() = Icons.Outlined.Pending
    val dotsHorizontal: ImageVector get() = Icons.Outlined.MoreHoriz
    val dotsVertical: ImageVector get() = Icons.Outlined.MoreVert
    val download: ImageVector get() = Icons.Outlined.Download
    val edit: ImageVector get() = Icons.Outlined.Edit
    val email: ImageVector get() = Icons.Outlined.MailOutline
    val expand: ImageVector get() = Icons.Outlined.OpenInFull
    val experiment: ImageVector get() = Icons.Outlined.Science
    val extendedThinking: ImageVector get() = Icons.Outlined.Psychology
    val eye: ImageVector get() = Icons.Outlined.Visibility
    val eyeSlash: ImageVector get() = Icons.Outlined.VisibilityOff
    val fastForward: ImageVector get() = Icons.Outlined.FastForward
    val feedback: ImageVector get() = Icons.Outlined.Feedback
    val file: ImageVector get() = Icons.Outlined.Description
    val fileAdd: ImageVector get() = Icons.AutoMirrored.Outlined.NoteAdd
    val fileUpload: ImageVector get() = Icons.Outlined.UploadFile
    val files: ImageVector get() = Icons.Outlined.FileCopy
    val filter: ImageVector get() = Icons.Outlined.Tune
    val flag: ImageVector get() = Icons.Outlined.Flag
    val folder: ImageVector get() = Icons.Outlined.Folder
    val ghost: ImageVector get() = Icons.Outlined.VisibilityOff
    val ghostFilled: ImageVector get() = Icons.Filled.VisibilityOff
    val gift: ImageVector get() = Icons.Outlined.CardGiftcard
    val gitFork: ImageVector get() = Icons.Outlined.ForkRight
    val github: ImageVector get() = Icons.Outlined.Code
    val globe: ImageVector get() = Icons.Outlined.Language
    val globeSmallAlt: ImageVector get() = Icons.Outlined.Public
    val goal: ImageVector get() = Icons.Outlined.Flag
    val graduationCap: ImageVector get() = Icons.Outlined.School
    val grid: ImageVector get() = Icons.Outlined.GridView
    val hammer: ImageVector get() = Icons.Outlined.Construction
    val hand: ImageVector get() = Icons.Outlined.PanTool
    val handHeart: ImageVector get() = Icons.Outlined.VolunteerActivism
    val haptics: ImageVector get() = Icons.Outlined.Vibration
    val heart: ImageVector get() = Icons.Outlined.FavoriteBorder
    val help: ImageVector get() = Icons.AutoMirrored.Outlined.HelpOutline
    val history: ImageVector get() = Icons.Outlined.History
    val home: ImageVector get() = Icons.Outlined.Home
    val image: ImageVector get() = Icons.Outlined.Image
    val images: ImageVector get() = Icons.Outlined.PhotoLibrary
    val info: ImageVector get() = Icons.Outlined.Info
    val infoCircle: ImageVector get() = Icons.Outlined.Info
    val infoFilled: ImageVector get() = Icons.Filled.Info
    val infoSmallFilled: ImageVector get() = Icons.Filled.Info
    val key: ImageVector get() = Icons.Outlined.Key
    val keyboard: ImageVector get() = Icons.Outlined.Keyboard
    val knowledge: ImageVector get() = Icons.AutoMirrored.Outlined.LibraryBooks
    val laptop: ImageVector get() = Icons.Outlined.Laptop
    val laptopSlash: ImageVector get() = Icons.Outlined.DesktopAccessDisabled
    val library: ImageVector get() = Icons.Outlined.LocalLibrary
    val lightbulb: ImageVector get() = Icons.Outlined.Lightbulb
    val lightning: ImageVector get() = Icons.Outlined.Bolt
    val link: ImageVector get() = Icons.Outlined.Link
    val linkSimple: ImageVector get() = Icons.Outlined.Link
    val location: ImageVector get() = Icons.Outlined.LocationOn
    val locationQuestionMark: ImageVector get() = Icons.AutoMirrored.Outlined.NotListedLocation
    val locationSlash: ImageVector get() = Icons.Outlined.LocationOff
    val lock: ImageVector get() = Icons.Outlined.Lock
    val lockOpen: ImageVector get() = Icons.Outlined.LockOpen
    val lockShield: ImageVector get() = Icons.Outlined.Shield
    val lockShieldAlt: ImageVector get() = Icons.Outlined.Security
    val logout: ImageVector get() = Icons.AutoMirrored.Outlined.Logout
    val mailbox: ImageVector get() = Icons.Outlined.Inbox
    val map: ImageVector get() = Icons.Outlined.Map
    val memory: ImageVector get() = Icons.Outlined.Psychology
    val mention: ImageVector get() = Icons.Outlined.AlternateEmail
    val menu: ImageVector get() = Icons.Outlined.Menu
    val microphone: ImageVector get() = Icons.Outlined.Mic
    val microphoneSlash: ImageVector get() = Icons.Outlined.MicOff
    val minimizeBottomRight: ImageVector get() = Icons.Outlined.CloseFullscreen
    val minus: ImageVector get() = Icons.Outlined.Remove
    val mobilePhone: ImageVector get() = Icons.Outlined.Smartphone
    val moon: ImageVector get() = Icons.Outlined.DarkMode
    val moonStars: ImageVector get() = Icons.Outlined.Bedtime
    val note: ImageVector get() = Icons.AutoMirrored.Outlined.StickyNote2
    val printer: ImageVector get() = Icons.Outlined.Print
    val notification: ImageVector get() = Icons.Outlined.Notifications
    val orbit: ImageVector get() = Icons.Outlined.Explore
    val organization: ImageVector get() = Icons.Outlined.Business
    val owl: ImageVector get() = Icons.Outlined.Pets
    val palette: ImageVector get() = Icons.Outlined.Palette
    val paperPlane: ImageVector get() = Icons.AutoMirrored.Outlined.Send
    val pause: ImageVector get() = Icons.Outlined.Pause
    val phone: ImageVector get() = Icons.Outlined.Phone
    val pin: ImageVector get() = Icons.Outlined.PushPin
    val pinFilled: ImageVector get() = Icons.Filled.PushPin
    val pinSlash: ImageVector get() = Icons.Outlined.PushPin
    val placeholder: ImageVector get() = Icons.Outlined.CropSquare
    val play: ImageVector get() = Icons.Outlined.PlayArrow
    val playCircle: ImageVector get() = Icons.Outlined.PlayCircleOutline
    val playCircleFilled: ImageVector get() = Icons.Filled.PlayCircle
    val plugin: ImageVector get() = Icons.Outlined.Extension
    val prClosed: ImageVector get() = Icons.Outlined.Cancel
    val prDraft: ImageVector get() = Icons.Outlined.EditNote
    val prMerged: ImageVector get() = Icons.AutoMirrored.Outlined.MergeType
    val prOpen: ImageVector get() = Icons.AutoMirrored.Outlined.CallSplit
    val progressQuarter: ImageVector get() = Icons.Outlined.Pending
    val projects: ImageVector get() = Icons.Outlined.FolderOpen
    val projectsX: ImageVector get() = Icons.Outlined.FolderOff
    val prompt: ImageVector get() = Icons.Outlined.Terminal
    val reorder: ImageVector get() = Icons.Outlined.Reorder
    val research: ImageVector get() = Icons.Outlined.TravelExplore
    val scale: ImageVector get() = Icons.Outlined.Scale
    val scroll: ImageVector get() = Icons.AutoMirrored.Outlined.Article
    val search: ImageVector get() = Icons.Outlined.Search
    val searchCircle: ImageVector get() = Icons.Outlined.Search
    val select: ImageVector get() = Icons.Outlined.Checklist
    val settings: ImageVector get() = Icons.Outlined.Settings
    val shapes: ImageVector get() = Icons.Outlined.Category
    val share: ImageVector get() = Icons.Outlined.Share
    val shuffle: ImageVector get() = Icons.Outlined.Shuffle
    val signPost: ImageVector get() = Icons.Outlined.Signpost
    val slides: ImageVector get() = Icons.Outlined.Slideshow
    val speaker: ImageVector get() = Icons.AutoMirrored.Outlined.VolumeUp
    val speakerSlash: ImageVector get() = Icons.AutoMirrored.Outlined.VolumeOff
    val spinner: ImageVector get() = Icons.Outlined.Autorenew
    val spreadsheet: ImageVector get() = Icons.Outlined.TableChart
    val star: ImageVector get() = Icons.Outlined.StarBorder
    val starFilled: ImageVector get() = Icons.Filled.Star
    val starSlash: ImageVector get() = Icons.Outlined.StarOutline
    val starSmallFilled: ImageVector get() = Icons.Filled.Star
    val stop: ImageVector get() = Icons.Outlined.Stop
    val stopCircle: ImageVector get() = Icons.Outlined.StopCircle
    val stopFilled: ImageVector get() = Icons.Filled.Stop
    val stopSmallFilled: ImageVector get() = Icons.Filled.Stop
    val sun: ImageVector get() = Icons.Outlined.LightMode
    val sunHorizon: ImageVector get() = Icons.Outlined.WbTwilight
    val tasks: ImageVector get() = Icons.Outlined.TaskAlt
    val team: ImageVector get() = Icons.Outlined.Groups
    val textAa: ImageVector get() = Icons.Outlined.TextFields
    val thumbsDown: ImageVector get() = Icons.Outlined.ThumbDown
    val thumbsDownFilled: ImageVector get() = Icons.Filled.ThumbDown
    val thumbsUp: ImageVector get() = Icons.Outlined.ThumbUp
    val thumbsUpFilled: ImageVector get() = Icons.Filled.ThumbUp
    val timer: ImageVector get() = Icons.Outlined.Timer
    val toggles: ImageVector get() = Icons.Outlined.ToggleOn
    val tool: ImageVector get() = Icons.Outlined.Build
    val trash: ImageVector get() = Icons.Outlined.DeleteOutline
    val trust: ImageVector get() = Icons.Outlined.VerifiedUser
    val upload: ImageVector get() = Icons.Outlined.Upload
    val user: ImageVector get() = Icons.Outlined.PersonOutline
    val userCircle: ImageVector get() = Icons.Outlined.AccountCircle
    val users: ImageVector get() = Icons.Outlined.PeopleOutline
    val voice: ImageVector get() = Icons.Outlined.GraphicEq
    val walkieTalkie: ImageVector get() = Icons.Outlined.SettingsVoice
    val walkieTalkieFilled: ImageVector get() = Icons.Filled.SettingsVoice
    val warning: ImageVector get() = Icons.Outlined.WarningAmber
    val warningCircle: ImageVector get() = Icons.Outlined.ErrorOutline
    val warningFilled: ImageVector get() = Icons.Filled.Warning
    val warningShield: ImageVector get() = Icons.Outlined.GppMaybe
    val wrench: ImageVector get() = Icons.Outlined.Build
    val x: ImageVector get() = Icons.Outlined.Close
    val xCircle: ImageVector get() = Icons.Outlined.HighlightOff
    val xCircleFilled: ImageVector get() = Icons.Filled.Cancel
}

/** An AppGlyph at its intrinsic 24 dp, or a `*Small` variant (16 dp glyph centred in 24 dp). */
@Composable fun ClaudeIcon(icon: ImageVector, contentDescription: String?, modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current, size: Dp = 24.dp, small: Boolean = false) {
    if (!small) Icon(icon, contentDescription, modifier.size(size), tint = tint)
    else Box(modifier.size(size), contentAlignment = Alignment.Center) { Icon(icon, contentDescription, Modifier.size(size * 0.6666667f), tint = tint) }
}
