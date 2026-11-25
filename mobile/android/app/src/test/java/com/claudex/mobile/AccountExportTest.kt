package com.claudex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountExportTest {
    @Test fun theDownloadNameIsTheServersZipName() {
        assertEquals("claudex-export-2026-11-21.zip", AccountExport.filename("attachment; filename=\"claudex-export-2026-11-21.zip\""))
        assertEquals("claudex-export.zip", AccountExport.filename("attachment; filename=\"../secret.txt\""))
        assertEquals("claudex-export.zip", AccountExport.filename(null))
    }

    @Test fun onlyAZipArchiveIsKept() {
        assertTrue(AccountExport.isZip(byteArrayOf(0x50, 0x4B, 0x03, 0x04), 4))
        assertFalse(AccountExport.isZip(byteArrayOf(0x7B, 0x22, 0x63, 0x6F), 4))
        assertFalse(AccountExport.isZip(byteArrayOf(0x50, 0x4B), 2))
    }
}
