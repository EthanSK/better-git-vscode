// Test-only native activation observer. Requires no Accessibility permission.
import AppKit
func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}
let observer = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
    if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        emit("\(app.bundleIdentifier ?? "unknown") \(app.processIdentifier)")
    }
}
emit("ready")
RunLoop.current.run()
