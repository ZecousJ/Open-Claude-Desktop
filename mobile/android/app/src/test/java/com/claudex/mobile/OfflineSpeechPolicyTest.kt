package com.claudex.mobile

import kotlin.test.*
import org.junit.Test

class OfflineSpeechPolicyTest {
    private val installed = OfflineSpeechVoice("offline-en", "en-US", false, true)
    private val chinese = OfflineSpeechVoice("offline-zh", "zh-CN", false, true)
    private val network = OfflineSpeechVoice("network-en", "en-US", true, true)
    private val missing = OfflineSpeechVoice("missing-en", "en-US", false, false)
    @Test fun onlyInstalledOfflineVoicesAreExposed() {
        assertEquals(listOf(installed, chinese), OfflineSpeechPolicy.voices(listOf(network, installed, missing, installed, chinese)))
        assertEquals(64, OfflineSpeechPolicy.voices((1..80).map { installed.copy(id = "voice-$it") }).size)
    }
    @Test fun explicitSelectionNeverFallsBackToNetworkOrAnotherVoice() {
        val values = listOf(network, missing, installed, chinese)
        assertNull(OfflineSpeechPolicy.choose(values, "network-en", "en-US"))
        assertNull(OfflineSpeechPolicy.choose(values, "missing-en", "en-US"))
        assertEquals("offline-en", OfflineSpeechPolicy.choose(values, "offline-en", "zh-CN"))
        assertEquals("offline-zh", OfflineSpeechPolicy.choose(values, "", "zh-TW"))
        assertNull(OfflineSpeechPolicy.choose(values, "", "fr-FR"))
    }
    @Test fun utterancesAreBoundedAndFinite() {
        assertTrue(OfflineSpeechPolicy.valid("speech-1", "hello", 1.2))
        assertFalse(OfflineSpeechPolicy.valid("arbitrary", "hello", 1.0))
        assertFalse(OfflineSpeechPolicy.valid("speech-1", " ", 1.0))
        assertFalse(OfflineSpeechPolicy.valid("speech-1", "x".repeat(1001), 1.0))
        assertFalse(OfflineSpeechPolicy.valid("speech-1", "hello", Double.NaN))
        assertFalse(OfflineSpeechPolicy.valid("speech-1", "hello", 5.0))
    }
}
