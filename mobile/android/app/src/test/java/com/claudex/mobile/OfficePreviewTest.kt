package com.claudex.mobile

import org.junit.Assert.*
import org.junit.Test

class OfficePreviewTest {
    @Test fun wordAndSpreadsheetsStopAtTheOfficialSize() {
        assertFalse(officePreviewTooLarge("notes.docx", 10_485_760))
        assertTrue(officePreviewTooLarge("notes.docx", 10_485_761))
        assertFalse(officePreviewTooLarge("sheet.csv", 31_457_280))
        assertTrue(officePreviewTooLarge("sheet.xlsx", 31_457_281))
        assertTrue(officePreviewTooLarge("legacy.xls", 31_457_281))
        assertFalse(officePreviewTooLarge("photo.png", 40_000_000))
    }
}
