package com.claudex.mobile

import org.json.JSONObject

internal object ImageModelPolicy {
    fun valid(model: String) = model.length in 1..200 && model.matches(Regex("[A-Za-z0-9_.:/-]+"))
    fun choices(groups: JSONObject?) = groups?.optJSONObject("images")?.optJSONArray("models")?.objects().orEmpty()
        .filter { valid(it.optString("id")) }.take(200).distinctBy { it.optString("id") }
    fun requireOffered(groups: JSONObject, model: String) { require(valid(model) && choices(groups).any { it.optString("id") == model }) { UserText.get(R.string.generic_error_something_went_wrong_try_again) } }
}
