// Native, per-review-session worker for Source Control lookahead. The extension sends a measured
// request followed by an explicit apply only while that same preview is still current. Never click,
// focus a list, select rows, leave the pointer moved, or read editor text to provide presentation scrolling.
import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, "AXChildren") as? [AXUIElement] ?? [] }
func text(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, "AXPosition"), let size = attribute(element, "AXSize"),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions), dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func descendants(_ root: AXUIElement, limit: Int = 6000, stopAtRows: Bool = false) -> [AXUIElement] {
    var queue = [root], result: [AXUIElement] = [], index = 0
    while index < queue.count && index < limit {
        let next = queue[index]; index += 1; result.append(next)
        if !stopAtRows || text(next, "AXRole") != "AXRow" { queue.append(contentsOf: children(next)) }
    }
    return result
}
func normalized(_ path: String) -> String { (path as NSString).expandingTildeInPath }
func resourcePath(_ row: AXUIElement, matching expected: String? = nil) -> String? {
    for node in descendants(row, limit: 180) {
        // The decoration tooltip appends more bullets (eyes/fire/explosion text) after Git's status.
        // Match the whole expected path plus its separator, not the last bullet or just the basename.
        // This also handles a real filename containing " • " without mistaking it for the status.
        let description = text(node, "AXDescription")
        if let expected, normalized(description).hasPrefix(expected + " • ") { return expected }
        if expected == nil, (description.hasPrefix("/") || description.hasPrefix("~/")), let separator = description.range(of: " • ") {
            return normalized(String(description[..<separator.lowerBound]))
        }
    }
    return nil
}
struct Measurement {
    let window: AXUIElement
    let outline: AXUIElement
    let row: AXUIElement
    let path: String
    let pane: CGRect
    let rowFrame: CGRect
    let top: Double
}
let pid = CommandLine.arguments.count > 1 ? Int32(CommandLine.arguments[1]) ?? 0 : 0
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.3)
var reason = "row-not-visible"
func scan(_ path: String) -> Measurement? {
    reason = AXIsProcessTrusted() ? "row-not-visible" : "accessibility-permission"
    guard pid > 0, AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let windowValue = attribute(app, "AXFocusedWindow"), CFGetTypeID(windowValue) == AXUIElementGetTypeID() else { return nil }
    let window = windowValue as! AXUIElement
    reason = "no-scm-outline"
    for outline in descendants(window, stopAtRows: true) where text(outline, "AXRole") == "AXOutline" && text(outline, "AXDescription") == "Source Control Management" {
        guard let pane = frame(outline) else { continue }
        let rows = descendants(outline, limit: 1200, stopAtRows: true).filter { text($0, "AXRole") == "AXRow" }
        let basename = (path as NSString).lastPathComponent
        let matches = rows.filter { text($0, "AXDescription").hasPrefix(basename + ",") && resourcePath($0, matching: path) != nil }
        // Ambiguous staged/unstaged duplicate rows must never scroll the wrong section.
        reason = "resource-match-\(matches.count)"
        guard matches.count == 1, let row = matches.first, let rowFrame = frame(row) else { continue }
        var top = pane.minY
        let headers = rows.filter { resourcePath($0) == nil }.compactMap(frame).sorted { $0.minY < $1.minY }
        for header in headers where header.minY <= top + 1 && header.maxY <= rowFrame.minY { top = max(top, header.maxY) }
        reason = "resource-offscreen"
        guard rowFrame.minY >= top, rowFrame.maxY <= pane.maxY else { continue }
        return Measurement(window: window, outline: outline, row: row, path: path, pane: pane, rowFrame: rowFrame, top: top)
    }
    return nil
}
// Electron hides renderer rows until an accessibility client requests them. Preserve both native
// switches: this Code build acknowledges AXManualAccessibility without changing it, but Chromium's
// AXEnhancedUserInterface switch exposes the rows. Read back the effect (not just AX's return code),
// and restore only switches this worker changed when the held review resets. No repeated toggles
// per file, screen-reader preference edits or permanent accessibility-mode change.
var ownedAccessibilitySwitches: [String] = []
var accessibilityDiagnostics: [String: String] = [:]
func resetAccessibility() {
    for key in ownedAccessibilitySwitches.reversed() { _ = AXUIElementSetAttributeValue(app, key as CFString, kCFBooleanFalse) }
    ownedAccessibilitySwitches.removeAll()
}
func measure(_ path: String) -> Measurement? {
    if let result = scan(path) { return result }
    guard reason == "no-scm-outline" else { return nil }
    for key in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        let prior = attribute(app, key) as? Bool
        accessibilityDiagnostics[key + "Before"] = String(describing: prior)
        guard prior == false else { continue }
        let setResult = AXUIElementSetAttributeValue(app, key as CFString, kCFBooleanTrue)
        accessibilityDiagnostics[key + "Set"] = String(setResult.rawValue)
        let after = attribute(app, key) as? Bool
        accessibilityDiagnostics[key + "After"] = String(describing: after)
        guard after == true else { continue }
        ownedAccessibilitySwitches.append(key)
        // Wait for actual row exposure, not a fixed settling pause. This worker is never awaited by input.
        let deadline = Date().addingTimeInterval(4)
        repeat {
            if let result = scan(path) { return result }
            if reason != "no-scm-outline" { break }
            CFRunLoopRunInMode(.defaultMode, 0.01, false)
        } while Date() < deadline
    }
    return nil
}
defer { resetAccessibility() }
func emit(_ response: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: response) { FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10])) }
}
var pending: (id: Int, measurement: Measurement)?
while let line = readLine() {
    guard line.utf8.count < 32768, let bytes = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let id = request["id"] as? Int, let action = request["action"] as? String else { break }
    if action == "state" { emit(["id": id, "ok": true, "manual": attribute(app, "AXManualAccessibility") as? Bool ?? false, "enhanced": attribute(app, "AXEnhancedUserInterface") as? Bool ?? false, "pointerX": CGEvent(source: nil)?.location.x ?? -1, "pointerY": CGEvent(source: nil)?.location.y ?? -1]); continue }
    if action == "reset" { pending = nil; resetAccessibility(); emit(["id": id, "ok": true]); continue }
    if action == "measure", let path = request["path"] as? String, path.hasPrefix("/") {
        pending = nil
        if let value = measure(path) {
            pending = (id, value)
            emit(["id": id, "ok": true, "top": value.top, "bottom": value.pane.maxY,
                  "rowTop": value.rowFrame.minY, "rowHeight": value.rowFrame.height])
        } else { emit(["id": id, "ok": false, "reason": reason, "diagnostics": accessibilityDiagnostics]) }
    } else if action == "apply", let saved = pending, saved.id == id, let distance = request["distance"] as? Double, let sensitivity = request["sensitivity"] as? Double {
        pending = nil
        // Re-read immediately before the one targeted event. Focus/geometry changes invalidate it;
        // the extension additionally checks the live held request before sending this apply message.
        let pixelDelta = distance / (1.25 * sensitivity)
        if distance.isFinite, sensitivity.isFinite, sensitivity > 0, pixelDelta.isFinite, pixelDelta >= 1, pixelDelta < Double(Int32.max), distance > 0, distance <= saved.measurement.pane.height,
           let current = measure(saved.measurement.path), CFEqual(current.window, saved.measurement.window),
           current.pane == saved.measurement.pane, current.rowFrame == saved.measurement.rowFrame,
           current.top == saved.measurement.top,
           let pointerState = CGEvent(source: nil),
           let source = CGEventSource(stateID: .privateState),
           let restorePointer = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                        mouseCursorPosition: pointerState.location, mouseButton: .left),
           let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1,
                               wheel1: -Int32(pixelDelta.rounded(.down)), wheel2: 0, wheel3: 0) {
            event.location = CGPoint(x: current.pane.midX, y: current.rowFrame.midY)
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            if let rect = frame(current.window), let window = windows.first(where: { item in
                guard item[kCGWindowOwnerPID as String] as? Int == Int(pid), let bounds = item[kCGWindowBounds as String] as? NSDictionary,
                      let actual = CGRect(dictionaryRepresentation: bounds) else { return false }
                return actual == rect
            }), let windowID = window[kCGWindowNumber as String] as? Int64,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: windowID)
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: windowID)
                // Monaco normalizes a pixel wheel by 40, then multiplies it by 50 and the list's
                // configured sensitivity. Match that conversion rather than over-scrolling by 25%.
                // A phase-bearing gesture passes through Agentic Mouse's physical-ratchet routing;
                // phase-free synthetic wheels would accidentally add files to its pending stage set.
                event.flags = []
                event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                event.setIntegerValueField(.scrollWheelEventScrollPhase, value: 1)
                event.setIntegerValueField(.eventSourceUserData, value: 0x42475653434D)
                event.post(tap: .cgSessionEventTap)
                if let end = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0) {
                    end.location = event.location; end.flags = []
                    end.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    end.setIntegerValueField(.scrollWheelEventScrollPhase, value: 4)
                    end.setIntegerValueField(.eventSourceUserData, value: 0x42475653434D)
                    end.post(tap: .cgSessionEventTap)
                }
                // Session wheel events update the global pointer location even with a private source;
                // a zero-delta end at the old location is ignored. Restore it in the SAME event sequence
                // (no waiting/warp) so the user's next click remains at their original location.
                restorePointer.flags = pointerState.flags
                restorePointer.post(tap: .cgSessionEventTap)
            } else { emit(["id": id, "ok": false]); continue }
            emit(["id": id, "ok": true, "applied": true])
        } else { emit(["id": id, "ok": false]) }
    } else { pending = nil; emit(["id": id, "ok": false]) }
}
