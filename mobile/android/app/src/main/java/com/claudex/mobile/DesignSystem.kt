@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/*
 * Legacy helpers kept for the screens not yet rebuilt; they now draw with the official tokens
 * (Theme.kt) and components (DesignComponents.kt). New screens should use those directly.
 */

/** A group of rows: bg-000 card with 16 dp corners (settings group look). */
@Composable fun GroupCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), color = Claude.colors.bg000, contentColor = Claude.colors.text100,
        shape = Claude.shapes.card, tonalElevation = 0.dp) { Column(content = content) }
}
/** Rows in a group are 2 dp apart over the page colour. */
@Composable fun GroupDivider() { Box(Modifier.fillMaxWidth().height(2.dp).background(Claude.colors.bg100)) }
@Composable fun SearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    ClaudeSearchField(value, onValueChange, placeholder, modifier)
}
@Composable fun SheetHeader(title: String, dismiss: () -> Unit) { ClaudeSheetHeader(title, dismiss, Modifier.padding(bottom = 8.dp)) }
@Composable fun SerifTitle(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier, style = Claude.type.screenTitle, color = Claude.colors.text100)
}
