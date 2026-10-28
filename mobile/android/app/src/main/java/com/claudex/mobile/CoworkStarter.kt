package com.claudex.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Cowork's first-use page: shown in place of the task list until "Get started"
 * is tapped once. A scrolling column with 32 dp sides: a 137 dp hero, 24 dp
 * below it the serif 28 title, 24 dp, three benefit rows (24 dp glyph, 16 dp gap, 15/400 text) spaced 24 dp; the
 * full-width button sits at the bottom, 16 dp from the edges, at most 580 dp wide. The hero is
 * the Claudex mark on a neutral panel.
 */
@Composable fun CoworkStarterPage(onStart: () -> Unit) {
    val c = Claude.colors
    OfficialPage(stringResource(R.string.cowork_starter_title)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Column(Modifier.align(Alignment.TopCenter).widthIn(max = 580.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 32.dp, end = 32.dp, top = 12.dp, bottom = 96.dp)) {
                Box(Modifier.fillMaxWidth().height(137.dp).clip(Claude.shapes.card).background(c.bg300), contentAlignment = Alignment.Center) { ClaudexMark(56.dp) }
                Spacer(Modifier.height(24.dp))
                Text(stringResource(R.string.cowork_starter_title), style = Claude.type.serif28, color = c.text100)
                Spacer(Modifier.height(24.dp))
                Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
                    StarterBenefit(AppGlyphs.mobilePhone, stringResource(R.string.cowork_starter_benefit_start_from_phone))
                    StarterBenefit(AppGlyphs.computer, stringResource(R.string.cowork_starter_benefit_check_in_anywhere))
                    StarterBenefit(AppGlyphs.lightning, stringResource(R.string.cowork_starter_benefit_works_in_background))
                }
            }
            ClaudeButton(stringResource(R.string.cowork_starter_get_started), onStart, Modifier.align(Alignment.BottomCenter).widthIn(max = 580.dp).fillMaxWidth().padding(16.dp).navigationBarsPadding(),
                size = ButtonSize.Large, fillWidth = true)
        }
    }
}

/** Row(spacedBy 16, centred) { glyph 24 dp in text-300, text 15/400 in text-300 }. */
@Composable private fun StarterBenefit(icon: ImageVector, text: String) {
    val c = Claude.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(24.dp), tint = c.text300)
        Text(text, Modifier.weight(1f), style = Claude.type.body15, color = c.text300)
    }
}
