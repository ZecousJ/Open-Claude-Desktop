package com.claudex.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationTextScaleTest {
    @Test fun transcriptTextFollowsSystemFontScale() {
        assertEquals(100, ConversationTextScale.zoom(1f))
        assertEquals(130, ConversationTextScale.zoom(1.3f))
        assertEquals(200, ConversationTextScale.zoom(2f))
        assertEquals(80, ConversationTextScale.zoom(0.5f))
        assertEquals(300, ConversationTextScale.zoom(4f))
        assertEquals(100, ConversationTextScale.zoom(Float.NaN))
    }
}
