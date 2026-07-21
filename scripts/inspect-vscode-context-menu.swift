import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Bounds: Codable {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

struct MenuProbe: Codable {
  let pid: Int32
  let view: String
  let row: String
  let windowID: Int
  let windowTitle: String
  let popupWindowID: Int
  let popupBounds: Bounds
  let items: [String]
}

struct RowProbe: Codable {
  let title: String
  let description: String
  let value: String
}

func fail(_ message: String, code: Int32) -> Never {
  fputs("\(message)\n", stderr)
  exit(code)
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return "" }
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  return ""
}

func elementArrayAttribute(_ element: AXUIElement, _ attribute: CFString) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let items = value as? [AXUIElement] else { return [] }
  return items
}

func descendants(_ root: AXUIElement, limit: Int = 30_000) -> [AXUIElement] {
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var result: [AXUIElement] = []
  var index = 0
  while index < queue.count, result.count < limit {
    let (element, depth) = queue[index]
    index += 1
    result.append(element)
    guard depth < 40 else { continue }
    let nested = elementArrayAttribute(element, kAXChildrenAttribute as CFString)
      + elementArrayAttribute(element, kAXRowsAttribute as CFString)
    queue.append(contentsOf: nested.map { ($0, depth + 1) })
  }
  return result
}

func findElement(
  in root: AXUIElement,
  role expectedRole: String,
  exactText: String,
  timeout: TimeInterval
) -> AXUIElement? {
  let deadline = Date().addingTimeInterval(timeout)
  repeat {
    for element in descendants(root) {
      guard stringAttribute(element, kAXRoleAttribute as CFString) == expectedRole else { continue }
      let texts = [
        stringAttribute(element, kAXTitleAttribute as CFString),
        stringAttribute(element, kAXDescriptionAttribute as CFString),
        stringAttribute(element, kAXValueAttribute as CFString),
      ]
      if texts.contains(exactText) { return element }
    }
    Thread.sleep(forTimeInterval: 0.1)
  } while Date() < deadline
  return nil
}

func cgWindows(for pid: pid_t) -> [[String: Any]] {
  let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
  ) as? [[String: Any]] ?? []
  return windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) }
}

func bounds(of window: [String: Any]) -> Bounds? {
  guard let raw = window[kCGWindowBounds as String] as? [String: CGFloat],
        let x = raw["X"], let y = raw["Y"],
        let width = raw["Width"], let height = raw["Height"] else { return nil }
  return Bounds(x: Int(x), y: Int(y), width: Int(width), height: Int(height))
}

func sendEscape(to pid: pid_t) {
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false) else {
    fail("Could not create process-targeted Escape events", code: 20)
  }
  down.postToPid(pid)
  up.postToPid(pid)
  Thread.sleep(forTimeInterval: 0.15)
}

guard AXIsProcessTrusted() else {
  fail("Accessibility permission is required to inspect the isolated VS Code context menu", code: 3)
}

guard CommandLine.arguments.count >= 3,
      let pid = pid_t(CommandLine.arguments[2]) else {
  fail(
    "usage: swift inspect-vscode-context-menu.swift cancel <pid> | list-rows <pid> <source-control|explorer> | show <pid> <source-control|explorer> <row-description>",
    code: 2
  )
}

let operation = CommandLine.arguments[1]
if operation == "cancel" {
  sendEscape(to: pid)
  print("cancelled pid=\(pid)")
  exit(0)
}

guard (operation == "show" && CommandLine.arguments.count == 5)
        || (operation == "list-rows" && CommandLine.arguments.count == 4) else {
  fail("expected show <pid> <view> <row-description> or list-rows <pid> <view>", code: 2)
}

let view = CommandLine.arguments[3]
let rowDescription = operation == "show" ? CommandLine.arguments[4] : ""
let viewTitle: String
switch view {
case "source-control": viewTitle = "Source Control"
case "explorer": viewTitle = "Explorer"
default: fail("Unsupported view: \(view)", code: 2)
}

guard let runningApplication = NSRunningApplication(processIdentifier: pid) else {
  fail("VS Code process \(pid) is not running", code: 4)
}
let application = AXUIElementCreateApplication(pid)
guard let testWindow = elementArrayAttribute(application, kAXWindowsAttribute as CFString).first else {
  fail("No Accessibility window found for VS Code process \(pid)", code: 5)
}
_ = runningApplication.activate(options: [])
guard AXUIElementPerformAction(testWindow, kAXRaiseAction as CFString) == .success else {
  fail("Could not raise the isolated VS Code window for process \(pid)", code: 6)
}

guard let mainWindow = cgWindows(for: pid).first(where: {
  ($0[kCGWindowLayer as String] as? Int) == 0 && (bounds(of: $0)?.width ?? 0) >= 300
}), let windowID = mainWindow[kCGWindowNumber as String] as? Int,
    let windowTitle = mainWindow[kCGWindowName as String] as? String else {
  fail("Could not resolve the isolated VS Code main window for process \(pid)", code: 7)
}

guard let viewMenuItem = findElement(
  in: application,
  role: kAXMenuItemRole as String,
  exactText: viewTitle,
  timeout: 3
) else {
  fail("Could not find VS Code's \(viewTitle) application-menu item", code: 8)
}
guard AXUIElementPerformAction(viewMenuItem, kAXPressAction as CFString) == .success else {
  fail("Could not reveal VS Code's \(viewTitle) view", code: 9)
}

if operation == "list-rows" {
  Thread.sleep(forTimeInterval: 0.2)
  let rows = descendants(application).compactMap { element -> RowProbe? in
    guard stringAttribute(element, kAXRoleAttribute as CFString) == (kAXRowRole as String) else {
      return nil
    }
    return RowProbe(
      title: stringAttribute(element, kAXTitleAttribute as CFString),
      description: stringAttribute(element, kAXDescriptionAttribute as CFString),
      value: stringAttribute(element, kAXValueAttribute as CFString)
    )
  }
  let encoded = try JSONEncoder().encode(rows)
  print(String(decoding: encoded, as: UTF8.self))
  exit(0)
}

guard let row = findElement(
  in: application,
  role: kAXRowRole as String,
  exactText: rowDescription,
  timeout: 15
) else {
  fail("Could not find \(view) row with description: \(rowDescription)", code: 10)
}
guard AXUIElementPerformAction(row, kAXShowMenuAction as CFString) == .success else {
  fail("Could not show the context menu for \(rowDescription)", code: 11)
}

let popupDeadline = Date().addingTimeInterval(3)
var popupWindow: [String: Any]?
repeat {
  popupWindow = cgWindows(for: pid)
    .filter {
      ($0[kCGWindowLayer as String] as? Int ?? 0) > 0
        && (bounds(of: $0)?.width ?? 0) >= 80
        && (bounds(of: $0)?.height ?? 0) >= 30
    }
    .max { (bounds(of: $0)?.width ?? 0) * (bounds(of: $0)?.height ?? 0)
      < (bounds(of: $1)?.width ?? 0) * (bounds(of: $1)?.height ?? 0) }
  if popupWindow == nil { Thread.sleep(forTimeInterval: 0.05) }
} while popupWindow == nil && Date() < popupDeadline

guard let popupWindow,
      let popupWindowID = popupWindow[kCGWindowNumber as String] as? Int,
      let popupBounds = bounds(of: popupWindow) else {
  sendEscape(to: pid)
  fail("No native context-menu window appeared for VS Code process \(pid)", code: 12)
}

let system = AXUIElementCreateSystemWide()
let sampleX = Float(popupBounds.x + popupBounds.width / 2)
var items: [String] = []
var seenItems = Set<String>()
for sampleY in stride(from: popupBounds.y + 2, to: popupBounds.y + popupBounds.height - 1, by: 2) {
  var rawElement: AXUIElement?
  guard AXUIElementCopyElementAtPosition(system, sampleX, Float(sampleY), &rawElement) == .success,
        let element = rawElement else { continue }
  var elementPID: pid_t = 0
  AXUIElementGetPid(element, &elementPID)
  guard elementPID == pid else {
    sendEscape(to: pid)
    fail("Context-menu sample targeted process \(elementPID), expected \(pid)", code: 13)
  }
  guard stringAttribute(element, kAXRoleAttribute as CFString) == (kAXMenuItemRole as String) else { continue }
  let title = stringAttribute(element, kAXTitleAttribute as CFString)
  if !title.isEmpty, !seenItems.contains(title) {
    seenItems.insert(title)
    items.append(title)
  }
}

guard !items.isEmpty else {
  sendEscape(to: pid)
  fail("The native context menu exposed no titled items", code: 14)
}

let probe = MenuProbe(
  pid: pid,
  view: view,
  row: rowDescription,
  windowID: windowID,
  windowTitle: windowTitle,
  popupWindowID: popupWindowID,
  popupBounds: popupBounds,
  items: items
)
let encoded = try JSONEncoder().encode(probe)
print(String(decoding: encoded, as: UTF8.self))
