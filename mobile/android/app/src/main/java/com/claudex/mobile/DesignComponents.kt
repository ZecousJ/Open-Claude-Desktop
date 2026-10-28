@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package com.claudex.mobile

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider

/*
 * Shared components of the official design system, built on [Claude] tokens.
 * Screens use these instead of stock Material3 look-alikes. Every component keeps the official
 * metrics; each KDoc names the section it follows.
 */

// ───────────────────────────── Buttons ─────────────────────────────

/** Variants: Primary (black/white pill), Brand (clay), Destructive, Secondary (outlined),
 *  Tinted (outlined, blue text), Borderless (ghost), NoticeCta. */
enum class ButtonVariant { Primary, Brand, Destructive, Secondary, Tinted, Borderless, NoticeCta }

/** Sizes: visual height, min touch target, icon size, label style. */
enum class ButtonSize(val height: Dp, val touch: Dp, val icon: Dp) {
    Small(36.dp, 40.dp, 20.dp), Medium(40.dp, 40.dp, 24.dp), MediumLarge(44.dp, 48.dp, 24.dp), Large(48.dp, 48.dp, 24.dp), CardAnswer(44.dp, 48.dp, 24.dp)
}

private data class ButtonPalette(val container: Color, val border: Color?, val content: Color)

@Composable private fun buttonPalette(variant: ButtonVariant, pressed: Boolean, enabled: Boolean): ButtonPalette {
    val c = Claude.colors
    val content = LocalContentColor.current
    return when (variant) {
        ButtonVariant.Primary -> ButtonPalette(if (!enabled) c.buttonDisabledFill else if (pressed) c.primaryFillPressed else c.primaryFill, null, if (enabled) c.primaryContent else c.onColor200)
        ButtonVariant.Brand -> ButtonPalette(if (!enabled) c.buttonDisabledFill else if (pressed) c.brandFillPressed else c.brandFill, null, if (enabled) c.onBrand else c.onColor200)
        ButtonVariant.Destructive -> ButtonPalette(if (!enabled) c.buttonDisabledFill else if (pressed) c.destructiveFillPressed else c.destructiveFill, null, if (enabled) c.destructiveContent else c.onColor200)
        ButtonVariant.Secondary -> ButtonPalette(if (pressed && enabled) c.bg300 else Color.Transparent, c.border300, if (enabled) c.text100 else c.outlinedDisabledContent)
        ButtonVariant.Tinted -> ButtonPalette(if (pressed && enabled) c.bg300 else Color.Transparent, c.border300, if (enabled) c.accentSecondary100 else c.accentSecondary900)
        ButtonVariant.Borderless -> ButtonPalette(if (pressed && enabled) c.borderlessPressed else Color.Transparent, null, if (enabled) content else content.copy(alpha = .38f))
        ButtonVariant.NoticeCta -> ButtonPalette(if (pressed && enabled) (if (c.isDark) c.quoteBar else c.bg300) else c.noticeCtaFill, c.noticeCtaBorder, if (enabled) c.text100 else c.outlinedDisabledContent)
    }
}

/**
 * The Claude button: pill, 12 dp horizontal content padding, 4 dp icon–label gap,
 * container colour animated between Resting / Active (pressed or [selected]) / Disabled.
 * With [text] null and an [icon] it is a square icon-only button.
 */
@Composable fun ClaudeButton(text: String?, onClick: () -> Unit, modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.Primary, size: ButtonSize = ButtonSize.Medium, enabled: Boolean = true,
    icon: ImageVector? = null, trailingIcon: ImageVector? = null, contentDescription: String? = null,
    selected: Boolean = false, loading: Boolean = false, fillWidth: Boolean = false, contentColor: Color? = null) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val palette = buttonPalette(variant, pressed || selected, enabled)
    val container by animateColorAsState(palette.container, label = "buttonContainer")
    val content by animateColorAsState(contentColor ?: palette.content, label = "buttonContent")
    val labelStyle = if (size == ButtonSize.Small || size == ButtonSize.CardAnswer) Claude.type.body15Strong else Claude.type.body17Strong
    val iconOnly = text == null
    Box(modifier.then(if (fillWidth) Modifier.fillMaxWidth().widthIn(max = ClaudeSpacing.buttonMaxWidth) else Modifier)
        .heightIn(min = size.touch).semantics { if (contentDescription != null) this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center) {
        Row(Modifier.then(if (fillWidth) Modifier.fillMaxWidth() else Modifier)
            .then(if (iconOnly) Modifier.size(size.height) else Modifier.height(size.height))
            .clip(CircleShape).background(container)
            .then(if (palette.border != null) Modifier.border(1.dp, palette.border, CircleShape) else Modifier)
            .clickable(interaction, LocalIndication.current, enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (iconOnly) 0.dp else 12.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            CompositionLocalProvider(LocalContentColor provides content) {
                if (loading) ClaudeSpinner(SpinnerSize.XSmall, color = content)
                else icon?.let { Icon(it, null, Modifier.size(size.icon), tint = content) }
                text?.let { Text(it, style = labelStyle, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                trailingIcon?.let { Icon(it, null, Modifier.size(size.icon), tint = content) }
            }
        }
    }
}

/** Plain icon button: M3 IconButton (48 dp touch). [compact] = the 32 dp card variant with 4 dp padding. */
@Composable fun ClaudeIconButton(icon: ImageVector, contentDescription: String?, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, tint: Color = LocalContentColor.current, compact: Boolean = false, iconSize: Dp = 24.dp) {
    IconButton(onClick, modifier.then(if (compact) Modifier.size(32.dp) else Modifier), enabled = enabled) {
        Icon(icon, contentDescription, Modifier.size(if (compact) 24.dp else iconSize), tint = if (enabled) tint else tint.copy(alpha = .38f))
    }
}

// ───────────────────────────── Spinner ─────────────────────────────

enum class SpinnerSize(val diameter: Dp, val stroke: Dp, val padding: Dp) {
    XXSmall(12.dp, 1.5.dp, 0.dp), Icon(16.dp, 1.dp, 2.dp), XSmall(18.dp, 2.dp, 0.dp), Small(24.dp, 2.dp, 0.dp), Medium(32.dp, 3.dp, 0.dp), Large(48.dp, 4.dp, 0.dp)
}

/** Circular progress: accent colour, transparent track when indeterminate,
 *  border-200 track when [progress] is given. */
@Composable fun ClaudeSpinner(size: SpinnerSize = SpinnerSize.Medium, modifier: Modifier = Modifier,
    color: Color = Claude.colors.accentMain100, progress: Float? = null) {
    val m = modifier.padding(size.padding).size(size.diameter - size.padding * 2)
    if (progress == null) CircularProgressIndicator(m, color = color, strokeWidth = size.stroke, trackColor = Color.Transparent)
    else CircularProgressIndicator({ progress }, m, color = color, strokeWidth = size.stroke, trackColor = Claude.colors.border200)
}

/** A plain centred loading state (no plumbing text). */
@Composable fun LoadingState(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(vertical = 32.dp), contentAlignment = Alignment.Center) { ClaudeSpinner() }
}

// ───────────────────────────── Bottom sheet ─────────────────────────────

/** Drag handle: 36 × 5 dp pill in border-300, inside a 48 × 16 dp touch box. */
@Composable fun ClaudeSheetHandle(modifier: Modifier = Modifier) {
    val label = stringResource(R.string.sheet_grabber_description)
    Box(modifier.fillMaxWidth().semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Box(Modifier.padding(horizontal = 6.dp, vertical = 5.5.dp).size(36.dp, 5.dp).clip(CircleShape).background(Claude.colors.border300))
    }
}

/**
 * Modal bottom sheet: top corners 44 dp, bg-100 container, text-100 content,
 * 36 × 5 handle, M3 scrim. Drop-in for Material3 ModalBottomSheet.
 */
@Composable fun ClaudeModalBottomSheet(onDismissRequest: () -> Unit, modifier: Modifier = Modifier,
    sheetState: SheetState = rememberModalBottomSheetState(), containerColor: Color = Claude.colors.bg100,
    content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismissRequest, modifier = modifier, sheetState = sheetState,
        shape = Claude.shapes.sheet, containerColor = containerColor, contentColor = Claude.colors.text100,
        tonalElevation = 0.dp, dragHandle = { ClaudeSheetHandle() }, content = content)
}

/** Sheet header: optional close button, title max 2 lines as a heading; 16 × 5 dp padding. */
@Composable fun ClaudeSheetHeader(title: String?, onClose: (() -> Unit)? = null, modifier: Modifier = Modifier, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (onClose != null) ClaudeIconButton(AppGlyphs.x, stringResource(R.string.close_sheet), onClose)
        Text(title.orEmpty(), Modifier.weight(1f).semantics { heading() }, style = Claude.type.body17Strong, color = Claude.colors.text100,
            maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = if (onClose != null) TextAlign.Center else TextAlign.Start)
        if (onClose != null) Spacer(Modifier.size(48.dp))
        trailing()
    }
}

/** Sheet action row: 20 × 12 dp padding, 12 dp gap, icon text-secondary, label 15/400 text-primary. */
@Composable fun SheetActionRow(label: String, onClick: () -> Unit, icon: ImageVector? = null, modifier: Modifier = Modifier,
    destructive: Boolean = false, enabled: Boolean = true, trailing: @Composable (() -> Unit)? = null, suffix: String? = null) {
    val c = Claude.colors
    val text = if (destructive) c.dangerText else c.textPrimary
    Row(modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(it, null, Modifier.size(24.dp), tint = (if (destructive) c.dangerText else c.textSecondary).copy(alpha = if (enabled) 1f else .38f)) }
        Text(label, Modifier.weight(1f), style = Claude.type.body15, color = text.copy(alpha = if (enabled) 1f else .38f))
        suffix?.let { Text(it, style = Claude.type.body13, color = c.text500) }
        trailing?.invoke()
    }
}

// ───────────────────────────── Dialog ─────────────────────────────

/** Window dim of the official dialog: 0.40 light / 0.50 dark. */
@Composable private fun DialogDim() {
    val dim = Claude.colors.dialogScrim.alpha
    val window = (LocalView.current.parent as? DialogWindowProvider)?.window
    SideEffect { window?.setDimAmount(dim) }
}

/**
 * The Cds dialog: max 520 dp, 16 dp outer margin, 12 dp corners, dialog surface with a 10 %
 * hairline, 24 dp padding, title 20/500 text-primary, body 15/400 text-secondary, buttons end-aligned
 * 8 dp apart 16 dp below. Same parameters as Material3 AlertDialog, so it is a drop-in.
 */
@Composable fun ClaudeAlertDialog(onDismissRequest: () -> Unit, confirmButton: @Composable () -> Unit, modifier: Modifier = Modifier,
    dismissButton: @Composable (() -> Unit)? = null, icon: @Composable (() -> Unit)? = null, title: @Composable (() -> Unit)? = null,
    text: @Composable (() -> Unit)? = null, properties: DialogProperties = DialogProperties()) {
    Dialog(onDismissRequest, DialogProperties(dismissOnBackPress = properties.dismissOnBackPress, dismissOnClickOutside = properties.dismissOnClickOutside, usePlatformDefaultWidth = false)) {
        DialogDim()
        val c = Claude.colors
        Surface(modifier.padding(16.dp).widthIn(max = ClaudeSpacing.dialogMaxWidth).fillMaxWidth(), shape = Claude.shapes.dialog,
            color = c.dialogSurface, contentColor = c.textPrimary, border = BorderStroke(1.dp, c.borderDefault), shadowElevation = 8.dp) {
            Column(Modifier.padding(24.dp)) {
                icon?.let { Box(Modifier.padding(bottom = 12.dp)) { it() } }
                title?.let { CompositionLocalProvider(LocalTextStyle provides Claude.type.dialogTitle, LocalContentColor provides c.textPrimary) { Box(Modifier.semantics { heading() }) { it() } } }
                if (title != null) Spacer(Modifier.height(if (text != null) 4.dp else 12.dp))
                text?.let { CompositionLocalProvider(LocalTextStyle provides Claude.type.body15, LocalContentColor provides c.textSecondary) {
                    Box(Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState())) { it() } } }
                Spacer(Modifier.height(16.dp))
                // Text buttons inside a dialog read as neutral text, as the official footers do.
                MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(primary = c.text100)) {
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                        dismissButton?.invoke(); confirmButton()
                    }
                }
            }
        }
    }
}

/** Convenience dialog with string title/body and Claude buttons: [confirm] first, then Cancel (Secondary). */
@Composable fun ClaudeDialog(title: String, body: String?, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit,
    destructive: Boolean = false, cancelLabel: String = stringResource(R.string.generic_button_cancel), busy: Boolean = false) {
    ClaudeAlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(title) }, text = body?.let { { Text(it) } },
        dismissButton = { ClaudeButton(cancelLabel, onDismiss, variant = ButtonVariant.Secondary, size = ButtonSize.Small, enabled = !busy) },
        confirmButton = { ClaudeButton(confirmLabel, onConfirm, variant = if (destructive) ButtonVariant.Destructive else ButtonVariant.Primary, size = ButtonSize.Small, loading = busy) })
}

// ───────────────────────────── Snackbar / toast ─────────────────────────────

/** Error / status snackbar: 14 dp corners, bg-000, 0.5 dp border-200, 2 dp shadow,
 *  warning (or check) icon in text-300, optional title 13/550, message 13/400, dismiss ✕. Max 400 dp. */
@Composable fun ClaudeSnackbar(message: String, onDismiss: () -> Unit, modifier: Modifier = Modifier, title: String? = null,
    success: Boolean = false, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    val c = Claude.colors
    Surface(modifier.widthIn(max = ClaudeSpacing.snackbarMaxWidth).fillMaxWidth(), shape = Claude.shapes.snackbar, color = c.bg000,
        contentColor = c.text100, shadowElevation = ClaudeElevation.snackbar, border = BorderStroke(0.5.dp, c.border200)) {
        Row(Modifier.heightIn(min = 55.dp).padding(start = 14.dp, top = 12.dp, end = 4.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (success) AppGlyphs.check else AppGlyphs.warning, null, Modifier.size(20.dp), tint = c.text300)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                title?.let { Text(it, style = Claude.type.body13Strong) }
                Text(message, style = Claude.type.body13)
            }
            if (actionLabel != null && onAction != null) { TextButton(onAction) { Text(actionLabel, style = Claude.type.body13Strong, color = c.text100) }; Spacer(Modifier.width(8.dp)) }
            ClaudeIconButton(AppGlyphs.x, stringResource(R.string.generic_button_content_description_dismiss), onDismiss, tint = c.text300, iconSize = 20.dp)
        }
    }
}

/** Snackbar host that draws [ClaudeSnackbar] for each message. */
@Composable fun ClaudeSnackbarHost(state: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(state, modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { data ->
        ClaudeSnackbar(data.visuals.message, { data.dismiss() },
            actionLabel = data.visuals.actionLabel?.takeIf { it.isNotBlank() && data.visuals.withDismissAction }, onAction = { data.performAction() })
    }
}

/** Pill toast: ≥ 32 dp, 48 dp corners, G0 fill, 0.5 dp H0 border. */
@Composable fun PillToast(text: String, modifier: Modifier = Modifier, onClick: () -> Unit = {}) {
    val c = Claude.colors
    Surface(onClick, modifier.heightIn(min = 32.dp), shape = Claude.shapes.r48, color = c.pillToastFill, contentColor = c.text100,
        border = BorderStroke(0.5.dp, c.pillToastBorder)) {
        Box(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), contentAlignment = Alignment.Center) { Text(text, style = Claude.type.body13) }
    }
}

// ───────────────────────────── Menu ─────────────────────────────

/** Dropdown container: M3 DropdownMenu with Claude colours (bg-000, 12 dp corners, border-300 hairline). */
@Composable fun ClaudeDropdownMenu(expanded: Boolean, onDismissRequest: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    DropdownMenu(expanded, onDismissRequest, modifier, shape = Claude.shapes.r12, containerColor = Claude.colors.bg000,
        tonalElevation = 0.dp, shadowElevation = 8.dp, border = BorderStroke(1.dp, Claude.colors.borderDefault), content = content)
}

/** Menu item: 4 dp inset, 12 dp corners, text-100 label, text-500 icons, check when [selected]. */
@Composable fun ClaudeMenuItem(text: String, onClick: () -> Unit, icon: ImageVector? = null, modifier: Modifier = Modifier,
    selected: Boolean? = null, destructive: Boolean = false, enabled: Boolean = true) {
    val c = Claude.colors
    val alpha = if (enabled) 1f else .38f
    val labelColor = (if (destructive) c.dangerText else c.text100).copy(alpha = alpha)
    Row(modifier.padding(horizontal = 4.dp).fillMaxWidth().widthIn(min = 180.dp).clip(Claude.shapes.menuItem)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).heightIn(min = 44.dp).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        icon?.let { Icon(it, null, Modifier.size(20.dp), tint = (if (destructive) c.dangerText else c.text500).copy(alpha = alpha)) }
        Text(text, Modifier.weight(1f), style = Claude.type.body15, color = labelColor)
        if (selected == true) Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = c.text500)
    }
}

// ───────────────────────────── Switch & checkbox ─────────────────────────────

/** Switch: white thumb; on = accent blue track; off = C0 track with the 15 % outline. */
@Composable fun ClaudeSwitch(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Claude.colors
    Switch(checked, onCheckedChange, modifier, enabled = enabled, colors = SwitchDefaults.colors(
        checkedThumbColor = Color.White, checkedTrackColor = c.accentBlue, checkedBorderColor = Color.Transparent,
        uncheckedThumbColor = Color.White, uncheckedTrackColor = c.switchTrackOff, uncheckedBorderColor = c.border300))
}

/** Checkbox: 18 dp, 5 dp corners, 1 dp outline text-tertiary, accent-blue fill, white check;
 *  colours tween 200 ms ease-out, glyph scales in from 0.6. */
@Composable fun ClaudeCheckbox(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Claude.colors
    val fill by animateColorAsState(if (checked) c.accentBlue else Color.Transparent, ClaudeMotion.base(), label = "checkboxFill")
    val outline by animateColorAsState(if (checked) c.accentBlue else c.textTertiary, ClaudeMotion.base(), label = "checkboxOutline")
    Box(modifier.size(48.dp).then(if (onCheckedChange != null) Modifier.toggleable(checked, enabled = enabled, role = Role.Checkbox, onValueChange = onCheckedChange) else Modifier),
        contentAlignment = Alignment.Center) {
        Box(Modifier.size(18.dp).clip(RoundedCornerShape(5.dp)).background(fill).border(1.dp, outline, RoundedCornerShape(5.dp)), contentAlignment = Alignment.Center) {
            AnimatedVisibility(checked, enter = scaleIn(ClaudeMotion.springCalm(), initialScale = .6f) + fadeIn(ClaudeMotion.base())) {
                Icon(AppGlyphs.check, null, Modifier.size(16.dp), tint = c.checkGlyph)
            }
        }
    }
}

// ───────────────────────────── Chip ─────────────────────────────

/** Selectable chip. Default = model/option chip (14 dp corners, 0.5 dp border-300, 15/550 label,
 *  10 × 8 dp padding); [compact] = 8 dp corners. Selected fills with bg-300 and text-100. */
@Composable fun ClaudeChip(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false,
    leadingIcon: ImageVector? = null, trailingIcon: ImageVector? = null, compact: Boolean = false, enabled: Boolean = true) {
    val c = Claude.colors
    val shape = if (compact) Claude.shapes.r8 else Claude.shapes.r14
    Surface(onClick, modifier, enabled = enabled, shape = shape, color = if (selected) c.bg300 else c.bg100,
        contentColor = if (selected) c.text100 else c.text300, border = BorderStroke(0.5.dp, c.border300)) {
        Row(Modifier.padding(horizontal = if (compact) 12.dp else 10.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            leadingIcon?.let { Icon(it, null, Modifier.size(18.dp)) }
            Text(label, style = if (compact) Claude.type.body15 else Claude.type.body15Strong, maxLines = 1)
            trailingIcon?.let { Icon(it, null, Modifier.size(18.dp)) }
        }
    }
}

// ───────────────────────────── Text fields ─────────────────────────────

/**
 * Claude text field: default pill, bg-300 fill, 15/400 text, text-500 placeholder, 16 dp padding,
 * accent cursor. Login uses [shape] = 12 dp and [container] = bg-000 with a border.
 */
@Composable fun ClaudeTextField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String? = null,
    singleLine: Boolean = true, minLines: Int = 1, maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE, enabled: Boolean = true,
    shape: androidx.compose.ui.graphics.Shape = Claude.shapes.pill, container: Color = Claude.colors.bg300, border: Color = Color.Transparent,
    textColor: Color = Claude.colors.text100, placeholderColor: Color = Claude.colors.text500,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default, keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None, textStyle: TextStyle = Claude.type.body15,
    leading: @Composable (() -> Unit)? = null, trailing: @Composable (() -> Unit)? = null, contentPadding: PaddingValues = PaddingValues(16.dp)) {
    BasicTextField(value, onValueChange, modifier, enabled = enabled, singleLine = singleLine, minLines = minLines, maxLines = maxLines,
        textStyle = textStyle.copy(color = textColor), cursorBrush = SolidColor(Claude.colors.accentMain100),
        keyboardOptions = keyboardOptions, keyboardActions = keyboardActions, visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Row(Modifier.clip(shape).background(container).border(1.dp, border, shape), verticalAlignment = Alignment.CenterVertically) {
                leading?.let { Box(Modifier.padding(start = 16.dp)) { CompositionLocalProvider(LocalContentColor provides placeholderColor) { it() } } }
                Box(Modifier.weight(1f).padding(contentPadding), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty() && placeholder != null) Text(placeholder, style = textStyle, color = placeholderColor, maxLines = 1)
                    inner()
                }
                trailing?.invoke()
            }
        })
}

/** Search field: pill, surface-sunken fill, 10 % border, search icon in text-tertiary. */
@Composable fun ClaudeSearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier,
    onClear: (() -> Unit)? = null, focusRequester: androidx.compose.ui.focus.FocusRequester? = null) {
    val c = Claude.colors
    ClaudeTextField(value, onValueChange, modifier.fillMaxWidth().then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
        placeholder = placeholder, container = c.surfaceSunken, border = c.borderDefault, textColor = c.textPrimary, placeholderColor = c.textTertiary,
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 12.dp),
        leading = { Icon(AppGlyphs.search, null, Modifier.size(20.dp), tint = c.textTertiary) },
        trailing = if (value.isNotEmpty()) ({ ClaudeIconButton(AppGlyphs.xCircleFilled, stringResource(R.string.generic_search_clear), { onClear?.invoke() ?: onValueChange("") }, tint = c.textTertiary, iconSize = 18.dp) }) else null)
}

// ───────────────────────────── Rows ─────────────────────────────

/** Thread/session card row: 1 dp border-default, 16 dp corners, min 62 dp, 16 × 12 dp padding,
 *  title 15/400 text-primary one line, optional status and trailing overflow. */
@Composable fun ClaudeCardRow(title: String, onClick: () -> Unit, modifier: Modifier = Modifier, status: String? = null,
    leading: @Composable (() -> Unit)? = null, trailing: @Composable (() -> Unit)? = null, onLongClick: (() -> Unit)? = null) {
    val c = Claude.colors
    Row(modifier.fillMaxWidth().clip(Claude.shapes.card).border(1.dp, c.borderDefault, Claude.shapes.card)
        .combinedClickable(onClick = onClick, onLongClick = onLongClick).heightIn(min = 62.dp).padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        leading?.invoke()
        Column(Modifier.weight(1f)) {
            Text(title, style = Claude.type.body15, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            status?.let { Text(it, style = Claude.type.body13, color = c.text500, maxLines = 1) }
        }
        trailing?.invoke()
    }
}

/** Settings group: 12 dp side margin, 16 dp clip, rows 2 dp apart over the page colour. */
@Composable fun SettingsGroup(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(Claude.shapes.card), verticalArrangement = Arrangement.spacedBy(2.dp), content = content)
}

/** Settings section header: 15/400 text-300, 24 dp side padding, 8 dp below, heading. */
@Composable fun SettingsSectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp).semantics { heading() }, style = Claude.type.body15, color = Claude.colors.text300)
}

/** Settings navigation row: bg-000 tile with 2 dp corners, padding 12/8/16/8, min 56 dp,
 *  24 dp icon, 10 dp gap, title 17/400 text-100 (2 lines), subtitle 15/400 text-500 (1 line), no chevron. */
@Composable fun SettingsRow(title: String, onClick: () -> Unit, icon: ImageVector? = null, modifier: Modifier = Modifier, subtitle: String? = null,
    enabled: Boolean = true, titleColor: Color = Claude.colors.text100, subtitleMaxLines: Int = 1, trailing: @Composable (() -> Unit)? = null) {
    val c = Claude.colors
    val alpha = if (enabled) 1f else .38f
    Row(modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .heightIn(min = 56.dp).padding(start = 12.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(it, null, Modifier.size(24.dp), tint = titleColor.copy(alpha = alpha)) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Claude.type.body17, color = titleColor.copy(alpha = alpha), maxLines = 2, overflow = TextOverflow.Ellipsis)
            subtitle?.takeIf { it.isNotBlank() }?.let { Text(it, style = Claude.type.body15, color = c.text500.copy(alpha = alpha), maxLines = subtitleMaxLines, overflow = TextOverflow.Ellipsis) }
        }
        trailing?.invoke()
    }
}

/** Settings switch row: the whole row toggles; helper text below the title. */
@Composable fun SettingsSwitchRow(title: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, icon: ImageVector? = null,
    modifier: Modifier = Modifier, helper: String? = null, enabled: Boolean = true) {
    val c = Claude.colors
    Row(modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000).toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
        .heightIn(min = 56.dp).padding(start = 12.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(it, null, Modifier.size(24.dp), tint = c.text100) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Claude.type.body17, color = c.text100.copy(alpha = if (enabled) 1f else .38f))
            helper?.let { Text(it, style = Claude.type.body15, color = c.text500) }
        }
        ClaudeSwitch(checked, null, enabled = enabled)
    }
}

/** Sub-screen scaffold: back arrow + serif 17/550 title, bg-100 page. */
@Composable fun ClaudeSubScreen(title: String, onBack: () -> Unit, modifier: Modifier = Modifier, actions: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxSize().background(Claude.colors.bg100)) {
        ClaudeTopBar(TopBarNavigation.Back(onBack), title = { ClaudeTopBarTitle(title, center = false) }, actions = actions)
        content()
    }
}

// ───────────────────────────── Top bar ─────────────────────────────

sealed interface TopBarNavigation {
    data object None : TopBarNavigation
    /** Menu button; [newFeature] adds the 8 dp accent dot at (+2, −2). */
    data class Menu(val onClick: () -> Unit, val newFeature: Boolean = false) : TopBarNavigation
    data class Back(val onClick: () -> Unit) : TopBarNavigation
}

/** Top-bar title text: serif 17/550, one line. */
@Composable fun ClaudeTopBarTitle(text: String, modifier: Modifier = Modifier, center: Boolean = true) {
    Text(text, modifier, style = Claude.type.topBarTitle, color = Claude.colors.text100, maxLines = 1, overflow = TextOverflow.Ellipsis,
        textAlign = if (center) TextAlign.Center else TextAlign.Start)
}

/** The three-slot top bar: navigation, title, actions; each slot ≥ 50 dp high, centred vertically. */
@Composable fun ClaudeTopBar(navigation: TopBarNavigation, modifier: Modifier = Modifier, centerTitle: Boolean = false,
    title: @Composable () -> Unit = {}, actions: @Composable RowScope.() -> Unit = {}) {
    val c = Claude.colors
    Box(modifier.fillMaxWidth().background(c.bg100).heightIn(min = 50.dp).padding(horizontal = 4.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 50.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.heightIn(min = 50.dp), contentAlignment = Alignment.Center) {
                when (navigation) {
                    is TopBarNavigation.Menu -> Box {
                        val label = stringResource(if (navigation.newFeature) R.string.generic_button_open_menu_new_feature else R.string.generic_button_open_menu)
                        ClaudeIconButton(AppGlyphs.menu, label, navigation.onClick, tint = c.text100)
                        if (navigation.newFeature) Box(Modifier.align(Alignment.TopEnd).offset(x = (-10).dp, y = 10.dp).size(8.dp).clip(CircleShape).background(c.accentMain100))
                    }
                    is TopBarNavigation.Back -> ClaudeIconButton(AppGlyphs.arrowLeft, stringResource(R.string.generic_back_button_content_description), navigation.onClick, tint = c.text100)
                    TopBarNavigation.None -> Spacer(Modifier.width(4.dp))
                }
            }
            Box(Modifier.weight(1f).heightIn(min = 50.dp).padding(horizontal = 4.dp), contentAlignment = if (centerTitle) Alignment.Center else Alignment.CenterStart) {
                CompositionLocalProvider(LocalContentColor provides c.text100) { title() }
            }
            Row(Modifier.heightIn(min = 50.dp), verticalAlignment = Alignment.CenterVertically) {
                CompositionLocalProvider(LocalContentColor provides c.text100) { actions() }
            }
        }
    }
}

// ───────────────────────────── Avatar ─────────────────────────────

enum class AvatarSize(val diameter: Dp) { XSmall(20.dp), Small(24.dp), Medium(32.dp), Large(40.dp), Account(44.dp) }

/** Circle avatar. Without a photo it shows the initial on the 10 % fill in text-secondary. */
@Composable fun ClaudeAvatar(name: String, size: AvatarSize = AvatarSize.Medium, modifier: Modifier = Modifier) {
    val c = Claude.colors
    val initial = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: ""
    Box(modifier.size(size.diameter).clip(CircleShape).background(c.fill10), contentAlignment = Alignment.Center) {
        if (initial.isEmpty()) Icon(AppGlyphs.user, null, Modifier.size(size.diameter * .6f), tint = c.textSecondary)
        else Text(initial, style = if (size.diameter <= 24.dp) Claude.type.body11Strong else if (size.diameter >= 44.dp) Claude.type.body17Strong else Claude.type.body13Strong, color = c.textSecondary, maxLines = 1)
    }
}

/** "New" badge: pill, text-100 at 10 %, accent text 13/550. */
@Composable fun NewBadge(modifier: Modifier = Modifier) {
    val c = Claude.colors
    Text(stringResource(R.string.nav_drawer_badge_new), modifier.clip(CircleShape).background(c.text100.copy(alpha = .10f)).padding(horizontal = 8.dp, vertical = 2.dp),
        style = Claude.type.body13Strong, color = c.accentMain100)
}

/** Hairline divider in border-300. */
@Composable fun ClaudeDivider(modifier: Modifier = Modifier) { HorizontalDivider(modifier, thickness = 1.dp, color = Claude.colors.border300) }

// ───────────────────────────── Greeting ─────────────────────────────

/** The Claudex mark. */
@Composable fun ClaudexMark(size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null) {
    Image(painterResource(R.drawable.claudex_knot), contentDescription, modifier.size(size))
}

/**
 * Home greeting: mark 43 dp → 11 dp → serif 22/400 greeting, centred, max 2 lines, 28 dp side padding,
 * crossfading (300 ms) when the text changes. [projectName] gives "How can I help with <clay>name</clay>?".
 */
@Composable fun ClaudeGreeting(modifier: Modifier = Modifier, projectName: String? = null, text: String? = null) {
    val c = Claude.colors
    val greeting = when {
        text != null -> androidx.compose.ui.text.AnnotatedString(text)
        projectName != null -> {
            val template = stringResource(R.string.chat_headline_project)
            val at = template.indexOf("^1")
            androidx.compose.ui.text.buildAnnotatedString {
                if (at < 0) append(template) else {
                    append(template.substring(0, at))
                    pushStyle(androidx.compose.ui.text.SpanStyle(color = c.clay)); append(projectName); pop()
                    append(template.substring(at + 2))
                }
            }
        }
        else -> androidx.compose.ui.text.AnnotatedString(stringResource(R.string.chat_headline_today))
    }
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        ClaudexMark(43.dp)
        Spacer(Modifier.height(11.dp))
        Crossfade(greeting, animationSpec = tween(ClaudeMotion.greetingCrossfadeMillis), label = "HeadlineCrossfade") { value ->
            Text(value, Modifier.fillMaxWidth().padding(horizontal = 28.dp), style = Claude.type.greeting, color = c.text100,
                textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
