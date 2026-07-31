// ax-dump — the macOS Accessibility sidecar for DeskRAG.
//
// Walks the focused window's AXUIElement tree of the target app (frontmost by
// default, or `--pid <n>`) and prints a FLAT JSON array of UI elements to stdout:
//   [{ "role": String, "label"?: String, "x": Double, "y": Double,
//      "w": Double, "h": Double, "focused"?: Bool, "parent"?: Int }, ...]
//
// The array is flat but not structureless: `parent` is a back-reference to an
// earlier index (the walk is pre-order, so a parent always precedes its children)
// and its absence means root. Nodes the walk skips — no role, or no usable bbox —
// are transparent: their children reparent to the nearest emitted ancestor, so
// `parent` chains never dangle. Depth is NOT emitted; the TS side derives it from
// `parent` so the two can't disagree after an element is dropped in validation.
//
// Coordinates are global screen coordinates, top-left origin (the Accessibility
// API's native space) — the same space as uiohook mouse hotspots, so no flip.
//
// Best-effort contract (matches SwiftAxSource): exit 0 with `[]` when Accessibility
// permission is absent or the app exposes nothing; the TS side filters/fuses. The
// walk is bounded by nodes, depth, AND wall-clock time (`--budget-ms`, default
// 800) — a slow app yields a partial tree, never a hang. Truncation is noted on
// stderr; stdout stays pure JSON.
//
// Build:  swiftc -O native/ax-dump.swift -o native/ax-dump   (npm run build:ax)

import Foundation
import Dispatch
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
    /// Index of the nearest emitted ancestor; nil for a root. Synthesized Codable
    /// uses encodeIfPresent, so roots stay as compact as they were before.
    let parent: Int?
}

final class AXReader {
    private(set) var elements: [AXElem] = []
    /// True when a cap (nodes/depth/time) cut the walk short — the result is a
    /// partial tree, which the best-effort contract allows.
    private(set) var truncated = false
    private var visited = 0
    private let maxNodes = 4000
    private let maxDepth = 60
    /// Monotonic wall-clock ceiling for the whole walk. maxNodes alone does NOT
    /// bound runtime: each node costs ~6 AX round-trips and per-call latency is a
    /// property of the target app (measured: ~0.5ms for Finder, ~8ms for Mail),
    /// so 4000 nodes ranges from ~2s to minutes. Unbounded here is what made
    /// test/ax-swift.test.ts hang until vitest's 30s timeout, passing or failing
    /// on which app happened to be frontmost.
    private let deadline: UInt64

    init(budgetMs: Double) {
        deadline = DispatchTime.now().uptimeNanoseconds + UInt64(budgetMs * 1_000_000)
    }

    private var outOfTime: Bool { DispatchTime.now().uptimeNanoseconds >= deadline }

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

    /// `rawDepth` counts every node visited (it drives the depth cap); `parent` is
    /// the index of the nearest ancestor that actually made it into `elements`.
    func walk(_ el: AXUIElement, rawDepth: Int, parent: Int?) {
        if visited >= maxNodes || rawDepth > maxDepth || outOfTime {
            truncated = true
            return
        }
        visited += 1
        // Skipped nodes are transparent: children inherit the parent we were given.
        var childParent = parent
        if let rawRole = str(el, kAXRoleAttribute as String),
           let pos = point(el, kAXPositionAttribute as String),
           let size = extent(el, kAXSizeAttribute as String),
           size.width > 0, size.height > 0 {
            // Strip the "AX" prefix so roles are clean + FTS-friendly ("Button").
            let role = rawRole.hasPrefix("AX") ? String(rawRole.dropFirst(2)) : rawRole
            let label = str(el, kAXTitleAttribute as String)
                ?? str(el, kAXDescriptionAttribute as String)
            childParent = elements.count
            elements.append(AXElem(
                role: role, label: label,
                x: Double(pos.x), y: Double(pos.y),
                w: Double(size.width), h: Double(size.height),
                focused: flag(el, kAXFocusedAttribute as String),
                parent: parent
            ))
        }
        for child in children(el) { walk(child, rawDepth: rawDepth + 1, parent: childParent) }
    }
}

func emit(_ elements: [AXElem]) {
    let data = (try? JSONEncoder().encode(elements)) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(data)
}

// --- main ---------------------------------------------------------------------

let args = CommandLine.arguments

func emitJSON<T: Encodable>(_ value: T) {
    guard let data = try? JSONEncoder().encode(value),
          let s = String(data: data, encoding: .utf8) else {
        print("[]")
        return
    }
    print(s)
}

// MARK: - Display topology (--displays)
//
// NSScreen.frame is BOTTOM-left origin; AX bboxes and uiohook mouse coordinates
// are TOP-left. Without the flip every secondary display's y is wrong and points
// get misattributed. The flip is against the PRIMARY screen's height, because
// that is what defines the global coordinate space.
//
// Needs no Accessibility permission, so it sits above the AXIsProcessTrusted
// gate — and above the AX --self-test block, so `--displays --self-test` is not
// swallowed by it.

struct DisplayOut: Codable {
    let id: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let scale: Double
    let primary: Bool
}

if args.contains("--displays") {
    if args.contains("--self-test") {
        emitJSON([
            DisplayOut(id: "1", x: 0, y: 0, w: 2560, h: 1440, scale: 2, primary: true),
            DisplayOut(id: "2", x: 2560, y: 0, w: 1920, h: 1080, scale: 1, primary: false),
        ])
        exit(0)
    }
    let screens = NSScreen.screens
    guard let primary = screens.first else {
        print("[]")
        exit(0)
    }
    let flipH = primary.frame.height
    var displaysOut: [DisplayOut] = []
    for s in screens {
        let f = s.frame
        let num = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        displaysOut.append(DisplayOut(
            id: num.map { String($0.uint32Value) } ?? "unknown",
            x: f.origin.x,
            y: flipH - f.origin.y - f.height,
            w: f.width,
            h: f.height,
            scale: s.backingScaleFactor,
            primary: s == primary
        ))
    }
    emitJSON(displaysOut)
    exit(0)
}

// Deterministic contract self-check (no AX access) — used by the test suite to
// verify the JSON encoding + sidecar wiring regardless of permission state. Two
// elements, so the parent back-reference is part of the checked contract.
if args.contains("--self-test") {
    emit([
        AXElem(role: "Window", label: nil, x: 0, y: 0, w: 1000, h: 1000, focused: nil, parent: nil),
        AXElem(role: "Button", label: "Save", x: 100, y: 200, w: 80, h: 30, focused: true, parent: 0),
    ])
    exit(0)
}

// No Accessibility permission → best-effort empty result (do not prompt).
if !AXIsProcessTrusted() {
    print("[]")
    exit(0)
}

// Cap a single AX round-trip. This is NOT what bounds the walk (see AXReader's
// deadline) — no observed call came close to this; the slowest measured was 218ms
// against Mail. It exists because the deadline is only checked *between* calls and
// so cannot interrupt one already in flight: this caps the overshoot. Must be set
// on the SYSTEM-WIDE element — per the AX header, setting it on any other object
// applies to that object alone and does NOT reach the children the walk discovers.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)

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

// Sized so the whole process finishes inside SwiftAxSource's 1500ms execFile
// timeout — a slow app must yield a partial tree, not get SIGKILLed with nothing
// to show for the work. Worst case is budget + one in-flight call (≤500ms, the
// messaging timeout) + spawn/emit, so the budget has to sit well below 1500:
// at 1200 Mail measured 1527ms end-to-end and would have been killed.
var budgetMs = 800.0
if let i = args.firstIndex(of: "--budget-ms"), i + 1 < args.count, let b = Double(args[i + 1]), b > 0 {
    budgetMs = b
}

let app = AXUIElementCreateApplication(pid)
let reader = AXReader(budgetMs: budgetMs)

var focusedWindow: CFTypeRef?
if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedWindow) == .success,
   let win = focusedWindow, CFGetTypeID(win) == AXUIElementGetTypeID() {
    reader.walk(win as! AXUIElement, rawDepth: 0, parent: nil)
} else {
    var windows: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success,
       let arr = windows as? [AXUIElement], let first = arr.first {
        reader.walk(first, rawDepth: 0, parent: nil)
    }
}

// A truncated walk is a silently partial AX tree — worth a breadcrumb, but on
// stderr only: stdout is the JSON contract SwiftAxSource parses.
if reader.truncated {
    FileHandle.standardError.write(Data("[ax-dump] walk truncated (budget \(Int(budgetMs))ms)\n".utf8))
}
emit(reader.elements)
exit(0)
