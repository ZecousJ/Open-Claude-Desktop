@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/*
 * The chat connector tool's approval sheet and the fields of a
 * tool's form (MCP elicitation). The reading of the request is [ConnectorToolApproval]; the rules and the answer
 * of a form are [ElicitationForm]'s (the web card's, `src/approval/elicitation-form.ts`).
 */

/** The sentence on one line (for the waiting row): "Claude wants to use <tool> from <connector>". */
@Composable internal fun connectorToolSummary(tool: ConnectorToolApproval): String {
    val name = tool.toolName; val connector = tool.connectorName
    val lead = stringResource(R.string.tool_approval_sentence_lead)
    return when {
        name != null && connector != null -> "$lead " + stringResource(R.string.tool_approval_sentence_tool_from_connector_line, name, connector)
        connector != null -> "$lead " + stringResource(R.string.tool_approval_sentence_connector_line, connector)
        name != null -> "$lead $name"
        else -> stringResource(R.string.tool_approval_sentence_generic)
    }
}

/** The row that opens the connector tool's sheet again once it was dismissed (the official "Waiting for you"). */
@Composable internal fun ConnectorToolWaitingRow(tool: ConnectorToolApproval, modifier: Modifier = Modifier, open: () -> Unit) {
    val c = Claude.colors
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).clip(Claude.shapes.r24).background(c.bg000).border(1.dp, c.border300, Claude.shapes.r24)
        .clickable(role = Role.Button, onClick = open).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(AppGlyphs.connector, null, Modifier.size(20.dp), tint = c.text300)
        Column(Modifier.weight(1f)) {
            Text(connectorToolSummary(tool), style = Claude.type.body15, color = c.text100, maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            Text(stringResource(R.string.chat_step_waiting_for_you_mark), style = Claude.type.body13, color = c.text300)
        }
        Icon(AppGlyphs.caretRight, null, Modifier.size(16.dp), tint = c.text500)
    }
}

/** The client policy's switch for the session grant (`approvalsAlwaysAllow`), read once per process from the runner; null until it is. */
internal object ApprovalPolicyCache { @Volatile var alwaysAllow: Boolean? = null }

@Composable internal fun rememberApprovalsAlwaysAllow(vm: AppViewModel): Boolean? {
    var allowed by remember { mutableStateOf(ApprovalPolicyCache.alwaysAllow) }
    LaunchedEffect(vm) {
        val repo = vm.repository as? RemoteRepository ?: return@LaunchedEffect
        val policy = runCatching { repo.rpc("clientPolicy") as? org.json.JSONObject }.getOrNull() ?: return@LaunchedEffect
        if (policy.has("approvalsAlwaysAllow")) { allowed = policy.optBoolean("approvalsAlwaysAllow", true); ApprovalPolicyCache.alwaysAllow = allowed }
    }
    return allowed
}

/**
 * Title "Permission request"; a 48 dp connector tile and the sentence "Claude wants to use / <tool> from <connector>"
 * centred; a "Show details" row that opens "Request details" (the call's parameters as a table) with "From
 * <connector> · via a connector" and the third-party disclaimer; then "Review each action carefully before
 * approving." over the choices: Always allow (where Codex offers it and the administrator allows it), Allow once
 * (the default, Primary) and Decline.
 */
@Composable internal fun ConnectorToolSheet(tool: ConnectorToolApproval, busy: Boolean, failure: String?, onDismiss: () -> Unit, answer: (ApprovalAnswer) -> Unit) {
    val c = Claude.colors
    var details by remember { mutableStateOf(false) }
    ClaudeModalBottomSheet(onDismissRequest = onDismiss) {
        ClaudeSheetHeader(stringResource(R.string.mobile_app_use_tool_approval_sheet_title), onDismiss)
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(Modifier.size(48.dp).clip(Claude.shapes.r12).background(c.bg200), contentAlignment = Alignment.Center) {
                Icon(AppGlyphs.connector, null, Modifier.size(24.dp), tint = c.text100)
            }
            val name = tool.toolName; val connector = tool.connectorName
            if (name == null && connector == null) {
                Text(stringResource(R.string.tool_approval_sentence_generic), style = Claude.type.body17Long, color = c.text100, textAlign = TextAlign.Center)
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.tool_approval_sentence_lead), style = Claude.type.body17Long, color = c.text100, textAlign = TextAlign.Center)
                    val line = when {
                        name != null && connector != null -> stringResource(R.string.tool_approval_sentence_tool_from_connector_line, name, connector)
                        connector != null -> stringResource(R.string.tool_approval_sentence_connector_line, connector)
                        else -> name.orEmpty()
                    }
                    Text(buildAnnotatedString {
                        append(line)
                        listOfNotNull(name, connector).forEach { part ->
                            val start = line.indexOf(part)
                            if (start >= 0) addStyle(SpanStyle(color = c.text100, fontWeight = FontWeight(550)), start, start + part.length)
                        }
                    }, style = Claude.type.body17Long, color = c.text300, textAlign = TextAlign.Center)
                }
            }
            Row(Modifier.heightIn(min = 48.dp).clip(Claude.shapes.r6).clickable(role = Role.Button) { details = !details }.padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(if (details) R.string.tool_approval_hide_details else R.string.tool_approval_show_details), style = Claude.type.body15, color = c.text300)
                Icon(if (details) AppGlyphs.caretUp else AppGlyphs.caretDown, null, Modifier.size(16.dp), tint = c.text300)
            }
            if (details) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.tool_approval_details_title), style = Claude.type.body15Strong, color = c.text100)
                if (tool.rows.isEmpty()) Text(stringResource(R.string.tool_approval_details_unavailable), style = Claude.type.body13, color = c.text300)
                else {
                    Column(Modifier.fillMaxWidth().clip(Claude.shapes.r12).background(c.bg000).border(1.dp, c.border300, Claude.shapes.r12)) {
                        tool.rows.forEachIndexed { index, row ->
                            if (index > 0) ClaudeDivider(Modifier.padding(horizontal = 16.dp))
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                                Text(row.label, style = Claude.type.body13, color = c.text300)
                                Text(row.value.ifEmpty { stringResource(R.string.tool_approval_table_empty_value) }, style = Claude.type.body15, color = c.text100)
                            }
                        }
                    }
                    if (tool.rows.any { it.value.endsWith("…") }) Text(stringResource(R.string.tool_approval_details_shown_in_part), style = Claude.type.body13, color = c.text300)
                }
            }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(connector?.let { stringResource(R.string.tool_approval_attribution_named, it) } ?: stringResource(R.string.tool_approval_attribution_unnamed),
                    style = Claude.type.body13, color = c.text300, textAlign = TextAlign.Center)
                Text(stringResource(R.string.tool_approval_disclaimer_subtitle), style = Claude.type.body13, color = c.text300, textAlign = TextAlign.Center)
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            failure?.let { NoticeCard(it, icon = AppGlyphs.warningCircle) }
            Text(stringResource(R.string.tool_approval_disclaimer_title), style = Claude.type.body13, color = c.text300, textAlign = TextAlign.Center)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                tool.alwaysScope?.let { scope ->
                    ClaudeButton(stringResource(if (scope == "always") R.string.tool_approval_button_always_allow else R.string.tool_approval_button_allow_for_session),
                        { answer(ApprovalAnswer.Always) }, variant = ButtonVariant.Secondary, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy)
                }
                ClaudeButton(stringResource(R.string.tool_approval_button_allow_once), { answer(ApprovalAnswer.Once) }, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy, loading = busy)
                ClaudeButton(stringResource(R.string.tool_approval_button_decline), { answer(ApprovalAnswer.Deny) }, variant = ButtonVariant.Secondary, size = ButtonSize.MediumLarge, fillWidth = true, enabled = !busy)
            }
        }
    }
}

/** The sentence under a form for its first problem, in the phone's language (the web's wording in English). */
@Composable internal fun elicitationProblemText(problem: ElicitationForm.Problem): String = when (problem) {
    is ElicitationForm.Problem.Required -> stringResource(R.string.claudex_form_problem_required, problem.label)
    is ElicitationForm.Problem.ChooseOne -> stringResource(R.string.claudex_form_problem_choose_one, problem.label)
    is ElicitationForm.Problem.Number -> stringResource(R.string.claudex_form_problem_number, problem.label)
    is ElicitationForm.Problem.Integer -> stringResource(R.string.claudex_form_problem_integer, problem.label)
    is ElicitationForm.Problem.Minimum -> stringResource(R.string.claudex_form_problem_minimum, problem.label, ElicitationForm.format(problem.limit))
    is ElicitationForm.Problem.Maximum -> stringResource(R.string.claudex_form_problem_maximum, problem.label, ElicitationForm.format(problem.limit))
    is ElicitationForm.Problem.MinLength -> stringResource(R.string.claudex_form_problem_min_length, problem.label, problem.limit.toString())
    is ElicitationForm.Problem.MaxLength -> stringResource(R.string.claudex_form_problem_max_length, problem.label, problem.limit.toString())
    is ElicitationForm.Problem.Email -> stringResource(R.string.claudex_form_problem_email, problem.label)
    is ElicitationForm.Problem.Uri -> stringResource(R.string.claudex_form_problem_uri, problem.label)
    is ElicitationForm.Problem.DateTime -> stringResource(R.string.claudex_form_problem_date_time, problem.label)
}

/**
 * The fields of a tool's form: text, number, switch, a menu for one choice and checkboxes for several, a `*` on
 * required ones; the first problem reads under the fields.
 */
@Composable internal fun ElicitationFormFields(fields: List<ElicitationForm.Field>, values: MutableMap<String, ElicitationForm.Value>,
    problem: ElicitationForm.Problem?, enabled: Boolean, edited: () -> Unit) {
    val c = Claude.colors
    val requiredLabel = stringResource(R.string.claudex_form_required_label)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        fields.forEach { field ->
            val current = values[field.name] ?: field.initial
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (field.type != ElicitationForm.FieldType.Boolean) Row {
                    Text(field.label, style = Claude.type.body15Strong, color = c.text100)
                    if (field.required) Text(" *", Modifier.semantics { contentDescription = requiredLabel }, style = Claude.type.body15Strong, color = c.text300)
                }
                field.description?.takeIf { it.isNotBlank() }?.let { Text(it, style = Claude.type.body13, color = c.text300) }
                when (field.type) {
                    ElicitationForm.FieldType.Boolean -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(Modifier.weight(1f)) {
                            Text(field.label, style = Claude.type.body15, color = c.text100)
                            if (field.required) Text(" *", Modifier.semantics { contentDescription = requiredLabel }, style = Claude.type.body15, color = c.text300)
                        }
                        ClaudeSwitch((current as? ElicitationForm.Value.Flag)?.value ?: false, { values[field.name] = ElicitationForm.Value.Flag(it); edited() }, enabled = enabled)
                    }
                    ElicitationForm.FieldType.Choice -> ChoiceMenu(field, (current as? ElicitationForm.Value.Text)?.value.orEmpty(), enabled) { values[field.name] = ElicitationForm.Value.Text(it); edited() }
                    ElicitationForm.FieldType.Multi -> Column(Modifier.fillMaxWidth()) {
                        val chosen = (current as? ElicitationForm.Value.Items)?.value.orEmpty()
                        field.options.forEach { option ->
                            val on = option.value in chosen
                            val toggle = { values[field.name] = ElicitationForm.Value.Items(if (on) chosen - option.value else chosen + option.value); edited() }
                            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = enabled, role = Role.Checkbox, onClick = toggle).semantics { selected = on },
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                ClaudeCheckbox(on, null, enabled = enabled)
                                Text(option.label, Modifier.weight(1f), style = Claude.type.body15, color = c.text100)
                            }
                        }
                    }
                    else -> ClaudeTextField((current as? ElicitationForm.Value.Text)?.value.orEmpty(), { values[field.name] = ElicitationForm.Value.Text(it); edited() },
                        Modifier.fillMaxWidth(), shape = Claude.shapes.field, enabled = enabled,
                        keyboardOptions = KeyboardOptions(keyboardType = when {
                            field.type == ElicitationForm.FieldType.Number || field.type == ElicitationForm.FieldType.Integer -> KeyboardType.Decimal
                            field.format == "email" -> KeyboardType.Email
                            field.format == "uri" -> KeyboardType.Uri
                            else -> KeyboardType.Text
                        }))
                }
            }
        }
        problem?.let { Text(elicitationProblemText(it), style = Claude.type.body13, color = c.dangerText) }
    }
}

/** One choice: a field that opens a menu with the choices (and "None" for an optional field), "Choose…" until one is picked. */
@Composable private fun ChoiceMenu(field: ElicitationForm.Field, current: String, enabled: Boolean, pick: (String) -> Unit) {
    val c = Claude.colors
    var open by remember { mutableStateOf(false) }
    val shown = field.options.firstOrNull { it.value == current }?.label
    Box(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 54.dp).clip(Claude.shapes.field).background(c.bg300).clickable(enabled = enabled, role = Role.DropdownList) { open = true }.padding(horizontal = 16.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(shown ?: stringResource(R.string.claudex_form_choose), Modifier.weight(1f), style = Claude.type.body15, color = if (shown == null) c.text500 else c.text100)
            Icon(AppGlyphs.caretUpCaretDown, null, Modifier.size(16.dp), tint = c.text300)
        }
        DropdownMenu(open, { open = false }) {
            if (!field.required) DropdownMenuItem({ Text(stringResource(R.string.claudex_form_none), style = Claude.type.body15) }, { pick(""); open = false })
            field.options.forEach { option -> DropdownMenuItem({ Text(option.label, style = Claude.type.body15) }, { pick(option.value); open = false }) }
        }
    }
}
