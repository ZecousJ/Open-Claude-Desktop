package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ComposerFeaturePolicyTest {
    @Test fun newChatIsSentWithSearchAndResearchOffAndExistingConversationKeepsItsOwn() {
        assertTrue(ComposerFeaturePolicy.incognito("""{"incognito":true}"""))
        assertFalse(ComposerFeaturePolicy.incognito(null))
        val existing = ComposerFeaturePolicy.newSendPayload(JSONObject(), "existing", ComposerFeatures(true, true))
        assertFalse(existing.has("webSearch")); assertFalse(existing.has("research"))
        val fresh = ComposerFeaturePolicy.newSendPayload(JSONObject(), null, ComposerFeatures())
        assertFalse(fresh.getBoolean("webSearch")); assertFalse(fresh.getBoolean("research"))
    }
}
