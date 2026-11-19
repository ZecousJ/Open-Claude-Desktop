!macro customFiles_x64
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 claudexExtractFailed
  IfFileExists "$INSTDIR\resources\app.asar" 0 claudexExtractFailed
  IfFileExists "$INSTDIR\resources\codex\bin\codex.exe" claudexExtracted claudexExtractFailed

  claudexExtractFailed:
    MessageBox MB_OK|MB_ICONSTOP "$(decompressionFailed)$\r$\n$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Quit

  claudexExtracted:
!macroend
