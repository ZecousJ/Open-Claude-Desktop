package com.claudex.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * The account's profile photo, saved with the other settings as a 256 px PNG data URL.
 * A photo that is not a PNG of that form, or that is larger than the settings limit, is not kept.
 */
object ProfilePhotoPolicy {
    const val EDGE = 256
    const val BYTE_LIMIT = 512 * 1024
    private val pattern = Regex("^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$")

    fun accepts(value: String): Boolean {
        if (value.length > 700_000 || !pattern.matches(value)) return false
        val bytes = runCatching { Base64.getDecoder().decode(value.substringAfter(',')) }.getOrNull() ?: return false
        return bytes.isNotEmpty() && bytes.size <= BYTE_LIMIT
    }

    /** Center-crops the image to a square and scales it to 256 px. Returns null when it is not a usable image. */
    fun encode(bytes: ByteArray): String? {
        if (bytes.isEmpty() || bytes.size > 50 * 1024 * 1024) return null
        val source = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        val side = minOf(source.width, source.height)
        if (side <= 0) return null
        val cropped = Bitmap.createBitmap(source, (source.width - side) / 2, (source.height - side) / 2, side, side)
        val scaled = if (side == EDGE) cropped else Bitmap.createScaledBitmap(cropped, EDGE, EDGE, true)
        val out = ByteArrayOutputStream()
        if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, out)) return null
        val png = out.toByteArray()
        if (png.isEmpty() || png.size > BYTE_LIMIT) return null
        return "data:image/png;base64,${Base64.getEncoder().encodeToString(png)}".takeIf(::accepts)
    }
}
