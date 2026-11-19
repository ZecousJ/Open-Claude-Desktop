# Local window recording and pointer-only evidence helper

The user explicitly authorized supplementary recording and hover tooling on 2026-09-22. Clicks, keyboard input, scrolling and conversation interactions still use `@oai/sky`. This executable only lists the selected app's windows, records one explicitly selected window, or moves the pointer within that window. It has no click, typing, browser inspection or network operations.

Build (macOS with Xcode command-line tools):

```sh
xcrun swiftc -swift-version 5 -parse-as-library scripts/fidelity/native/WindowEvidence.swift -o ../../work/fidelity/window-evidence
```

Use `list --bundle com.anthropic.claudefordesktop`, then explicitly pass the returned ID. Only record our own investigation conversation with history hidden. `record --window-id ID --duration 15 --scale 1 --output /absolute/new-file.mov` records the window via ScreenCaptureKit, without audio or cursor. Native display scale is the default; `--scale 1` reduces encoding load for motion analysis. Screenshots and pixel comparison must account for that scale. Existing recordings are never overwritten. `hover --window-id ID --x X --y Y` uses window-relative logical coordinates and emits only mouseMoved.

Start recording and dispatch the Sky actions in the same orchestration call, so model/tool latency does not consume the recording interval. Metadata preserves original source PTS, written frame timestamps, encoder drops and callback status counts. The requested 60Hz interval is a maximum sampling request, **not a guarantee of 60 unique frames per second**. Idle frames may not be supplied. Recordings with temporal gaps during an event cannot establish fine animation timing. Capture permissions are managed by macOS. The recording indicator may appear in the window chrome; exclude it from component comparisons and document the excluded region.

The initial command-toggle-001 attempt failed to initialize CoreGraphics before AppKit. command-toggle-002 completed at native scale with three encoder drops. command-toggle-003 and 004 completed at logical scale with zero encoder drops but variable frame intervals. They do not establish a globally constant 60fps capture.

`--crop x,y,width,height` records a bounded region within the selected window (logical points), reducing encoder load; the crop is preserved in metadata. Pointer events now log host-clock timestamps. Hover uses CGWindowListCopyWindowInfo plus owning-process bundle validation and does not query ScreenCaptureKit while recording is active. The 2026-09-22 concurrent-hover regression scenario completed without a stream interruption after this isolation.

For a local Electron control whose independent-window stream does not overlap the action interval, `record-composited --bundle com.github.Electron --window-id ID --crop x,y,width,height --duration 45 --scale 2 --output /absolute/new-file.mov` records only that selected Claudex window through a display-backed filter. The selected Claudex app must be frontmost; the crop is mandatory and must fit within its window. This mode rejects Claude and other bundle IDs. The metadata records both the window-relative crop and display source rectangle. Do not infer that a recording contains a transition from AX alone: inspect sampled frames and verify the event actually appears within the captured timestamps. Close Computer Use promptly after the UI actions even while a longer local recorder finishes.
