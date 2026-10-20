// Native Mac input bridge. No action is performed by compiling or probing it.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func failure(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
let arguments = CommandLine.arguments
guard arguments.count == 3, let data = arguments[2].data(using: .utf8),
      let values = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    failure("Choose a valid computer action.")
}
let operation = arguments[1]
if operation == "status" {
    let value: [String: Any] = ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    let result = try! JSONSerialization.data(withJSONObject: value)
    print(String(data: result, encoding: .utf8)!)
    exit(0)
}
if operation == "screenshot" {
    guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
        failure("Allow Strata in System Settings → Privacy & Security → Screen Recording, then try again.")
    }
    guard let path = values["path"] as? String else { failure("A screenshot destination is required.") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-m", "-t", "png", path]
    do { try process.run(); process.waitUntilExit() } catch { failure("The Mac could not capture its display.") }
    exit(process.terminationStatus)
}
guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
    failure("Allow Strata in System Settings → Privacy & Security → Accessibility, then try again.")
}
let source = CGEventSource(stateID: .privateState)
if operation == "click" {
    guard let x = values["x"] as? Double, let y = values["y"] as? Double,
          x.isFinite, y.isFinite, CGDisplayBounds(CGMainDisplayID()).contains(CGPoint(x: x, y: y)) else {
        failure("Choose a coordinate inside the Mac’s main display.")
    }
    let point = CGPoint(x: x, y: y)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
} else if operation == "type" {
    guard let text = values["text"] as? String, text.utf16.count <= 10000 else { failure("Type at most 10,000 characters at once.") }
    let units = Array(text.utf16)
    for offset in stride(from: 0, to: units.count, by: 128) {
        let part = Array(units[offset..<min(offset + 128, units.count)])
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { failure("The Mac could not create a keyboard event.") }
        part.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }
} else if operation == "key" {
    guard let key = values["key"] as? String else { failure("Choose a keyboard key.") }
    let parts = key.lowercased().split(separator: "+").map(String.init)
    let keys: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "a": 0, "c": 8, "v": 9, "x": 7, "l": 37, "s": 1, "z": 6, "w": 13, "q": 12, "r": 15, "t": 17, "f": 3]
    guard let last = parts.last, let code = keys[last] else { failure("This keyboard key is not supported. Use type for ordinary text.") }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier {
        case "command", "cmd", "meta": flags.insert(.maskCommand)
        case "control", "ctrl": flags.insert(.maskControl)
        case "option", "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: failure("This keyboard modifier is not supported.")
        }
    }
    for isDown in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: isDown) else { failure("The Mac could not create a keyboard event.") }
        event.flags = flags; event.post(tap: .cghidEventTap)
    }
} else { failure("This computer action is not supported.") }
print("Computer action completed.")
