// FocuClone native screen recorder (macOS 12.3+; system audio needs 13.0+).
//
// Captures a display via ScreenCaptureKit and writes H.264 mp4 directly via
// AVAssetWriter (VideoToolbox-accelerated). Optionally captures system audio
// (SCK audio output, macOS 13+) and microphone (AVCaptureSession). When both
// audio sources are enabled, the mp4 ends up with two audio tracks; the
// FFmpeg post-process amixes them. Single-source mode produces a normal
// single-audio-track mp4.
//
// stdio protocol (line-delimited JSON):
//   IN:  {"cmd":"start","outputPath":"/abs/path.mp4","displayId":0,
//        "width":1920,"height":1080,"fps":60,"showCursor":true,
//        "captureSystemAudio":false,"captureMic":false}
//        {"cmd":"stop"}
//        {"cmd":"quit"}
//   OUT: {"event":"ready"}
//        {"event":"started","displayId":1,"width":1920,"height":1080,
//         "fps":60,"audioTracks":["system","mic"]}
//        {"event":"stopped","outputPath":"…","frames":1234,
//         "audioTracks":["system","mic"]}
//        {"event":"error","message":"…"}

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreVideo

// MARK: - JSON IO helpers

let stdoutLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
        let line = String(data: data, encoding: .utf8)
    else { return }
    stdoutLock.lock()
    print(line)
    fflush(stdout)
    stdoutLock.unlock()
}

func emitError(_ msg: String) { emit(["event": "error", "message": msg]) }

// MARK: - Recorder

@available(macOS 12.3, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate,
    AVCaptureAudioDataOutputSampleBufferDelegate
{
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var systemAudioInput: AVAssetWriterInput?
    private var micAudioInput: AVAssetWriterInput?
    private var captureSession: AVCaptureSession?
    private var sessionStarted = false
    private var frameCount: Int = 0
    private var outputPath: String = ""
    private var audioTracks: [String] = []
    private let lock = NSLock()
    private let micQueue = DispatchQueue(label: "focuclone.mic")
    private let sysAudioQueue = DispatchQueue(label: "focuclone.sysaudio")

    func start(
        outputPath: String,
        displayId: Int,
        width: Int,
        height: Int,
        fps: Int,
        showCursor: Bool,
        captureSystemAudio: Bool,
        captureMic: Bool
    ) async throws {
        self.outputPath = outputPath
        let url = URL(fileURLWithPath: outputPath)
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: 12_000_000,
            AVVideoExpectedSourceFrameRateKey: fps,
            AVVideoMaxKeyFrameIntervalKey: max(1, fps * 2),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
        ]
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoInput) else {
            throw NSError(domain: "Recorder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "writer cannot add video input"])
        }
        writer.add(videoInput)
        self.writer = writer
        self.videoInput = videoInput

        // Audio inputs — added before startWriting (required by AVFoundation).
        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192_000
        ]

        let sysAudioWanted: Bool = {
            if !captureSystemAudio { return false }
            if #available(macOS 13.0, *) { return true }
            return false
        }()

        if sysAudioWanted {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true
            if writer.canAdd(input) {
                writer.add(input)
                self.systemAudioInput = input
                self.audioTracks.append("system")
            }
        }
        if captureMic {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            input.expectsMediaDataInRealTime = true
            if writer.canAdd(input) {
                writer.add(input)
                self.micAudioInput = input
                self.audioTracks.append("mic")
            }
        }

        // Wire up SCStream (video + optional system audio).
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        let display: SCDisplay? = {
            if displayId == 0 { return content.displays.first }
            if let m = content.displays.first(where: { Int($0.displayID) == displayId }) { return m }
            return content.displays.first
        }()
        guard let display = display else {
            throw NSError(domain: "Recorder", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no displays available"])
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = width
        cfg.height = height
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        cfg.showsCursor = showCursor
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.queueDepth = 8
        if sysAudioWanted, #available(macOS 13.0, *) {
            cfg.capturesAudio = true
        }

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .screen,
                                   sampleHandlerQueue: DispatchQueue(label: "focuclone.frame"))
        if sysAudioWanted, #available(macOS 13.0, *) {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sysAudioQueue)
        }
        try await stream.startCapture()
        self.stream = stream

        // Mic via AVCaptureSession — independent of SCK.
        if captureMic, micAudioInput != nil {
            try setupMic()
        }

        emit([
            "event": "started",
            "displayId": Int(display.displayID),
            "width": width,
            "height": height,
            "fps": fps,
            "audioTracks": audioTracks
        ])
    }

    private func setupMic() throws {
        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw NSError(domain: "Recorder", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "no default audio input"])
        }
        let deviceInput = try AVCaptureDeviceInput(device: device)
        let session = AVCaptureSession()
        if session.canAddInput(deviceInput) { session.addInput(deviceInput) }
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: micQueue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.startRunning()
        self.captureSession = session
    }

    func stop() async {
        if let s = stream {
            try? await s.stopCapture()
        }
        captureSession?.stopRunning()
        captureSession = nil

        lock.lock()
        let v = videoInput
        let sa = systemAudioInput
        let ma = micAudioInput
        let w = writer
        lock.unlock()
        v?.markAsFinished()
        sa?.markAsFinished()
        ma?.markAsFinished()
        if let w = w {
            await w.finishWriting()
            if w.status == .completed {
                emit([
                    "event": "stopped",
                    "outputPath": outputPath,
                    "frames": frameCount,
                    "audioTracks": audioTracks
                ])
            } else {
                emitError(
                    "writer ended with status \(w.status.rawValue): "
                    + (w.error?.localizedDescription ?? "unknown")
                )
            }
        }
        stream = nil
        writer = nil
        videoInput = nil
        systemAudioInput = nil
        micAudioInput = nil
    }

    // MARK: SCStreamOutput
    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard sampleBuffer.isValid else { return }

        // System audio path (macOS 13+).
        if #available(macOS 13.0, *), type == .audio {
            lock.lock()
            defer { lock.unlock() }
            // Audio that arrives before the video session starts gets dropped —
            // AVAssetWriter rejects samples earlier than the session source time.
            guard sessionStarted, let input = systemAudioInput,
                  input.isReadyForMoreMediaData else { return }
            input.append(sampleBuffer)
            return
        }

        guard type == .screen else { return }
        // Drop incomplete / idle frames — SCK keeps emitting "no change" frames
        // even when the screen hasn't redrawn, and feeding those to the writer
        // wastes file size with duplicate samples.
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw),
            status == .complete
        else { return }

        lock.lock()
        defer { lock.unlock() }
        guard let writer = writer, let videoInput = videoInput else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !sessionStarted {
            if writer.status == .unknown {
                writer.startWriting()
                writer.startSession(atSourceTime: pts)
                sessionStarted = true
            } else {
                return
            }
        }
        if videoInput.isReadyForMoreMediaData {
            videoInput.append(sampleBuffer)
            frameCount += 1
        }
    }

    // MARK: SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitError("stream stopped: \(error.localizedDescription)")
    }

    // MARK: AVCaptureAudioDataOutputSampleBufferDelegate
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard sampleBuffer.isValid else { return }
        lock.lock()
        defer { lock.unlock() }
        guard sessionStarted, let input = micAudioInput,
              input.isReadyForMoreMediaData else { return }
        input.append(sampleBuffer)
    }
}

// MARK: - Main

guard #available(macOS 12.3, *) else {
    FileHandle.standardError.write(
        "ScreenCaptureKit requires macOS 12.3 or later\n".data(using: .utf8)!
    )
    exit(1)
}

let recorder = Recorder()
emit(["event": "ready"])

let group = DispatchGroup()
group.enter()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard
            let data = line.data(using: .utf8),
            let parsed = try? JSONSerialization.jsonObject(with: data),
            let obj = parsed as? [String: Any],
            let cmd = obj["cmd"] as? String
        else { continue }

        switch cmd {
        case "start":
            let outputPath = obj["outputPath"] as? String ?? ""
            let displayId = (obj["displayId"] as? Int) ?? 0
            let width = (obj["width"] as? Int) ?? 1920
            let height = (obj["height"] as? Int) ?? 1080
            let fps = (obj["fps"] as? Int) ?? 60
            let showCursor = (obj["showCursor"] as? Bool) ?? true
            let captureSys = (obj["captureSystemAudio"] as? Bool) ?? false
            let captureMic = (obj["captureMic"] as? Bool) ?? false
            Task {
                do {
                    try await recorder.start(
                        outputPath: outputPath,
                        displayId: displayId,
                        width: width,
                        height: height,
                        fps: fps,
                        showCursor: showCursor,
                        captureSystemAudio: captureSys,
                        captureMic: captureMic
                    )
                } catch {
                    emitError(error.localizedDescription)
                }
            }

        case "stop":
            Task {
                await recorder.stop()
                group.leave()
            }
            return

        case "quit":
            group.leave()
            return

        default:
            break
        }
    }
    Task {
        await recorder.stop()
        group.leave()
    }
}

group.wait()
exit(0)
