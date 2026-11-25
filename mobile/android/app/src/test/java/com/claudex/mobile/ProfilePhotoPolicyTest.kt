package com.claudex.mobile

import java.util.Base64
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfilePhotoPolicyTest {
    @Test fun aPngDataUrlOfTheSavedSizeIsKept() {
        val png = ByteArray(32) { 1 }
        val url = "data:image/png;base64,${Base64.getEncoder().encodeToString(png)}"
        assertTrue(ProfilePhotoPolicy.accepts(url))
    }

    @Test fun anythingElseIsNotAProfilePhoto() {
        assertFalse(ProfilePhotoPolicy.accepts(""))
        assertFalse(ProfilePhotoPolicy.accepts("data:image/jpeg;base64,YQ=="))
        assertFalse(ProfilePhotoPolicy.accepts("data:image/png;base64,not photo"))
        val huge = "data:image/png;base64,${Base64.getEncoder().encodeToString(ByteArray(ProfilePhotoPolicy.BYTE_LIMIT + 1))}"
        assertFalse(ProfilePhotoPolicy.accepts(huge))
    }
}
