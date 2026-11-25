package com.claudex.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory

internal fun decodePreviewBitmap(bytes: ByteArray): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { UserText.get(R.string.generic_error_something_went_wrong_try_again) }
    var sample = 1
    while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error(UserText.get(R.string.generic_error_something_went_wrong_try_again))
}
