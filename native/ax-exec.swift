// ax-exec — actuation sidecar. Posts CGEvents and resolves AX descriptors
// against the live tree, speaking one JSON object per line on stdin/stdout.
//
// Deliberately SEPARATE from ax-dump. ax-dump is read-only and two of its modes
// are permission-free by design; folding actuation into it would mean every AX
// read is performed by a binary that can also click. Capability separation is
// worth a second build target.
//
// Long-lived on purpose: AXUIElement references are held in a handle table for
// the life of the process, so a `locate` followed by a `click` does not re-walk
// the tree. Re-walking between resolving a target and acting on it is a
// staleness window in which the UI moves.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Wire types

struct Request: Decodable {
    let id: Int
    let cmd: String
    let identifier: String?
    let path: String?
    let app: String?
    let launch: Bool?
    let role: String?
    let label: String?
    let x: Double?
    let y: Double?
    let dx: Double?
    let dy: Double?
    let button: Int?
    let count: Int?
    let steps: Int?
    let keycode: Int?
    let modifiers: [String]?
    let down: Bool?
    let samples: [Sample]?

    struct Sample: Decodable {
        let x: Double
        let y: Double
        let atMs: Double
    }
}

/// Mirrors the TypeScript `UIElement`, including the "AX"-prefix-stripped role.
struct ElementOut {
    let role: String
    let label: String?
    let identifier: String?
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let focused: Bool?
    let parent: Int?

    var json: [String: Any] {
        var o: [String: Any] = ["role": role, "x": x, "y": y, "w": w, "h": h]
        if let l = label { o["label"] = l }
        if let i = identifier { o["identifier"] = i }
        if let f = focused { o["focused"] = f }
        if let p = parent { o["parent"] = p }
        return o
    }
}

func emit(_ id: Int, ok: Bool, result: Any? = nil, error: String? = nil) {
    var obj: [String: Any] = ["id": id, "ok": ok]
    if let r = result { obj["result"] = r }
    if let e = error { obj["error"] = e }
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8)
    else {
        print("{\"id\":\(id),\"ok\":false,\"error\":\"encode failed\"}")
        fflush(stdout)
        return
    }
    print(line)
    fflush(stdout)
}

// MARK: - Startup gate
//
// Refusing to run without a plan id makes an accidental bare invocation inert:
// this binary can move the mouse, so it should never be something you can start
// by double-clicking it.

let args = CommandLine.arguments
guard let planIdx = args.firstIndex(of: "--plan"), planIdx + 1 < args.count else {
    FileHandle.standardError.write("ax-exec requires --plan <id>\n".data(using: .utf8)!)
    exit(2)
}

let trusted = AXIsProcessTrusted()
if trusted {
    // Cap a single AX round-trip, exactly as ax-dump does. Must be set on the
    // SYSTEM-WIDE element: setting it elsewhere applies to that object alone and
    // does not reach the children a walk discovers.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5)
}

// MARK: - AX reading

var handles: [Int: AXUIElement] = [:]
var nextHandle = 1

/// An EMPTY attribute is absent, not present-and-blank.
///
/// This must match `ax-dump`'s `str()` exactly. It did not, and the one-line
/// difference was enough to break node verification: AXTitle on the font-size
/// stepper returns "", so ax-dump fell through to AXDescription and recorded
/// `label: "font size"`, while ax-exec kept "" and the recorded
/// `ax_exists(label="font size", role="Button")` predicate could never match.
/// The two binaries agreed on all 48 elements except that one.
func str(_ el: AXUIElement, _ attr: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
    if let s = value as? String, !s.isEmpty { return s }
    return nil
}

func boolFlag(_ el: AXUIElement, _ attr: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
    return value as? Bool
}

func frameOf(_ el: AXUIElement) -> CGRect {
    var pv: CFTypeRef?
    var sv: CFTypeRef?
    var origin = CGPoint.zero
    var size = CGSize.zero
    if AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pv) == .success,
       let p = pv, CFGetTypeID(p) == AXValueGetTypeID() {
        AXValueGetValue(p as! AXValue, .cgPoint, &origin)
    }
    if AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sv) == .success,
       let s = sv, CFGetTypeID(s) == AXValueGetTypeID() {
        AXValueGetValue(s as! AXValue, .cgSize, &size)
    }
    return CGRect(origin: origin, size: size)
}

func childrenOf(_ el: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success,
          let arr = value as? [AXUIElement] else { return [] }
    return arr
}

/// Roles are emitted WITHOUT the "AX" prefix, matching ax-dump. Agreeing at the
/// source is what keeps the two comparable — a mismatch here once meant no
/// recording ever produced an AX predicate.
func roleOf(_ el: AXUIElement) -> String {
    let raw = str(el, kAXRoleAttribute as String) ?? "Unknown"
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
}

func rootElement() -> AXUIElement? {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
    let app = AXUIElementCreateApplication(pid)
    var win: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &win) == .success,
       let w = win, CFGetTypeID(w) == AXUIElementGetTypeID() {
        return (w as! AXUIElement)
    }
    return app
}

/// ONE traversal producing both arrays, so `elements[i]` and `refs[i]` always
/// describe the same node. Two independent walks would have to agree on order
/// forever, and any divergence would silently act on the wrong element.
struct Walked {
    var elements: [ElementOut] = []
    var refs: [AXUIElement] = []
}

func walk(_ root: AXUIElement, maxNodes: Int = 4000, maxDepth: Int = 64) -> Walked {
    var out = Walked()

    func visit(_ el: AXUIElement, parent: Int?, depth: Int) {
        if depth > maxDepth || out.elements.count >= maxNodes { return }
        let index = out.elements.count
        let f = frameOf(el)
        out.elements.append(ElementOut(
            role: roleOf(el),
            label: str(el, kAXTitleAttribute as String) ?? str(el, kAXDescriptionAttribute as String),
            identifier: str(el, kAXIdentifierAttribute as String),
            x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height,
            focused: boolFlag(el, kAXFocusedAttribute as String),
            parent: parent
        ))
        out.refs.append(el)
        for c in childrenOf(el) { visit(c, parent: index, depth: depth + 1) }
    }

    visit(root, parent: nil, depth: 0)
    return out
}

/// Ordinal among siblings of the same role — the same rule `axPathOf` uses in
/// TypeScript, so a recorded path resolves against a live tree.
func pathOf(_ elements: [ElementOut], _ index: Int) -> String {
    var chain: [Int] = []
    var cursor: Int? = index
    while let i = cursor {
        chain.append(i)
        if chain.count > 128 { break }
        cursor = elements[i].parent
    }
    chain.reverse()
    return chain.map { i -> String in
        let el = elements[i]
        let siblings = elements.indices.filter {
            elements[$0].parent == el.parent && elements[$0].role == el.role
        }
        return "\(el.role)[\(siblings.firstIndex(of: i) ?? 0)]"
    }.joined(separator: ">")
}

// MARK: - Actuation

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
}

func moveMouse(_ p: CGPoint) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                 mouseCursorPosition: p, mouseButton: .left))
}

func clickMouse(_ p: CGPoint, button: Int, count: Int) {
    let isRight = button == 2
    let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
    let btn: CGMouseButton = isRight ? .right : .left
    for i in 1...max(1, count) {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                                 mouseCursorPosition: p, mouseButton: btn),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType,
                               mouseCursorPosition: p, mouseButton: btn)
        else { return }
        // clickState is what makes the OS read this as a double-click rather
        // than two unrelated clicks.
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(down)
        post(up)
    }
}

func flagsFor(_ modifiers: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for m in modifiers {
        switch m.lowercased() {
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        default: break
        }
    }
    return flags
}

// MARK: - Command loop

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let req = try? JSONDecoder().decode(Request.self, from: data)
    else { continue }

    switch req.cmd {
    case "quit":
        emit(req.id, ok: true)
        exit(0)

    case "dump":
        // The tree AND the two facts that are not in it. `app` and `window`
        // predicates come from focus_change events at lift time; at replay there
        // is no event stream, so without these a live tree yields only
        // ax_exists and no node carrying an app predicate can ever verify.
        //
        // Returned from ONE command so they describe the same instant: fetching
        // the app name a moment after the tree has the same hazard that made
        // boundary snapshots describe the previous application.
        var elements: [[String: Any]] = []
        var windowTitle: String?
        if trusted, let root = rootElement() {
            let walked = walk(root)
            elements = walked.elements.map { $0.json }
            // The focused window's title, from the root of the walk.
            windowTitle = walked.elements.first(where: { $0.role == "Window" })?.label
                ?? walked.elements.first?.label
        }
        // localizedName is the display name — the same string active-win records
        // as `owner.name`, so a recorded `app` predicate can match verbatim.
        let appName = NSWorkspace.shared.frontmostApplication?.localizedName
        var result: [String: Any] = ["elements": elements]
        if let a = appName { result["app"] = a }
        if let w = windowTitle { result["windowTitle"] = w }
        emit(req.id, ok: true, result: result)

    case "locate":
        guard trusted, let root = rootElement() else {
            emit(req.id, ok: true, result: NSNull())
            break
        }
        let walked = walk(root)
        var hit: Int?
        for i in walked.elements.indices {
            let e = walked.elements[i]
            if let want = req.identifier, !want.isEmpty {
                if e.identifier == want { hit = i; break }
                continue
            }
            if let want = req.path, !want.isEmpty {
                if pathOf(walked.elements, i) == want { hit = i; break }
                continue
            }
            if let want = req.label, !want.isEmpty {
                if e.label == want && (req.role == nil || e.role == req.role) { hit = i; break }
            }
        }

        guard let index = hit else {
            emit(req.id, ok: true, result: NSNull())
            break
        }
        let handle = nextHandle
        nextHandle += 1
        handles[handle] = walked.refs[index]
        let e = walked.elements[index]
        emit(req.id, ok: true, result: [
            "handle": handle,
            "bounds": ["x": e.x, "y": e.y, "w": e.w, "h": e.h],
        ])

    case "move":
        guard let x = req.x, let y = req.y else {
            emit(req.id, ok: false, error: "move needs x and y")
            break
        }
        moveMouse(CGPoint(x: x, y: y))
        emit(req.id, ok: true)

    case "click":
        guard let x = req.x, let y = req.y else {
            emit(req.id, ok: false, error: "click needs x and y")
            break
        }
        clickMouse(CGPoint(x: x, y: y), button: req.button ?? 1, count: req.count ?? 1)
        emit(req.id, ok: true)

    case "drag":
        guard let samples = req.samples, samples.count >= 2 else {
            emit(req.id, ok: false, error: "drag needs at least two samples")
            break
        }
        let isRight = (req.button ?? 1) == 2
        let btn: CGMouseButton = isRight ? .right : .left
        let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
        let dragType: CGEventType = isRight ? .rightMouseDragged : .leftMouseDragged
        let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp

        let first = CGPoint(x: samples[0].x, y: samples[0].y)
        moveMouse(first)
        post(CGEvent(mouseEventSource: nil, mouseType: downType,
                     mouseCursorPosition: first, mouseButton: btn))
        var previous = samples[0].atMs
        for s in samples.dropFirst() {
            let wait = max(0, s.atMs - previous)
            if wait > 0 { usleep(useconds_t(wait * 1000)) }
            previous = s.atMs
            post(CGEvent(mouseEventSource: nil, mouseType: dragType,
                         mouseCursorPosition: CGPoint(x: s.x, y: s.y), mouseButton: btn))
        }
        let last = samples[samples.count - 1]
        post(CGEvent(mouseEventSource: nil, mouseType: upType,
                     mouseCursorPosition: CGPoint(x: last.x, y: last.y), mouseButton: btn))
        emit(req.id, ok: true)

    case "scroll":
        guard let x = req.x, let y = req.y else {
            emit(req.id, ok: false, error: "scroll needs x and y")
            break
        }
        moveMouse(CGPoint(x: x, y: y))
        let steps = max(1, req.steps ?? 1)
        let perX = Int32((req.dx ?? 0) / Double(steps))
        let perY = Int32((req.dy ?? 0) / Double(steps))
        for _ in 0..<steps {
            post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                         wheel1: perY, wheel2: perX, wheel3: 0))
        }
        emit(req.id, ok: true)

    case "key":
        guard let code = req.keycode, let down = req.down else {
            emit(req.id, ok: false, error: "key needs keycode and down")
            break
        }
        guard let ev = CGEvent(keyboardEventSource: nil,
                               virtualKey: CGKeyCode(code), keyDown: down) else {
            emit(req.id, ok: false, error: "could not create key event")
            break
        }
        ev.flags = flagsFor(req.modifiers ?? [])
        post(ev)
        emit(req.id, ok: true)

    case "runningApps":
        // localizedName is what active-win records as `owner.name` and what
        // `dump` returns, so an `app` predicate matches verbatim -- no
        // normalization anywhere, which is the class of divergence that has
        // already cost this project a day.
        let names = NSWorkspace.shared.runningApplications.compactMap { $0.localizedName }
        emit(req.id, ok: true, result: ["apps": Array(Set(names)).sorted()])

    case "activate":
        guard let wanted = req.app, !wanted.isEmpty else {
            emit(req.id, ok: false, error: "activate needs app")
            break
        }
        if let running = NSWorkspace.shared.runningApplications
            .first(where: { $0.localizedName == wanted }) {
            // `activateIgnoringOtherApps` is deprecated since macOS 14 and documented
            // as having no effect; the plain call is the supported path.
            running.activate()
            emit(req.id, ok: true, result: ["outcome": "activated"])
            break
        }
        // Launching is opt-in: it can restore windows, reopen documents and run
        // startup work, which is categorically larger than raising an app.
        //
        // Resolution is by BUNDLE IDENTIFIER only. `app` predicates carry a
        // localizedName, which is not a bundle id, so this will usually miss and
        // report not-running -- a safe outcome. Guessing an app from a display
        // name (via a default-handler lookup) could launch the WRONG
        // application, which is not a mistake worth risking to save a step.
        guard req.launch == true,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: wanted) else {
            emit(req.id, ok: true, result: ["outcome": "not-running"])
            break
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let sema = DispatchSemaphore(value: 0)
        var launched = false
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
            launched = (err == nil)
            sema.signal()
        }
        _ = sema.wait(timeout: .now() + 10)
        emit(req.id, ok: true, result: ["outcome": launched ? "launched" : "not-running"])

    default:
        emit(req.id, ok: false, error: "unknown command \(req.cmd)")
    }
}
