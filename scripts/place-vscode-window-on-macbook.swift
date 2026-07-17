import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let targetDisplayName = "Built-in Retina Display"

guard CommandLine.arguments.count == 2, let targetPID = pid_t(CommandLine.arguments[1]) else {
  fputs("usage: swift place-vscode-window-on-macbook.swift <pid>\n", stderr)
  exit(2)
}

guard AXIsProcessTrusted() else {
  fputs("Accessibility permission is required to place the isolated VS Code window.\n", stderr)
  exit(3)
}

let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
let displays = NSScreen.screens.map { screen in
  let frame = screen.frame
  return (
    name: screen.localizedName,
    frame: CGRect(
      x: frame.minX,
      y: primaryTop - frame.maxY,
      width: frame.width,
      height: frame.height
    )
  )
}

guard let targetDisplay = displays.first(where: { $0.name == targetDisplayName }) else {
  fputs("Could not find display named \(targetDisplayName).\n", stderr)
  exit(4)
}

func copyAXWindows(_ application: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
        let windows = value as? [AXUIElement] else {
    return []
  }
  return windows
}

func setAXPoint(_ window: AXUIElement, attribute: CFString, point: CGPoint) -> Bool {
  var mutablePoint = point
  guard let value = AXValueCreate(.cgPoint, &mutablePoint) else { return false }
  return AXUIElementSetAttributeValue(window, attribute, value) == .success
}

func setAXSize(_ window: AXUIElement, size: CGSize) -> Bool {
  var mutableSize = size
  guard let value = AXValueCreate(.cgSize, &mutableSize) else { return false }
  return AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) == .success
}

func substantialCGWindows() -> [[String: Any]] {
  let all = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
  ) as? [[String: Any]] ?? []
  return all.filter { window in
    guard (window[kCGWindowOwnerPID as String] as? Int) == Int(targetPID),
          (window[kCGWindowLayer as String] as? Int) == 0,
          let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
          let width = bounds["Width"], let height = bounds["Height"] else {
      return false
    }
    return width >= 300 && height >= 200
  }
}

let application = AXUIElementCreateApplication(targetPID)
let deadline = Date().addingTimeInterval(12)
var candidate: AXUIElement?
while Date() < deadline {
  candidate = copyAXWindows(application).first
  if candidate != nil { break }
  Thread.sleep(forTimeInterval: 0.1)
}

guard let testWindow = candidate else {
  fputs("No Accessibility window appeared for isolated VS Code PID \(targetPID).\n", stderr)
  exit(5)
}

let margin: CGFloat = 48
let desiredFrame = CGRect(
  x: targetDisplay.frame.minX + margin,
  y: targetDisplay.frame.minY + margin,
  width: min(1500, targetDisplay.frame.width - margin * 2),
  height: min(1100, targetDisplay.frame.height - margin * 2)
)

guard setAXPoint(testWindow, attribute: kAXPositionAttribute as CFString, point: desiredFrame.origin),
      setAXSize(testWindow, size: desiredFrame.size) else {
  fputs("Could not move/resize the isolated VS Code window for PID \(targetPID).\n", stderr)
  exit(6)
}

Thread.sleep(forTimeInterval: 0.35)
guard let verified = substantialCGWindows().first(where: { window in
  guard let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
        let x = bounds["X"], let y = bounds["Y"],
        let width = bounds["Width"], let height = bounds["Height"] else {
    return false
  }
  return targetDisplay.frame.contains(CGPoint(x: x + width / 2, y: y + height / 2))
}) else {
  fputs("Isolated VS Code PID \(targetPID) was not verified on \(targetDisplayName).\n", stderr)
  exit(7)
}

let bounds = verified[kCGWindowBounds as String] as! [String: CGFloat]
let windowID = verified[kCGWindowNumber as String] as? Int ?? -1
let title = verified[kCGWindowName as String] as? String ?? ""
print("window=\(windowID)")
print("pid=\(targetPID)")
print("display=\(targetDisplayName)")
print(
  "bounds=\(Int(bounds["X"]!)),\(Int(bounds["Y"]!)),"
    + "\(Int(bounds["Width"]!)),\(Int(bounds["Height"]!))"
)
print("title=\(title)")
