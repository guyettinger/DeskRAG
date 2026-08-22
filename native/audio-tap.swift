// audio-tap — captures COMPUTER AUDIO (everything this Mac plays) using Core
// Audio process taps, and writes it as raw PCM for the capture pipeline to
// window, stamp and store.
//
// Build:  swiftc -O native/audio-tap.swift -o native/audio-tap   (npm run build:ax)
//
// WHY A SIDECAR AT ALL. ffmpeg cannot reach system audio on macOS: avfoundation
// lists "Capture screen N" under VIDEO only, AVCaptureScreenInput carries no
// audio stream, and ffmpeg 8 has no ScreenCaptureKit demuxer. Electron's
// `setDisplayMediaRequestHandler` + `audio:'loopback'` does work and is the same
// Core Audio tap underneath, but it delivers a MediaStream to the RENDERER —
// which cannot reach the store, cannot be a library Producer, and carries no
// device timestamp, so every sample would be arrival-stamped. That is the 3.050s
// bug (docs/internals/capture.md) with a new coat on.
//
// WHY A TAP AND NOT ScreenCaptureKit. A tap is PRE-MIXER. Measured on macOS
// 26.5.1 with the system OUTPUT MUTED, a 440 Hz tone still captured at
// -34.3 dB, and sweeping the volume slider while muted moved nothing:
// volume 20 -> -34.5 dB, volume 90 -> -34.5 dB. ScreenCaptureKit captures
// post-mixer and would have recorded digital silence in every one of those runs.
// For an always-on recorder that is the difference between a signal and the
// -91 dB silent-microphone store this project has already paid for once.
//
// THE THREE CHANNELS, AND WHY THEY ARE SPLIT THAT WAY:
//
//   stdout  raw s16le mono PCM at --sample-rate. NOTHING ELSE, EVER. This
//           inverts ax-dump's convention (stdout is JSON there) on purpose: one
//           stray log line here does not produce a parse error, it produces a
//           WAV with the right byte count and garbage inside it, which is
//           exactly the failure mode that is invisible to every assertion over
//           the schema.
//   fd 3    newline-delimited JSON anchors. See ANCHORS below.
//   stderr  human-readable diagnostics, `[audio-tap] ...`, routed to the
//           producer's onError. Never per-callback — that would be ~100 lines
//           a second.
//
// ANCHORS. The capture clock is device time, never arrival time. The IOProc is
// handed an AudioTimeStamp whose mHostTime is mach absolute time — the SAME base
// `ax-dump --clock` reads via clock_gettime_nsec_np(CLOCK_UPTIME_RAW). Measured:
// a tap anchor of 4,578,840,439 ms against an ax-dump reading of
// 4,578,920,746 ms taken ~80s later, and an in-process delta stable at 31.0 ms
// across every run, which is IO latency and not clock skew.
//
//   mHostTime IS IN MACH TICKS, NOT NANOSECONDS. AudioConvertHostTimeToNanos is
//   the conversion. A hand-rolled one that omits mach_timebase_info works
//   perfectly on Intel and is ~41x wrong on every Apple Silicon Mac — it would
//   read as an absurd t_mono rather than as a subtle drift, but only on the
//   machines everyone actually uses.
//
// A TAP DELIVERS NOTHING WHILE THE OUTPUT DEVICE IS IDLE — no callbacks at all,
// not zeroed buffers. Measured: 5s with nothing playing produced 0 callbacks and
// a 0-byte file. So the FIRST anchor arrives when audio first plays, not when
// the process starts, and it describes output byte 0. Once the device is
// cycling it stays contiguous: a deliberate 8s of TRUE idle inside a 15s capture
// still yielded 719,360 frames = 14.99s with zero discontinuities, because
// silence inside an active period arrives as real zeroed samples.
//
// Contiguity is nevertheless VERIFIED rather than assumed, because the whole
// downstream timing is `anchor + bytes/rate`: if the device ever does idle out,
// unverified byte arithmetic slides every later sample earlier, silently and for
// the rest of the recording. On a discontinuity we emit a NEW anchor carrying
// the stdout byte offset it applies from, and the producer starts a new chunk
// series there. That keeps blob spans honest and preserves the rail's rule that
// a hole means NO COVERAGE rather than silence.
//
// The tap setup follows AudioTee (https://github.com/makeusabrew/audiotee, MIT,
// (c) 2025 Nick Payne) — the empty-sub-device aggregate shape in particular.
// The device-time anchor, the contiguity check and the self-test are ours;
// AudioTee discards every timestamp the IOProc is given.

import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

/// Bumped whenever the fd-3 contract or the stdout format changes. The producer
/// reads `--version` before it spawns and REFUSES on a mismatch. ax-dump has no
/// such handshake, and a stale binary silently ignoring --keymap/--displays cost
/// two days and every recording's typed text (CLAUDE.md).
let CONTRACT_VERSION = 1

// MARK: - Output channels

func note(_ msg: String) {
    FileHandle.standardError.write("[audio-tap] \(msg)\n".data(using: .utf8)!)
}

/// fd 3 is opened by the parent (`stdio: [.., .., .., "pipe"]`). Writing anchors
/// anywhere else would mean interleaving them with the PCM.
func emitAnchor(_ json: String) {
    _ = json.withCString { p in write(3, p, strlen(p)) }
    _ = "\n".withCString { p in write(3, p, 1) }
}

func writeAll(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) {
    var off = 0
    while off < count {
        let n = write(fd, bytes.advanced(by: off), count - off)
        if n <= 0 {
            if errno == EINTR { continue }
            exit(0)  // the parent closed the pipe; that is a normal stop
        }
        off += n
    }
}

// MARK: - Arguments

var sampleRate = 16000.0
var chunkMs = 200.0
var excludePids: [pid_t] = []
var selfTest = false
var showVersion = false

var argv = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < argv.count {
    switch argv[i] {
    case "--sample-rate": i += 1; sampleRate = Double(argv[safe: i] ?? "") ?? sampleRate
    case "--chunk-ms":    i += 1; chunkMs = Double(argv[safe: i] ?? "") ?? chunkMs
    case "--exclude-pid": i += 1; if let p = Int32(argv[safe: i] ?? "") { excludePids.append(p) }
    case "--self-test":   selfTest = true
    case "--version":     showVersion = true
    default: note("ignoring unknown argument \(argv[i])")
    }
    i += 1
}

extension Array {
    subscript(safe idx: Int) -> Element? { indices.contains(idx) ? self[idx] : nil }
}

if showVersion {
    print("audio-tap \(CONTRACT_VERSION)")
    exit(0)
}

// THE SELF-TEST SITS ABOVE EVERY GATE — above the macOS version check and above
// any CoreAudio call — so the fd-3 parser and the byte contract are testable in
// the root suite, in CI, and on a machine where a tap could never run. This is
// the `ax-dump --clock --self-test` precedent.
if selfTest {
    emitAnchor("{\"v\":\(CONTRACT_VERSION),\"anchorMs\":1234.5,\"byteOffset\":0,"
        + "\"sampleRate\":16000,\"channels\":1,\"format\":\"s16le\"}")
    var ramp = [Int16](repeating: 0, count: 1600)
    for k in 0..<1600 { ramp[k] = Int16(truncatingIfNeeded: k) }
    ramp.withUnsafeBytes { writeAll(1, $0.baseAddress!, $0.count) }
    exit(0)
}

guard #available(macOS 14.2, *) else {
    note("computer audio needs macOS 14.2 or later (Core Audio process taps)")
    exit(2)
}

// Running with no anchor channel is the one state this design forbids outright,
// so there is deliberately no path to it.
if fcntl(3, F_GETFD) == -1 {
    note("fd 3 is not open — the anchor channel is required, refusing to start")
    exit(3)
}

// MARK: - Core Audio helpers

func addr(_ sel: AudioObjectPropertySelector,
          _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal)
    -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope,
                               mElement: kAudioObjectPropertyElementMain)
}

/// Translate a unix pid into the AudioObjectID the tap description wants.
/// NOTE FOR CALLERS: this is resolved ONCE, here, at tap creation. A process
/// that starts playing later cannot be excluded at all — see the producer's
/// note about Electron helper processes.
func audioObject(forPid p: pid_t) -> AudioObjectID? {
    var pid = p
    var a = addr(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var obj = AudioObjectID(kAudioObjectUnknown)
    var sz = UInt32(MemoryLayout<AudioObjectID>.size)
    let st = withUnsafeMutableBytes(of: &pid) { raw in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a,
                                   UInt32(MemoryLayout<pid_t>.size), raw.baseAddress,
                                   &sz, &obj)
    }
    return st == noErr && obj != AudioObjectID(kAudioObjectUnknown) ? obj : nil
}

// MARK: - The tap

let excluded = excludePids.compactMap { audioObject(forPid: $0) }
if excluded.count != excludePids.count {
    note("excluded \(excluded.count) of \(excludePids.count) requested processes "
        + "(a process with no audio object has never played anything)")
}

let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
desc.name = "DeskRAG computer audio"
desc.isPrivate = true
// MIX DOWN IN CORE AUDIO, so AVAudioConverter only has to resample. The tap's
// native format is 48 kHz stereo f32 (measured); we want 16 kHz mono s16le.
desc.isMono = true
// NON-NEGOTIABLE. Muting what the user is listening to in order to record it is
// worse than capturing nothing at all.
desc.muteBehavior = CATapMuteBehavior.unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
let tapStatus = AudioHardwareCreateProcessTap(desc, &tapID)
guard tapStatus == noErr else {
    note("could not create the audio tap (OSStatus \(tapStatus)) — this usually "
        + "means System Audio Recording is not granted to DeskRAG")
    exit(1)
}

var tapFormat = AudioStreamBasicDescription()
var tfAddr = addr(kAudioTapPropertyFormat)
var tfSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
guard AudioObjectGetPropertyData(tapID, &tfAddr, 0, nil, &tfSize, &tapFormat) == noErr,
      tapFormat.mSampleRate > 0 else {
    note("could not read the tap's stream format")
    AudioHardwareDestroyProcessTap(tapID)
    exit(1)
}
note("tap format \(tapFormat.mSampleRate) Hz, \(tapFormat.mChannelsPerFrame) ch")

// MARK: - The aggregate device
//
// An EMPTY sub-device list, with the tap attached instead. Naming a sub-device
// would tie the capture to whichever output device happened to be default when
// the recording started, and that changes under the user mid-session.

let aggUID = UUID().uuidString
let aggDict: [String: Any] = [
    kAudioAggregateDeviceNameKey: "DeskRAG computer audio",
    kAudioAggregateDeviceUIDKey: aggUID,
    kAudioAggregateDeviceIsPrivateKey: 1,
    kAudioAggregateDeviceIsStackedKey: 0,
    kAudioAggregateDeviceTapAutoStartKey: 1,
    kAudioAggregateDeviceSubDeviceListKey: [],
    kAudioAggregateDeviceTapListKey: [[
        kAudioSubTapUIDKey: desc.uuid.uuidString,
        kAudioSubTapDriftCompensationKey: 1,
    ]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
let aggStatus = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &aggID)
guard aggStatus == noErr else {
    note("could not create the aggregate device (OSStatus \(aggStatus))")
    AudioHardwareDestroyProcessTap(tapID)
    exit(1)
}

// MARK: - Conversion

guard let inFormat = AVAudioFormat(streamDescription: &tapFormat),
      let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                    sampleRate: sampleRate,
                                    channels: 1,
                                    interleaved: true),
      let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
    note("could not build the \(tapFormat.mSampleRate) Hz -> \(sampleRate) Hz converter")
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(1)
}

/// Everything the IOProc mutates. Single-threaded by construction: Core Audio
/// serialises IOProc invocations for one device.
final class Capture {
    let converter: AVAudioConverter
    let inFormat: AVAudioFormat
    let outFormat: AVAudioFormat
    let inRate: Double
    let chunkBytes: Int
    var pending = Data()
    var outBytes = 0
    /// Device time of the sample at `anchorByteOffset`, in CLOCK_UPTIME_RAW ms.
    var anchorMs: Double?
    var anchorByteOffset = 0
    /// Input frames seen SINCE the current anchor; drives the contiguity check.
    var framesSinceAnchor: Int64 = 0
    var discontinuities = 0

    init(converter: AVAudioConverter, inFormat: AVAudioFormat, outFormat: AVAudioFormat,
         inRate: Double, chunkBytes: Int) {
        self.converter = converter; self.inFormat = inFormat; self.outFormat = outFormat
        self.inRate = inRate; self.chunkBytes = chunkBytes
    }

    func anchorJSON(_ ms: Double, _ offset: Int) -> String {
        "{\"v\":\(CONTRACT_VERSION),\"anchorMs\":\(ms),\"byteOffset\":\(offset),"
            + "\"sampleRate\":\(Int(outFormat.sampleRate)),\"channels\":1,"
            + "\"format\":\"s16le\"}"
    }

    func flush(force: Bool) {
        while pending.count >= (force ? 1 : chunkBytes) {
            let n = force ? pending.count : chunkBytes
            pending.prefix(n).withUnsafeBytes { writeAll(1, $0.baseAddress!, n) }
            pending.removeFirst(n)
            if force { break }
        }
    }
}

let capture = Capture(converter: converter, inFormat: inFormat, outFormat: outFormat,
                      inRate: tapFormat.mSampleRate,
                      chunkBytes: max(2, Int(sampleRate * 2 * chunkMs / 1000)))
let capturePtr = Unmanaged.passRetained(capture).toOpaque()

var procID: AudioDeviceIOProcID?
let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) {
    (_, inData, inTime, _, _) in
    let c = Unmanaged<Capture>.fromOpaque(capturePtr).takeUnretainedValue()

    let hostMs = Double(AudioConvertHostTimeToNanos(inTime.pointee.mHostTime)) / 1e6
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
    guard let first = abl.first, first.mDataByteSize > 0 else { return }
    let bytesPerInFrame = max(1, Int(c.inFormat.streamDescription.pointee.mBytesPerFrame))
    let inFrames = Int(first.mDataByteSize) / bytesPerInFrame
    guard inFrames > 0 else { return }

    if c.anchorMs == nil {
        // First delivered sample. Not process start: a tap is silent until the
        // output device wakes, and that may be minutes into a recording.
        c.anchorMs = hostMs
        c.anchorByteOffset = 0
        emitAnchor(c.anchorJSON(hostMs, 0))
    } else if let a = c.anchorMs {
        // CONTIGUITY. Everything downstream times samples as anchor + bytes/rate,
        // so a hole that is not declared moves the whole remainder of the
        // recording onto a wrong clock. 20ms is well above the ~10ms IO cycle and
        // far below anything a listener would call a gap.
        let expected = a + (Double(c.framesSinceAnchor) / c.inRate) * 1000.0
        if abs(hostMs - expected) > 20 {
            c.flush(force: true)
            c.discontinuities += 1
            c.anchorMs = hostMs
            c.anchorByteOffset = c.outBytes
            c.framesSinceAnchor = 0
            emitAnchor(c.anchorJSON(hostMs, c.outBytes))
            note(String(format: "discontinuity of %.0fms at byte %d — re-anchored",
                        hostMs - expected, c.outBytes))
        }
    }
    c.framesSinceAnchor += Int64(inFrames)

    guard let inBuf = AVAudioPCMBuffer(pcmFormat: c.inFormat,
                                       bufferListNoCopy: inData) else { return }
    let outCapacity = AVAudioFrameCount(
        (Double(inFrames) * c.outFormat.sampleRate / c.inRate).rounded(.up) + 16)
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: c.outFormat,
                                        frameCapacity: outCapacity) else { return }
    var supplied = false
    var err: NSError?
    c.converter.convert(to: outBuf, error: &err) { _, status in
        if supplied { status.pointee = .noDataNow; return nil }
        supplied = true
        status.pointee = .haveData
        return inBuf
    }
    if let err {
        note("convert failed: \(err.localizedDescription)")
        return
    }
    guard let ch = outBuf.int16ChannelData, outBuf.frameLength > 0 else { return }
    let n = Int(outBuf.frameLength) * 2
    c.pending.append(UnsafeBufferPointer(start: UnsafeRawPointer(ch[0])
        .assumingMemoryBound(to: UInt8.self), count: n))
    c.outBytes += n
    c.flush(force: false)
}

guard ioStatus == noErr, let procID else {
    note("could not create the IO proc (OSStatus \(ioStatus))")
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(1)
}

// MARK: - Run

func teardown() -> Never {
    AudioDeviceStop(aggID, procID)
    AudioDeviceDestroyIOProcID(aggID, procID)
    capture.flush(force: true)
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    note("stopped after \(capture.outBytes) bytes, "
        + "\(capture.discontinuities) discontinuit\(capture.discontinuities == 1 ? "y" : "ies")")
    exit(0)
}

// SIGINT/SIGTERM must drain rather than die: the producer sends SIGINT and then
// AWAITS close, because bytes still in the pipe are only delivered while the
// stream drains. Not waiting dropped 16000 of 32000 bytes when it was measured
// on the microphone path.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { teardown() }
    src.resume()
    signalSources.append(src)
}

let startStatus = AudioDeviceStart(aggID, procID)
guard startStatus == noErr else {
    note("could not start the aggregate device (OSStatus \(startStatus))")
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(1)
}
note("capturing at \(Int(sampleRate)) Hz mono s16le")
dispatchMain()
