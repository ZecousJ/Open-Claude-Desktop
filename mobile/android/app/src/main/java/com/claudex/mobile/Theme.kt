package com.claudex.mobile

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/*
 * The Claudex theme: colour, type, shape, spacing and motion tokens.
 *
 * Use it through [Claude]: `Claude.colors.text100`, `Claude.type.body15`,
 * `Claude.shapes.card`, `ClaudeSpacing.s16`, `ClaudeMotion.easeOut`.
 * Stock Material3 components read the mapped ColorScheme / Typography below.
 */

private fun hex(value: Long) = Color(value)
private fun hexA(rgb: Long, alpha: Float) = Color(rgb or 0xFF000000).copy(alpha = alpha)

/** Semantic palette: core tokens (zc6) and Cds tokens (g74) as one set. */
@Immutable class ClaudeColors(
    val isDark: Boolean,
    // ── Core tokens ──
    /** zc6.c accent-brand (clay). */ val accentBrand: Color,
    /** zc6.d accent-main-000; M3 primaryContainer. */ val accentMain000: Color,
    /** zc6.e accent-main-100; M3 primary, spinner, "New" badge text. */ val accentMain100: Color,
    /** zc6.f accent-main-200. */ val accentMain200: Color,
    /** zc6.h–k accent-pro (purple). */ val accentPro000: Color, val accentPro100: Color, val accentPro200: Color, val accentPro900: Color,
    /** zc6.l–o accent-secondary (blue); m = "Tinted" button text, n = links. */ val accentSecondary000: Color, val accentSecondary100: Color, val accentSecondary200: Color, val accentSecondary900: Color,
    /** zc6.p bg-000; M3 surface; cards, raised surfaces, text fields. */ val bg000: Color,
    /** zc6.q bg-100; page/window background, bottom-sheet container. */ val bg100: Color,
    /** zc6.r bg-200; navigation drawer background. */ val bg200: Color,
    /** zc6.s bg-300; secondaryContainer, pressed Secondary button, neutral notices. */ val bg300: Color,
    /** zc6.t bg-400. */ val bg400: Color,
    /** zc6.u bg-500. */ val bg500: Color,
    /** zc6.v border-100 (40 %). */ val border100: Color,
    /** zc6.w border-200 (30 %); spinner track, snackbar border. */ val border200: Color,
    /** zc6.x border-300 (15 %); default hairline, sheet handle, chip border, M3 outline. */ val border300: Color,
    /** zc6.y border-400 (15 %); "OR" divider. */ val border400: Color,
    /** zc6.z–C danger. z = error text, A = destructive row, C = error card fill. */ val danger000: Color, val danger100: Color, val danger200: Color, val danger900: Color,
    /** zc6.D–G success. */ val success000: Color, val success100: Color, val success200: Color, val success900: Color,
    /** zc6.H on-color (white). */ val onColor100: Color,
    /** zc6.I disabled label on filled buttons. */ val onColor200: Color,
    /** zc6.J. */ val onColor300: Color,
    /** zc6.O text-100; primary text, LocalContentColor. */ val text100: Color,
    /** zc6.P text-300; secondary text, drawer content, section headers. */ val text300: Color,
    /** zc6.Q text-500; tertiary text, placeholders, menu icons, subtitles. */ val text500: Color,
    /** zc6.S/T warning. */ val warning: Color, val warningBg: Color,
    // ── Component surfaces ──
    /** zc6.x0 clickable tile fill. */ val tileFill: Color,
    /** zc6.z0 / A0 NoticeCta button fill / border. */ val noticeCtaFill: Color, val noticeCtaBorder: Color,
    /** zc6.B0 quote bar / NoticeCta pressed overlay. */ val quoteBar: Color,
    /** zc6.C0 switch track (off). */ val switchTrackOff: Color,
    /** zc6.D0 drawer selected row. */ val drawerSelected: Color,
    /** zc6.G0 / H0 pill toast fill / border. */ val pillToastFill: Color, val pillToastBorder: Color,
    /** zc6.J0 subtle container fill (8 dp). */ val subtleFill: Color,
    // ── Cds tokens ──
    /** g74.o0() text-primary: row titles, dialog titles, sheet actions. */ val textPrimary: Color,
    /** g74.r0() text-secondary: dialog body, sheet-action icons. */ val textSecondary: Color,
    /** g74.v() text-tertiary / muted icon. */ val textTertiary: Color,
    /** g74.w0() link / info (blue); selected option text in pickers. */ val link: Color,
    /** g74.x() border-default (10 %). */ val borderDefault: Color,
    /** g74.J() border-strong / disabled (35 %). */ val borderStrong: Color,
    /** g74.r() danger text. */ val dangerText: Color,
    /** g74.G() success text. */ val successText: Color,
    /** g74.j() warning text. */ val warningText: Color,
    /** g74.L() fill-subtle 5 % (pressed rows, chips). */ val fillSubtle: Color,
    /** g74.u() 10 % fill (avatar surplus). */ val fill10: Color,
    /** g74.M() 20 % fill. */ val fill20: Color,
    /** g74.y() 40 % fill. */ val fill40: Color,
    /** g74.K() surface-sunken (search field fill). */ val surfaceSunken: Color,
    /** g74.T() surface-secondary. */ val surfaceSecondary: Color,
    /** g74.A0() surface-raised. */ val surfaceRaised: Color,
    /** g74.B() dialog / popup surface. */ val dialogSurface: Color,
    /** g74.z0() dialog window dim (alpha 0.40 light / 0.50 dark). */ val dialogScrim: Color,
    /** g74.c() accent blue: switch on, checkbox fill. */ val accentBlue: Color,
    /** g74.E() accent blue 10 %. */ val accentBlueTint: Color,
    /** g74.t0() check glyph. */ val checkGlyph: Color,
    // Buttons
    /** g74.e0 / m0 / j0 Primary button fill, pressed fill, content. */ val primaryFill: Color, val primaryFillPressed: Color, val primaryContent: Color,
    /** g74.q0 / X / b Brand button. */ val brandFill: Color, val brandFillPressed: Color, val onBrand: Color,
    /** g74.D / n0 / W Destructive button. */ val destructiveFill: Color, val destructiveFillPressed: Color, val destructiveContent: Color,
    /** gex.i disabled fill of filled buttons. */ val buttonDisabledFill: Color,
    /** od3.d disabled label of outlined buttons (#87867F). */ val outlinedDisabledContent: Color,
    /** g74.C0() borderless pressed fill. */ val borderlessPressed: Color,
    /** Category hues: gray, red, orange, yellow, green, teal, blue, purple, pink. */ val categories: List<Color>,
    /** Category "text-on-tint", same order. */ val categoryText: List<Color>,
) {
    /** Literal clay used for `claudeClay` annotation spans (both themes). */
    val clay: Color get() = Color(0xFFD97757)
}

val LightClaudeColors = ClaudeColors(
    isDark = false,
    accentBrand = hex(0xFFD97757), accentMain000 = hex(0xFFC6613F), accentMain100 = hex(0xFFC6613F), accentMain200 = hex(0xFFD97757),
    accentPro000 = hex(0xFF4A3AA7), accentPro100 = hex(0xFF7161E0), accentPro200 = hex(0xFF7161E0), accentPro900 = hex(0xFFDFDBFD),
    accentSecondary000 = hex(0xFF184F95), accentSecondary100 = hex(0xFF256ABF), accentSecondary200 = hex(0xFF256ABF), accentSecondary900 = hex(0xFFCDE2FB),
    bg000 = hex(0xFFFFFFFF), bg100 = hex(0xFFF9F9F7), bg200 = hex(0xFFF3F3F0), bg300 = hex(0xFFF0EFEC), bg400 = hex(0xFFE7E6E1), bg500 = hex(0xFFE7E6E1),
    border100 = hexA(0x1E1E1D, .40f), border200 = hexA(0x1E1E1D, .30f), border300 = hexA(0x1E1E1D, .15f), border400 = hexA(0x1E1E1D, .15f),
    danger000 = hex(0xFF8E2626), danger100 = hex(0xFFD03B3B), danger200 = hex(0xFFD03B3B), danger900 = hex(0xFFFAD6D6),
    success000 = hex(0xFF006300), success100 = hex(0xFF009300), success200 = hex(0xFF009300), success900 = hex(0xFFCAEAC7),
    onColor100 = hex(0xFFFFFFFF), onColor200 = hexA(0xF9F9F7, .75f), onColor300 = hexA(0xF9F9F7, .50f),
    text100 = hex(0xFF131313), text300 = hex(0xFF383835), text500 = hex(0xFF7B7974),
    warning = hex(0xFFA66A00), warningBg = hex(0xFFF9DCA4),
    tileFill = hex(0xFFF0EFEC), noticeCtaFill = hex(0xFFF9F9F7), noticeCtaBorder = hexA(0x1E1E1D, .15f), quoteBar = hexA(0x0B0B0B, .10f),
    switchTrackOff = hexA(0x0B0B0B, .20f), drawerSelected = hex(0xFFF0EFEC), pillToastFill = hex(0xFFF3F3F0), pillToastBorder = hexA(0x1E1E1D, .30f),
    subtleFill = hex(0xFFFCFCFB),
    textPrimary = hex(0xFF0B0B0B), textSecondary = hex(0xFF52514E), textTertiary = hex(0xFF898781), link = hex(0xFF184F95),
    borderDefault = hexA(0x0B0B0B, .102f), borderStrong = hexA(0x0B0B0B, .349f), dangerText = hex(0xFF8E2626), successText = hex(0xFF006300), warningText = hex(0xFF734500),
    fillSubtle = hexA(0x0B0B0B, .051f), fill10 = hexA(0x0B0B0B, .102f), fill20 = hexA(0x0B0B0B, .200f), fill40 = hexA(0x0B0B0B, .400f),
    surfaceSunken = hex(0xFFF9F9F7), surfaceSecondary = hex(0xFFFCFCFB), surfaceRaised = hex(0xFFFFFFFF), dialogSurface = hex(0xFFFFFFFF), dialogScrim = hexA(0x000000, .40f),
    accentBlue = hex(0xFF2A78D6), accentBlueTint = hexA(0x2A78D6, .102f), checkGlyph = hex(0xFFFFFFFF),
    primaryFill = hex(0xFF0B0B0B), primaryFillPressed = hex(0xFF2C2C2A), primaryContent = hex(0xFFFFFFFF),
    brandFill = hex(0xFFC6613F), brandFillPressed = hex(0xFFD97757), onBrand = hex(0xFFFFFFFF),
    destructiveFill = hex(0xFFD03B3B), destructiveFillPressed = hex(0xFFE34948), destructiveContent = hex(0xFFFFFFFF),
    buttonDisabledFill = hex(0xFF9C9A92), outlinedDisabledContent = hex(0xFF87867F), borderlessPressed = hexA(0x0B0B0B, .051f),
    categories = listOf(0xFF7B7974, 0xFFD03B3B, 0xFFC25124, 0xFFA66A00, 0xFF009300, 0xFF138E65, 0xFF2A78D6, 0xFF7161E0, 0xFFC04873).map(::hex),
    categoryText = listOf(0xFF52514E, 0xFF8E2626, 0xFF863311, 0xFF734500, 0xFF006300, 0xFF065F49, 0xFF184F95, 0xFF4A3AA7, 0xFF862A4C).map(::hex),
)

val DarkClaudeColors = ClaudeColors(
    isDark = true,
    accentBrand = hex(0xFFD97757), accentMain000 = hex(0xFFC6613F), accentMain100 = hex(0xFFD97757), accentMain200 = hex(0xFFD97757),
    accentPro000 = hex(0xFFBFB9F5), accentPro100 = hex(0xFF9085E9), accentPro200 = hex(0xFF8173E3), accentPro900 = hex(0xFF271E60),
    accentSecondary000 = hex(0xFF9EC5F4), accentSecondary100 = hex(0xFF5598E7), accentSecondary200 = hex(0xFF5598E7), accentSecondary900 = hex(0xFF062B57),
    bg000 = hex(0xFF20201F), bg100 = hex(0xFF151515), bg200 = hex(0xFF111111), bg300 = hex(0xFF0D0D0D), bg400 = hex(0xFF0B0B0B), bg500 = hex(0xFF0B0B0B),
    border100 = hexA(0xE1E0D9, .40f), border200 = hexA(0xE1E0D9, .30f), border300 = hexA(0xE1E0D9, .15f), border400 = hexA(0xE1E0D9, .15f),
    danger000 = hex(0xFFF4ABAB), danger100 = hex(0xFFE66767), danger200 = hex(0xFFE34948), danger900 = hex(0xFF511212),
    success000 = hex(0xFF91D68B), success100 = hex(0xFF0CA30C), success200 = hex(0xFF0CA30C), success900 = hex(0xFF0F350D),
    onColor100 = hex(0xFFFFFFFF), onColor200 = hexA(0xF9F9F7, .75f), onColor300 = hexA(0xF9F9F7, .50f),
    text100 = hex(0xFFF9F9F7), text300 = hex(0xFFC3C2B7), text500 = hex(0xFF97958D),
    warning = hex(0xFFB77700), warningBg = hex(0xFF412400),
    tileFill = hexA(0xFFFFFF, .08f), noticeCtaFill = hexA(0xFFFFFF, .10f), noticeCtaBorder = Color.Transparent, quoteBar = hexA(0xFFFFFF, .10f),
    switchTrackOff = hexA(0xFFFFFF, .10f), drawerSelected = hex(0xFF414141), pillToastFill = hexA(0xFFFFFF, .10f), pillToastBorder = Color.Transparent,
    subtleFill = hexA(0xFFFFFF, .10f),
    textPrimary = hex(0xFFF0EFEC), textSecondary = hex(0xFFC3C2B7), textTertiary = hex(0xFF898781), link = hex(0xFF6DA7EC),
    borderDefault = hexA(0xFFFFFF, .102f), borderStrong = hexA(0xFFFFFF, .349f), dangerText = hex(0xFFEC7E7E), successText = hex(0xFF0CA30C), warningText = hex(0xFFDB9300),
    fillSubtle = hexA(0xFFFFFF, .051f), fill10 = hexA(0xFFFFFF, .102f), fill20 = hexA(0xFFFFFF, .200f), fill40 = hexA(0xFFFFFF, .400f),
    surfaceSunken = hex(0xFF0B0B0B), surfaceSecondary = hex(0xFF151515), surfaceRaised = hex(0xFF1A1A19), dialogSurface = hex(0xFF20201F), dialogScrim = hexA(0x000000, .50f),
    accentBlue = hex(0xFF2A78D6), accentBlueTint = hexA(0x2A78D6, .102f), checkGlyph = hex(0xFFFFFFFF),
    primaryFill = hex(0xFFFFFFFF), primaryFillPressed = hex(0xFFE1E0D9), primaryContent = hex(0xFF0B0B0B),
    brandFill = hex(0xFFC6613F), brandFillPressed = hex(0xFFD97757), onBrand = hex(0xFFFFFFFF),
    destructiveFill = hex(0xFFD03B3B), destructiveFillPressed = hex(0xFFE34948), destructiveContent = hex(0xFFFFFFFF),
    buttonDisabledFill = hex(0xFF5E5D59), outlinedDisabledContent = hex(0xFF87867F), borderlessPressed = hexA(0xFFFFFF, .075f),
    categories = listOf(0xFF97958D, 0xFFE66767, 0xFFEB6834, 0xFFC98500, 0xFF35B231, 0xFF1BAF7A, 0xFF5598E7, 0xFF9085E9, 0xFFE46191).map(::hex),
    categoryText = listOf(0xFF898781, 0xFFE34948, 0xFFD95926, 0xFFB77700, 0xFF0CA30C, 0xFF199E70, 0xFF3987E5, 0xFF8173E3, 0xFFD55181).map(::hex),
)

/** Font families: the system sans, the system serif (Noto Serif / Noto Serif CJK on Android) and the
 *  system monospace. */
object ClaudeFonts {
    val sans: FontFamily = FontFamily.Default
    val serif: FontFamily = FontFamily.Serif
    val mono: FontFamily = FontFamily.Monospace
}

/** Weight 550, between Medium and SemiBold. */
val FontWeightEmphasis = FontWeight(550)

private val trimNone = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)
private fun style(family: FontFamily, size: Int, weight: FontWeight, lineHeight: Float) =
    TextStyle(fontFamily = family, fontSize = size.sp, fontWeight = weight, lineHeight = lineHeight.em,
        lineHeightStyle = trimNone, textDirection = TextDirection.Content)

/** UI type scale and reading scale. */
@Immutable class ClaudeType(
    /** je6.v Serif 28/400 — large serif heading. */ val serif28: TextStyle = style(ClaudeFonts.serif, 28, FontWeight.Normal, 1.3f),
    /** je6.w Serif 22/400 — home greeting. */ val greeting: TextStyle = style(ClaudeFonts.serif, 22, FontWeight.Normal, 1.3f),
    /** je6.x Serif 28/500 — screen titles, onboarding titles. */ val screenTitle: TextStyle = style(ClaudeFonts.serif, 28, FontWeight.Medium, 1.3f),
    /** je6.y Serif 34/550 — hero. */ val hero: TextStyle = style(ClaudeFonts.serif, 34, FontWeightEmphasis, 1.3f),
    /** je6.z Serif 17/550 — top-bar titles (M3 titleLarge/headlineSmall). */ val topBarTitle: TextStyle = style(ClaudeFonts.serif, 17, FontWeightEmphasis, 1.3f),
    /** je6.A Sans 20/500 — dialog title. */ val dialogTitle: TextStyle = style(ClaudeFonts.sans, 20, FontWeight.Medium, 1.4f),
    /** je6.B Sans 17/400 — body large, settings row title. */ val body17: TextStyle = style(ClaudeFonts.sans, 17, FontWeight.Normal, 1.4f),
    /** je6.C Sans 17/550 — emphasis; Medium/Large button label. */ val body17Strong: TextStyle = style(ClaudeFonts.sans, 17, FontWeightEmphasis, 1.4f),
    /** je6.D Sans 17/400 lh 1.6. */ val body17Long: TextStyle = style(ClaudeFonts.sans, 17, FontWeight.Normal, 1.6f),
    /** je6.E Sans 15/400 — default body: rows, sheet actions, menus, dialog body. */ val body15: TextStyle = style(ClaudeFonts.sans, 15, FontWeight.Normal, 1.4f),
    /** je6.F Sans 15/550 — Small button label, chips, section headers. */ val body15Strong: TextStyle = style(ClaudeFonts.sans, 15, FontWeightEmphasis, 1.4f),
    /** je6.G Sans 15/500 lh 1.6. */ val body15Long: TextStyle = style(ClaudeFonts.sans, 15, FontWeight.Medium, 1.6f),
    /** je6.H Sans 13/400 — captions, snackbar message. */ val body13: TextStyle = style(ClaudeFonts.sans, 13, FontWeight.Normal, 1.4f),
    /** je6.I Sans 13/550 — caption emphasis, snackbar title, badges. */ val body13Strong: TextStyle = style(ClaudeFonts.sans, 13, FontWeightEmphasis, 1.4f),
    /** je6.J Sans 13/400 lh 1.6. */ val body13Long: TextStyle = style(ClaudeFonts.sans, 13, FontWeight.Normal, 1.6f),
    /** je6.K Sans 11/400 — micro labels. */ val body11: TextStyle = style(ClaudeFonts.sans, 11, FontWeight.Normal, 1.5f),
    /** je6.L Sans 11/550 — badges. */ val body11Strong: TextStyle = style(ClaudeFonts.sans, 11, FontWeightEmphasis, 1.5f),
    // Reading scale (prose = serif by default, code = mono)
    /** wt.a H1 28/550. */ val readingH1: TextStyle = style(ClaudeFonts.serif, 28, FontWeightEmphasis, 1.3f),
    /** wt.b H2 24/550. */ val readingH2: TextStyle = style(ClaudeFonts.serif, 24, FontWeightEmphasis, 1.3f),
    /** wt.c H3 20/550. */ val readingH3: TextStyle = style(ClaudeFonts.serif, 20, FontWeightEmphasis, 1.3f),
    /** wt.d message paragraph 17/400 lh 1.5; onboarding subtitles. */ val readingBody: TextStyle = style(ClaudeFonts.serif, 17, FontWeight.Normal, 1.5f),
    /** wt.e bold paragraph / H4. */ val readingBodyStrong: TextStyle = style(ClaudeFonts.serif, 17, FontWeightEmphasis, 1.5f),
    /** wt.f compact paragraph 15/400 lh 1.6. */ val readingCompact: TextStyle = style(ClaudeFonts.serif, 15, FontWeight.Normal, 1.6f),
    /** wt.g 15/550. */ val readingCompactStrong: TextStyle = style(ClaudeFonts.serif, 15, FontWeightEmphasis, 1.6f),
    /** wt.h mono 15. */ val codeLarge: TextStyle = style(ClaudeFonts.mono, 15, FontWeight.Normal, 1.5f).copy(textDirection = TextDirection.Ltr),
    /** wt.i mono 13 — code block / inline code. */ val code: TextStyle = style(ClaudeFonts.mono, 13, FontWeight.Normal, 1.5f).copy(textDirection = TextDirection.Ltr),
)

/** Shape tokens. */
@Immutable class ClaudeShapes {
    val r2 = RoundedCornerShape(2.dp); val r4 = RoundedCornerShape(4.dp); val r6 = RoundedCornerShape(6.dp)
    val r7 = RoundedCornerShape(7.dp); val r8 = RoundedCornerShape(8.dp); val r9 = RoundedCornerShape(9.dp)
    val r10 = RoundedCornerShape(10.dp); val r12 = RoundedCornerShape(12.dp); val r14 = RoundedCornerShape(14.dp)
    val r16 = RoundedCornerShape(16.dp); val r20 = RoundedCornerShape(20.dp); val r24 = RoundedCornerShape(24.dp)
    val r48 = RoundedCornerShape(48.dp)
    /** kio.a 50 % — buttons, avatars, search field, drag handle. */ val pill = CircleShape
    /** g3r.b bottom sheet: top corners 44 dp. */ val sheet = RoundedCornerShape(topStart = 44.dp, topEnd = 44.dp)
    /** ce6.o dialog. */ val dialog = r12
    /** ce6.f menu item. */ val menuItem = r12
    /** ce6.h list/card rows, settings group. */ val card = r16
    /** ce6.g error snackbar, model chip. */ val snackbar = r14
    /** ce6.e drawer conversation row. */ val drawerRow = r10
    /** ce6.u text field (login email). */ val field = r12
    /** ce6.a settings row inner corners. */ val settingsRow = r2
}

/** Spacing scale: 2 · 4 · 6 · 8 · 10 · 12 · 16 · 20 · 24 · 32 · 48 dp. */
object ClaudeSpacing {
    val s2 = 2.dp; val s4 = 4.dp; val s6 = 6.dp; val s8 = 8.dp; val s10 = 10.dp; val s12 = 12.dp
    val s14 = 14.dp; val s16 = 16.dp; val s20 = 20.dp; val s24 = 24.dp; val s32 = 32.dp; val s36 = 36.dp; val s48 = 48.dp
    /** List screens' horizontal gutter. */ val listGutter = 16.dp
    /** Sheet content gutter. */ val sheetGutter = 24.dp
    /** Readable max widths. */ val buttonMaxWidth = 580.dp; val dialogMaxWidth = 520.dp; val snackbarMaxWidth = 400.dp
}

/** Motion tokens. */
object ClaudeMotion {
    /** cds_motion_duration_base. */ const val baseMillis = 200
    /** cds_ease_out cubic(0.165, 0.84, 0.44, 1). */ val easeOut = CubicBezierEasing(0.165f, 0.84f, 0.44f, 1f)
    /** n3j.d cubic(0.2, 0, 0, 1). */ val emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    /** n3j.c. */ val standard = FastOutSlowInEasing
    /** n3j.a spring(1.0, 400). */ fun <T> springCalm() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 400f)
    /** n3j.b spring(0.5, 400) — bouncy. */ fun <T> springBouncy() = spring<T>(dampingRatio = 0.5f, stiffness = 400f)
    /** Dialog / colour tweens: 200 ms ease-out. */ fun <T> base() = tween<T>(baseMillis, easing = easeOut)
    /** Login screen transitions: 300 ms FastOutSlowIn. */ fun <T> screen() = tween<T>(300, easing = FastOutSlowInEasing)
    /** Crossfade in/out. */ fun <T> fadeIn() = tween<T>(250, easing = FastOutSlowInEasing); fun <T> fadeOut() = tween<T>(150, easing = FastOutSlowInEasing)
    /** Home greeting crossfade. */ const val greetingCrossfadeMillis = 300
}

/** Shadows as (blur, alpha, y offset). */
object ClaudeElevation {
    val sm = Triple(4.dp, .08f, 2.dp); val md = Triple(8.dp, .10f, 2.dp)
    /** Snackbar: M3 shadowElevation 2 dp. */ val snackbar = 2.dp
}

internal val LocalClaudeColors = staticCompositionLocalOf { LightClaudeColors }
internal val LocalClaudeType = staticCompositionLocalOf { ClaudeType() }
internal val LocalClaudeShapes = staticCompositionLocalOf { ClaudeShapes() }

/** Accessors: `Claude.colors`, `Claude.type`, `Claude.shapes`. */
object Claude {
    val colors: ClaudeColors @Composable @ReadOnlyComposable get() = LocalClaudeColors.current
    val type: ClaudeType @Composable @ReadOnlyComposable get() = LocalClaudeType.current
    val shapes: ClaudeShapes @Composable @ReadOnlyComposable get() = LocalClaudeShapes.current
}

/** Material3 ColorScheme from the core tokens. Roles the official app leaves at a placeholder
 *  (#DADCFF) are given the nearest Claude token instead, so stock components never show it. */
internal fun ClaudeColors.materialScheme(): ColorScheme {
    val base = if (isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = accentMain100, onPrimary = onColor100, primaryContainer = accentMain000, onPrimaryContainer = onColor100,
        inversePrimary = accentMain200,
        secondary = text300, onSecondary = bg000, secondaryContainer = bg300, onSecondaryContainer = text300,
        tertiary = text300, onTertiary = bg000, tertiaryContainer = bg400, onTertiaryContainer = text300,
        background = bg100, onBackground = text100,
        surface = bg000, onSurface = text100, surfaceVariant = bg000, onSurfaceVariant = text500,
        surfaceTint = Color.Black, inverseSurface = text100, inverseOnSurface = bg000,
        error = danger100, onError = onColor100, errorContainer = danger900, onErrorContainer = danger000,
        outline = border300, outlineVariant = border300, scrim = Color.Black,
        surfaceBright = bg000, surfaceDim = bg000, surfaceContainer = bg000, surfaceContainerHigh = bg000,
        surfaceContainerHighest = bg000, surfaceContainerLow = bg000, surfaceContainerLowest = bg000,
    )
}

/** Material3 Typography fed to stock components. */
internal fun ClaudeType.materialTypography(): Typography {
    val base = Typography()
    return base.copy(
        headlineSmall = topBarTitle, titleLarge = topBarTitle,
        titleMedium = body17, titleSmall = body17, bodyLarge = body17,
        bodyMedium = body15, bodySmall = body15, labelLarge = body15,
        labelMedium = body13, labelSmall = body11,
    )
}

/** The app theme: provides [Claude] tokens and the mapped Material3 theme. */
@Composable fun ClaudexTheme(dark: Boolean, content: @Composable () -> Unit) {
    val colors = if (dark) DarkClaudeColors else LightClaudeColors
    val type = androidx.compose.runtime.remember { ClaudeType() }
    val shapes = androidx.compose.runtime.remember { ClaudeShapes() }
    CompositionLocalProvider(LocalClaudeColors provides colors, LocalClaudeType provides type, LocalClaudeShapes provides shapes) {
        MaterialTheme(colorScheme = colors.materialScheme(), typography = type.materialTypography(),
            shapes = Shapes(extraSmall = shapes.r4, small = shapes.r8, medium = shapes.r12, large = shapes.r16, extraLarge = shapes.r24),
            content = content)
    }
}
