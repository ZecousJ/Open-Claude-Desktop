@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

/** The moment a one-time task runs, split in this phone's time zone (the pickers edit the date and the time separately). */
internal object OnceMoment {
    private fun zoned(at: Long, zone: ZoneId): ZonedDateTime = Instant.ofEpochMilli(at).atZone(zone)
    /** [at] with its day replaced by [day] (a calendar day), keeping the time of day. */
    fun withDay(at: Long, day: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Long =
        ZonedDateTime.of(LocalDateTime.of(day, zoned(at, zone).toLocalTime()), zone).toInstant().toEpochMilli()
    /** [at] with its time of day replaced, keeping the day. */
    fun withTime(at: Long, hour: Int, minute: Int, zone: ZoneId = ZoneId.systemDefault()): Long =
        ZonedDateTime.of(LocalDateTime.of(zoned(at, zone).toLocalDate(), LocalTime.of(hour, minute)), zone).toInstant().toEpochMilli()
    /** The Material date picker names a day by its UTC midnight; this is that value for [at]'s local day. */
    fun pickerMillis(at: Long, zone: ZoneId = ZoneId.systemDefault()): Long = zoned(at, zone).toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    fun dayOfPicker(utcMillis: Long): LocalDate = Instant.ofEpochMilli(utcMillis).atZone(ZoneOffset.UTC).toLocalDate()
}

/** A picker dialog: bg-100 surface, 16 dp corners, title, the picker, Cancel and OK end-aligned. */
@Composable private fun PickerShell(title: String, onConfirm: () -> Unit, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Claude.colors
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.padding(16.dp).widthIn(max = 360.dp).fillMaxWidth(), shape = Claude.shapes.r16, color = c.bg100, contentColor = c.text100, border = BorderStroke(1.dp, c.borderDefault)) {
            Column(Modifier.padding(vertical = 16.dp).verticalScroll(rememberScrollState())) {
                Text(title, Modifier.padding(horizontal = 24.dp).semantics { heading() }, style = Claude.type.body17Strong)
                Spacer(Modifier.height(8.dp))
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, content = content)
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    ClaudeButton(stringResource(R.string.generic_button_cancel), onDismiss, variant = ButtonVariant.Secondary, size = ButtonSize.Small)
                    ClaudeButton(stringResource(R.string.generic_button_okay), onConfirm, size = ButtonSize.Small)
                }
            }
        }
    }
}

/** `scheduled_task_edit_date`: the day a one-time task runs; days before today cannot be picked. */
@Composable internal fun OnceDateDialog(at: Long, onPick: (Long) -> Unit, onDismiss: () -> Unit) {
    val today = LocalDate.now()
    val state = rememberDatePickerState(initialSelectedDateMillis = OnceMoment.pickerMillis(at), selectableDates = object : SelectableDates {
        override fun isSelectableDate(utcTimeMillis: Long) = !OnceMoment.dayOfPicker(utcTimeMillis).isBefore(today)
        override fun isSelectableYear(year: Int) = year >= today.year
    })
    PickerShell(stringResource(R.string.scheduled_task_edit_date), { state.selectedDateMillis?.let { onPick(OnceMoment.withDay(at, OnceMoment.dayOfPicker(it))) } ?: onDismiss() }, onDismiss) {
        DatePicker(state, showModeToggle = false)
    }
}

/** `routine_create_time_label`: the time of day a one-time task runs, in the phone's 12 or 24 hour style. */
@Composable internal fun OnceTimeDialog(at: Long, onPick: (Long) -> Unit, onDismiss: () -> Unit) {
    val zoned = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault())
    val state = rememberTimePickerState(zoned.hour, zoned.minute, android.text.format.DateFormat.is24HourFormat(LocalContext.current))
    PickerShell(stringResource(R.string.routine_create_time_label), { onPick(OnceMoment.withTime(at, state.hour, state.minute)) }, onDismiss) {
        TimePicker(state)
    }
}
