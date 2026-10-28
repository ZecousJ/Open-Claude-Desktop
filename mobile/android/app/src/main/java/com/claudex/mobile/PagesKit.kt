@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
package com.claudex.mobile

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/*
 * Page-level pieces shared by the list, project, settings, code and scheduled-task pages.
 * Everything is built from the foundation
 * tokens and components; each KDoc names the official composable it follows.
 */

/**
 * A full page: the official top bar (menu for a drawer destination, back for a pushed page) and a
 * bg-100 body. The title is the serif 17/550 top-bar title unless [sansTitle] asks for the
 * Chats screen's 17/550 sans centred column, with an optional [subtitle] under it.
 */
@Composable fun OfficialPage(title: String, onBack: (() -> Unit)? = null, modifier: Modifier = Modifier, sansTitle: Boolean = false,
    subtitle: String? = null, actions: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    val c = Claude.colors
    val openSidebar = LocalOpenSidebar.current
    Column(modifier.fillMaxSize().background(c.bg100)) {
        ClaudeTopBar(if (onBack != null) TopBarNavigation.Back(onBack) else TopBarNavigation.Menu(openSidebar), centerTitle = sansTitle,
            title = {
                if (sansTitle) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(title, style = Claude.type.body17Strong, color = c.text100, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    AnimatedVisibility(subtitle != null) { Text(subtitle.orEmpty(), style = Claude.type.body15, color = c.text500, maxLines = 1) }
                } else ClaudeTopBarTitle(title, center = false)
            }, actions = actions)
        content()
    }
}

/** Empty state: centred, max 352 dp wide, 92 dp icon and 17/400 centred text in text-500, 12 dp apart; optional subtitle. */
@Composable fun OfficialEmptyState(icon: ImageVector, text: String, modifier: Modifier = Modifier, subtitle: String? = null, action: (@Composable () -> Unit)? = null) {
    val c = Claude.colors
    Box(modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 352.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, null, Modifier.size(92.dp), tint = c.text500)
            Spacer(Modifier.height(12.dp))
            Text(text, style = Claude.type.body17, color = c.text500, textAlign = TextAlign.Center)
            subtitle?.let { Spacer(Modifier.height(4.dp)); Text(it, style = Claude.type.body15, color = c.text500, textAlign = TextAlign.Center) }
            action?.let { Spacer(Modifier.height(16.dp)); it() }
        }
    }
}

/** Small error state with Retry. */
@Composable fun OfficialErrorState(text: String, onRetry: (() -> Unit)?, modifier: Modifier = Modifier) {
    OfficialEmptyState(AppGlyphs.warningCircle, text, modifier, action = onRetry?.let { retry -> { ClaudeButton(stringResource(R.string.generic_retry), retry, variant = ButtonVariant.Secondary, size = ButtonSize.Small) } })
}

/** Inline list search field: 40 dp high, 12 dp corners, 12/6 dp inner padding, outlined, search glyph. */
@Composable fun ListSearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val c = Claude.colors
    BasicTextField(value, onValueChange, modifier.fillMaxWidth().height(40.dp), singleLine = true,
        textStyle = Claude.type.body15.copy(color = c.textPrimary), cursorBrush = SolidColor(c.accentMain100),
        decorationBox = { inner ->
            Row(Modifier.fillMaxSize().clip(Claude.shapes.r12).background(c.bg000).border(1.dp, c.border200, Claude.shapes.r12).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(AppGlyphs.search, null, Modifier.size(18.dp), tint = c.textTertiary)
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(placeholder, style = Claude.type.body15, color = c.textTertiary, maxLines = 1)
                    inner()
                }
                if (value.isNotEmpty()) Icon(AppGlyphs.xCircleFilled, stringResource(R.string.generic_search_clear),
                    Modifier.size(18.dp).clip(CircleShape).clickable(role = Role.Button) { onValueChange("") }, tint = c.textTertiary)
            }
        })
}

/**
 * List row of the Chats and Projects screens: 12 dp side margin, 10 dp clip, min 56 dp,
 * 0/8/12/8 padding (Projects: 12/8/12/8), leading slot, title 17/400 one line with an optional pin mark,
 * subtitle 15/400 text-500, trailing slot. In selection mode a tap toggles the leading checkbox.
 */
@Composable fun OfficialListRow(title: String, onClick: () -> Unit, modifier: Modifier = Modifier, subtitle: String? = null,
    onLongClick: (() -> Unit)? = null, pinned: Boolean = false, leading: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null,
    selection: Boolean? = null, onToggle: ((Boolean) -> Unit)? = null, startPadding: Dp = 0.dp, enabled: Boolean = true) {
    val c = Claude.colors
    val selecting = selection != null && onToggle != null
    val alpha = if (enabled) 1f else .38f
    Row(modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(Claude.shapes.r10)
        .then(if (selecting) Modifier.toggleable(selection == true, role = Role.Checkbox, onValueChange = { onToggle?.invoke(it) })
            else Modifier.combinedClickable(enabled = enabled, onClick = onClick, onLongClick = onLongClick))
        .heightIn(min = 56.dp).padding(start = startPadding, top = 8.dp, end = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        AnimatedVisibility(selecting) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.width(12.dp)); ClaudeCheckbox(selection == true, null, Modifier.size(24.dp)); Spacer(Modifier.width(12.dp))
            }
        }
        leading?.let { it(); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, Modifier.weight(1f, fill = false), style = Claude.type.body17, color = c.text100.copy(alpha = alpha), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (pinned) Icon(AppGlyphs.pinFilled, stringResource(R.string.project_starred), Modifier.size(14.dp), tint = c.text500)
            }
            subtitle?.takeIf { it.isNotBlank() }?.let { Text(it, style = Claude.type.body15, color = c.text500.copy(alpha = alpha), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        trailing?.let { Spacer(Modifier.width(8.dp)); it() }
    }
}

/** Status mark slot: a 16 dp box; New = the 8 dp accent dot, Working = spinner, Waiting = warning glyph. */
enum class RowStatus { Quiet, New, Working, Waiting }
@Composable fun StatusMark(status: RowStatus, modifier: Modifier = Modifier) {
    val c = Claude.colors
    Box(modifier.size(16.dp), contentAlignment = Alignment.Center) {
        when (status) {
            RowStatus.New -> Box(Modifier.size(8.dp).clip(CircleShape).background(c.accentMain100))
            RowStatus.Working -> ClaudeSpinner(SpinnerSize.Icon)
            RowStatus.Waiting -> Icon(AppGlyphs.warning, stringResource(R.string.cds_list_row_status_waiting), Modifier.size(16.dp), tint = c.warning)
            RowStatus.Quiet -> Unit
        }
    }
}

/**
 * Relative time: under a minute "Just now" (first letter capitalised), otherwise "5 minutes ago" /
 * "2 days ago" in the app's language (ICU, so the forced Chinese default is honoured), and the date after a week.
 */
@Composable fun relativeTime(time: Long, capitalise: Boolean = true): String {
    val now = System.currentTimeMillis()
    if (time <= 0) return ""
    val locale = androidx.compose.ui.platform.LocalConfiguration.current.locales[0]
    if (now - time < 60_000) { val text = stringResource(R.string.date_format_just_now); return if (capitalise) text.replaceFirstChar { it.uppercase(locale) } else text }
    val minutes = (now - time) / 60_000
    val formatter = android.icu.text.RelativeDateTimeFormatter.getInstance(android.icu.util.ULocale.forLocale(locale))
    val past = android.icu.text.RelativeDateTimeFormatter.Direction.LAST
    return when {
        minutes < 60 -> formatter.format(minutes.toDouble(), past, android.icu.text.RelativeDateTimeFormatter.RelativeUnit.MINUTES)
        minutes < 24 * 60 -> formatter.format((minutes / 60).toDouble(), past, android.icu.text.RelativeDateTimeFormatter.RelativeUnit.HOURS)
        minutes < 7 * 24 * 60 -> formatter.format((minutes / (24 * 60)).toDouble(), past, android.icu.text.RelativeDateTimeFormatter.RelativeUnit.DAYS)
        else -> java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM, locale).format(java.util.Date(time))
    }
}

/** Plain tile inside a [SettingsGroup] (bg-000, 2 dp corners) for content that is not a row: meters, previews, forms. */
@Composable fun SettingsTile(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(start = 12.dp, top = 12.dp, end = 16.dp, bottom = 12.dp), content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(Claude.colors.bg000).padding(padding), content = content)
}

/** Capacity / meter bar: 8 dp track with a 4 dp radius, fill in accent-secondary. */
@Composable fun MeterBar(fraction: Float, modifier: Modifier = Modifier, fill: Color = Claude.colors.accentSecondary100) {
    val c = Claude.colors
    Box(modifier.fillMaxWidth().height(8.dp).clip(Claude.shapes.r4).background(c.bg400)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().clip(Claude.shapes.r4).background(fill))
    }
}

/** Meter row in the Usage page: title 17/400, the bar, caption 15/400 text-500 ("32% used · Resets in …"). */
@Composable fun UsageMeterRow(title: String, fraction: Float?, caption: String?) {
    val c = Claude.colors
    SettingsTile(padding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)) {
        Text(title, style = Claude.type.body17, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(10.dp))
        MeterBar(fraction ?: 0f)
        caption?.let { Spacer(Modifier.height(8.dp)); Text(it, style = Claude.type.body15, color = c.text500) }
    }
}

/** A value row inside a settings group: title on the left, value on the right (Billing balance, Routine details). */
@Composable fun SettingsValueRow(title: String, value: String, icon: ImageVector? = null, onClick: (() -> Unit)? = null, valueMaxLines: Int = 1) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth().clip(Claude.shapes.settingsRow).background(c.bg000)
        .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
        .heightIn(min = 56.dp).padding(start = 12.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(it, null, Modifier.size(24.dp), tint = c.text100) }
        Text(title, Modifier.weight(1f), style = Claude.type.body17, color = c.text100, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(value, Modifier.weight(1f, fill = false), style = Claude.type.body15, color = c.text500, textAlign = TextAlign.End, maxLines = valueMaxLines, overflow = TextOverflow.Ellipsis)
    }
}

/** Footnote below a settings group: 13/400 text-500, 24 dp side padding. */
@Composable fun SettingsFootnote(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 8.dp), style = Claude.type.body13, color = Claude.colors.text500)
}

/** Space between settings groups: 12 dp. */
@Composable fun GroupGap() { Spacer(Modifier.height(12.dp)) }

data class PickerOption(val value: String, val label: String, val icon: ImageVector? = null, val description: String? = null, val enabled: Boolean = true)

/**
 * Picker dialog: bg-100 surface, 16 dp corners, 300 dp wide (100–400 dp tall); title 17/550 with 20 dp side padding;
 * option rows 20/8 dp padding, min 56 dp, 17/400; the selected option in the link blue with a trailing check. Tap = select and close.
 */
@Composable fun OfficialPickerDialog(title: String, options: List<PickerOption>, selected: String?, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Claude.colors
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.width(300.dp).heightIn(min = 100.dp, max = 400.dp), shape = Claude.shapes.r16, color = c.bg100, contentColor = c.text100,
            border = BorderStroke(1.dp, c.borderDefault)) {
            Column {
                Spacer(Modifier.height(16.dp))
                Text(title, Modifier.padding(horizontal = 20.dp).semantics { heading() }, style = Claude.type.body17Strong, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.fillMaxWidth()) {
                    items(options, key = { it.value }) { option ->
                        val isSelected = option.value == selected
                        val color = if (isSelected) c.link else c.text100
                        Row(Modifier.fillMaxWidth().selectable(isSelected, enabled = option.enabled, role = Role.RadioButton) { onSelect(option.value) }
                            .heightIn(min = 56.dp).padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            option.icon?.let { Icon(it, null, Modifier.size(24.dp), tint = color.copy(alpha = if (option.enabled) 1f else .38f)) }
                            Column(Modifier.weight(1f)) {
                                Text(option.label, style = Claude.type.body17, color = color.copy(alpha = if (option.enabled) 1f else .38f))
                                option.description?.let { Text(it, style = Claude.type.body15, color = c.text500) }
                            }
                            if (isSelected) Icon(AppGlyphs.check, null, Modifier.size(20.dp), tint = color)
                        }
                    }
                    item { Spacer(Modifier.height(8.dp)) }
                }
            }
        }
    }
}

/** Text-field dialog in the Cds dialog shell (rename, custom instructions, create document). */
@Composable fun TextInputDialog(title: String, value: String, onValueChange: (String) -> Unit, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit,
    description: String? = null, placeholder: String? = null, singleLine: Boolean = true, minLines: Int = 1, busy: Boolean = false, enabled: Boolean = value.isNotBlank()) {
    ClaudeAlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(title) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            description?.let { Text(it) }
            ClaudeTextField(value, onValueChange, Modifier.fillMaxWidth(), placeholder = placeholder, singleLine = singleLine, minLines = minLines,
                maxLines = if (singleLine) 1 else 10, shape = Claude.shapes.field, container = Claude.colors.bg000, border = Claude.colors.border300,
                contentPadding = PaddingValues(12.dp))
        }
    }, dismissButton = { ClaudeButton(stringResource(R.string.generic_button_cancel), onDismiss, variant = ButtonVariant.Secondary, size = ButtonSize.Small, enabled = !busy) },
        confirmButton = { ClaudeButton(confirmLabel, onConfirm, size = ButtonSize.Small, enabled = enabled && !busy, loading = busy) })
}

/** Form field label (Profile `profile_full_name` etc.): 15/400 text-100 with 4 dp below. */
@Composable fun FieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(bottom = 4.dp), style = Claude.type.body15, color = LocalContentColor.current)
}

/** Field in the settings look: bg-000 container, 12 dp corners, hairline. */
@Composable fun SettingsTextField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String? = null,
    singleLine: Boolean = true, minLines: Int = 1, maxLines: Int = if (singleLine) 1 else 8, enabled: Boolean = true) {
    ClaudeTextField(value, onValueChange, modifier.fillMaxWidth(), placeholder = placeholder, singleLine = singleLine, minLines = minLines, maxLines = maxLines,
        enabled = enabled, shape = Claude.shapes.field, container = Claude.colors.bg000, border = Claude.colors.border300, contentPadding = PaddingValues(12.dp))
}
