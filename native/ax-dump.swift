// ax-dump — the macOS Accessibility sidecar for DeskRAG.
//
// Walks the focused window's AXUIElement tree of the target app (frontmost by
// default, or `--pid <n>`) and prints a FLAT JSON array of UI elements to stdout:
//   [{ "role": String, "label"?: String, "x": Double, "y": Double,
//      "w": Double, "h": Double, "focused"?: Bool }, ...]
//
// Coordinates are global screen coordinates, top-left origin (the Accessibility
// API's native space) — the same space as uiohook mouse hotspots, so no flip.
//
// Best-effort contract (matches SwiftAxSource): exit 0 with `[]` when Accessibility
// permission is absent or the app exposes nothing; the TS side filters/fuses.
//
// Build:  swiftc -O native/ax-dump.swift -o native/ax-dump   (npm run build:ax)

import Foundation
import ApplicationServices
import AppKit

struct AXElem: Codable {
    let role: String
    let label: String?
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let focused: Bool?
}

final class AXReader {
    private(set) var elements: [AXElem] = []
    private var visited = 0
    private let maxNodes = 4000
    private let maxDepth = 60

    private func str(_ el: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
        if let s = value as? String, !s.isEmpty { return s }
        return nil
    }

    private func flag(_ el: AXUIElement, _ attr: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
        if let n = value as? NSNumber { return n.boolValue }
        return nil
    }

    private func point(_ el: AXUIElement, _ attr: String) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var pt = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &pt) ? pt : nil
    }

    private func extent(_ el: AXUIElement, _ attr: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var sz = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &sz) ? sz : nil
    }

    private func children(_ el: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success,
              let arr = value as? [AXUIElement] else { return [] }
        return arr
    }

    func walk(_ el: AXUIElement, depth: Int) {
        if visited >= maxNodes || depth > maxDepth { return }
        visited += 1
        if let rawRole = str(el, kAXRoleAttribute as String),
           let pos = point(el, kAXPositionAttribute as String),
           let size = extent(el, kAXSizeAttribute as String),
           size.width > 0, size.height > 0 {
            // Strip the "AX" prefix so roles are clean + FTS-friendly ("Button").
            let role = rawRole.hasPrefix("AX") ? String(rawRole.dropFirst(2)) : rawRole
            let label = str(el, kAXTitleAttribute as String)
                ?? str(el, kAXDescriptionAttribute as String)
            elements.append(AXElem(
                role: role, label: label,
                x: Double(pos.x), y: Double(pos.y),
                w: Double(size.width), h: Double(size.height),
                focused: flag(el, kAXFocusedAttribute as String)
            ))
        }
        for child in children(el) { walk(child, depth: depth + 1) }
    }
}

func emit(_ elements: [AXElem]) {
    let data = (try? JSONEncoder().encode(elements)) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(data)
}

// --- main ---------------------------------------------------------------------

let args = CommandLine.arguments

// Deterministic contract self-check (no AX access) — used by the test suite to
// verify the JSON encoding + sidecar wiring regardless of permission state.
if args.contains("--self-test") {
    emit([AXElem(role: "Button", label: "Save", x: 100, y: 200, w: 80, h: 30, focused: true)])
    exit(0)
}

// No Accessibility permission → best-effort empty result (do not prompt).
if !AXIsProcessTrusted() {
    print("[]")
    exit(0)
}

var targetPid: pid_t?
if let i = args.firstIndex(of: "--pid"), i + 1 < args.count, let p = Int32(args[i + 1]) {
    targetPid = p
} else {
    targetPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
}

guard let pid = targetPid else {
    print("[]")
    exit(0)
}

let app = AXUIElementCreateApplication(pid)
let reader = AXReader()

var focusedWindow: CFTypeRef?
if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedWindow) == .success,
   let win = focusedWindow, CFGetTypeID(win) == AXUIElementGetTypeID() {
    reader.walk(win as! AXUIElement, depth: 0)
} else {
    var windows: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success,
       let arr = windows as? [AXUIElement], let first = arr.first {
        reader.walk(first, depth: 0)
    }
}

emit(reader.elements)
exit(0)
