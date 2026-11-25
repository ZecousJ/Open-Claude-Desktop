package com.claudex.mobile

import com.claudex.core.Mode
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SecondRoundPresentationTest {
    private fun photo(name: String, mime: String, picker: Boolean, index: Int) = PhotoAttachmentName.display(name, mime, picker, index, "附件") { n, ext -> "图片 $n.$ext" }
    @Test fun capacityCodeMapsUserAndGlobalWhileOtherErrorsArePreserved() {
        assertEquals(R.string.claudex_msg_runs_limit, CapacityErrorPresentation.resource("CLAUDEX_WEB_CAPACITY", "synthetic", "user"))
        assertEquals(R.string.claudex_msg_runs_limit, CapacityErrorPresentation.resource("CLAUDEX_WEB_CAPACITY", "You already have as many runs going as your account allows. Wait for one to finish, then try again."))
        assertEquals(R.string.claudex_msg_service_busy, CapacityErrorPresentation.resource("CLAUDEX_WEB_CAPACITY", "synthetic", "global"))
        assertEquals("synthetic", CapacityErrorPresentation.message("OTHER", "synthetic", "user"))
    }
    @Test fun newModeAndProjectDraftsRemainDistinctWhileConversationIdentityStaysStable() {
        val drafts = mutableMapOf<String, String>()
        val chat = DraftScopePolicy.key(null, null, Mode.CHAT)
        val code = DraftScopePolicy.key(null, null, Mode.CODE)
        val cowork = DraftScopePolicy.key(null, null, Mode.COWORK)
        drafts[chat] = "failed synthetic Chat draft"; drafts[code] = "synthetic Code draft"; drafts[cowork] = "synthetic Cowork draft"
        assertEquals(3, drafts.size); assertEquals("failed synthetic Chat draft", drafts[DraftScopePolicy.key(null, null, Mode.CHAT)])
        assertNotEquals(chat, DraftScopePolicy.key(null, "project", Mode.CHAT))
        assertEquals("conversation", DraftScopePolicy.key("conversation", "project", Mode.CODE))
    }
    @Test fun firstLoadRecoveryFileAndRunningFallbackHaveDistinctPresentation() {
        assertTrue(ConversationLoadingPresentation.thinking(true, false, false))
        assertFalse(ConversationLoadingPresentation.thinking(true, true, false)); assertFalse(ConversationLoadingPresentation.thinking(true, false, true))
    }
    @Test fun emptyAndMalformedUsageWindowsDoNotProduceCards() {
        assertTrue(UsageWindowPresentation.visible(null).isEmpty())
        assertTrue(UsageWindowPresentation.visible(JSONObject("""{"windows":[{}, {"label":"invalid","percent":"unknown"}]}""")).isEmpty())
        assertEquals(1, UsageWindowPresentation.visible(JSONObject("""{"windows":[{"label":"synthetic","percent":0}]}""")).size)
    }
    @Test fun numericPhotoDisplayNameDoesNotReplaceKnownNamesOrDocumentNames() {
        assertEquals("图片 1.png", photo("1000000020.png", "image/png", true, 1))
        assertEquals("图片 2.jpg", photo("1000000021", "image/jpeg", true, 2))
        assertEquals("图片 3.png", photo("附件", "image/png", true, 3))
        assertEquals("holiday.png", photo("holiday.png", "image/png", true, 1))
        assertEquals("123.png", photo("123.png", "image/png", false, 1))
        assertEquals("123.pdf", photo("123.pdf", "application/pdf", true, 1))
    }
}
