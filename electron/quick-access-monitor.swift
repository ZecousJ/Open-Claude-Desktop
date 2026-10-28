import AppKit

// optionDoubleTapped.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
var pressed = false
var chord = false
var began = 0.0
var previous = 0.0
var capsLock = NSEvent.modifierFlags.contains(.capsLock)
func observe(_ event: NSEvent) {
    if event.type == .keyDown { chord = true; previous = 0; return }
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let caps = flags.contains(.capsLock)
    if caps != capsLock {
        capsLock = caps
        print(caps ? "dictation-start" : "dictation-stop")
        fflush(stdout)
    }
    let option = flags.contains(.option)
    if !flags.intersection([.command, .control, .shift]).isEmpty { chord = true; previous = 0 }
    if option && !pressed {
        began = event.timestamp
        chord = !flags.intersection([.command, .control, .shift]).isEmpty
    } else if !option && pressed {
        if !chord && event.timestamp - began < 0.6 {
            if previous > 0 && event.timestamp - previous < 0.6 {
                print("toggle")
                fflush(stdout)
                previous = 0
            } else { previous = event.timestamp }
        } else { previous = 0 }
    }
    pressed = option
}
let global = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown], handler: observe)
let local = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
    observe(event)
    return event
}
application.run()
