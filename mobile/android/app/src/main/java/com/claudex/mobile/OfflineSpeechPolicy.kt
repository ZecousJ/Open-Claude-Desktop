package com.claudex.mobile

internal data class OfflineSpeechVoice(val id: String, val language: String, val network: Boolean, val installed: Boolean)
internal object OfflineSpeechPolicy {
    const val MAX_TEXT = 1000
    fun voices(values: List<OfflineSpeechVoice>) = values.filter { !it.network && it.installed && it.id.length in 1..256 }.distinctBy { it.id }.take(64)
    fun choose(values: List<OfflineSpeechVoice>, requested: String, language: String): String? {
        val offline = voices(values)
        if (requested.isNotEmpty()) return offline.firstOrNull { it.id == requested }?.id
        val primary = language.substringBefore('-').lowercase()
        if (primary.isEmpty()) return offline.firstOrNull()?.id
        return offline.firstOrNull { it.language.equals(language, true) }?.id
            ?: offline.firstOrNull { it.language.substringBefore('-').lowercase() == primary }?.id
    }
    fun valid(id: String, text: String, rate: Double) = id.matches(Regex("speech-[1-9][0-9]{0,15}")) &&
        text.length in 1..MAX_TEXT && text.isNotBlank() && rate.isFinite() && rate in 0.5..2.0
}
