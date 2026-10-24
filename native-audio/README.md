# Kontakt process audio recorder

This helper captures **only the selected process and its child processes**, using Windows process-loopback WASAPI. It never falls back to desktop mix or microphone capture. There are no NuGet dependencies.

## Build and use

Requires the .NET 9 SDK to build and .NET 9 runtime to run. Build from the repository root:

```powershell
dotnet build native-audio/ProcessAudio.csproj -c Release
dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --probe
dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --pid 1234 --output C:\recordings\take-001.wav
```

The PID above is an example. `--probe` / `--list` returns current Kontakt process IDs. Send `stop` followed by a newline to stdin to finish. EOF and Ctrl+C also stop and finalize the file. Keep a spawned process's stdin pipe open for the entire recording. Optional `--seconds 5` stops after five seconds; it does not override stdin closure. Existing output files are never overwritten.

Output WAV: stereo, signed 16-bit PCM, 44,100 Hz by default. Pass `--sample-rate 44100` or `--sample-rate 48000` to match Kontakt's actual Audio settings. Matching the rate avoids the observed periodic conversion clicks with the AudioBox 22 VSL at 44.1 kHz / 309-frame buffers. In a simultaneous 20-second test, 44.1 kHz capture remained continuous while both 48 kHz PCM16 and float32 produced clicks roughly every 7.2 seconds. Leading/trailing silence and packet gaps retain their position on the performance timeline. A periodic header checkpoint reduces damage if the parent is forcibly killed; graceful `stop` is required for the final exact header. The helper stops before the classic WAV 4 GiB limit (approximately 6.2 hours at 48 kHz or 6.8 hours at 44.1 kHz).

The first packet uses its QPC timestamp to establish the session offset. Subsequent packets follow integer audio-device frame positions when available. Windows process loopback can return zero for every device position; this is reported as `frameCounterMode: "packet-count"`, and valid PCM packets append continuously. It is not counted as a clock reset. Small drift between the system and audio clocks does **not** insert silence or trim valid PCM. Real missing device frames still preserve their gap when the counter is available; invalid timestamps and device-clock resets re-anchor without discarding valid packet data. The final stopped message includes `insertedGapFrames`, `clockResets`, `timestampErrors`, `maxClockDriftMs`, `unavailablePositionPackets`, and `rejectedClockAnchors` for diagnosis.

`clockMap` contains version 1, sampleRate, and at most 4096 monotonically increasing `{wallTime, frame}` anchors. They relate QPC seconds since recording start to the corresponding PCM frame offset. Anchors initially sample every 0.5 seconds, thin adaptively for long takes, and retain the first/latest valid points. The server uses piecewise-linear interpolation to save MIDI `t` in PCM seconds; each event keeps its original capture-clock timestamp in `wallTime`, and the MIDI bytes remain unchanged. `eventTimebase: "audio-pcm"` and `midiClockMapping` identify this conversion in a saved session. Original WAV samples are never resampled or modified. Missing/invalid clock maps leave MIDI timestamps unchanged. Session duration still includes the final wall-duration silence padding. When a device counter is unavailable, missing audio packets cannot be inferred reliably; `discontinuities` remains the OS-reported loss indicator.

Run `dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --self-test` for WAV and synthetic clock-drift regression checks. `node native-audio/analyze-wav.mjs <take.wav> [...]` reads existing PCM16 stereo files and reports peaks, clipped samples, zero gaps and waveform jumps without modifying them. A low peak with short all-zero holes indicates a capture/timing problem rather than level clipping; a limiter cannot reconstruct those missing intervals.

## NDJSON protocol (stdout)

- `processes`: `{supported, osVersion, processes:[{pid,name}]}`. `supported` is an OS version eligibility check; successful `ready` confirms actual API activation.
- `ready`: `{pid,path,sampleRate,channels,bitsPerSample,startedUnixMs,startedMonotonicMs}`. `startedUnixMs` is a wall-clock anchor at capture start. `startedMonotonicMs` is the QPC clock in milliseconds, suitable for alignment to other native QPC timestamps. The WAV's zero corresponds to this start anchor, including initial silence. Start MIDI recording using this anchor, rather than the later moment the parent receives `ready`.
- `level`: `{peak,rms,durationMs,frames}` about ten times per second. `peak` and `rms` are normalized linear amplitude in `[0,1]`.
- `warning`: `{code,message}`. `SILENT_PROCESS_AUDIO` after five seconds with no meaningful signal, or `WAV_SIZE_LIMIT`.
- `stopped`: `{path,reason,frames,durationMs,peak,silent,discontinuities}`. This confirms the WAV header is finalized. Duration is derived from written audio frames. `silent` uses a threshold of 0.0001 to ignore PCM conversion dither.
- `error`: `{message,hresult}` followed by exit code 1. Errors also attempt to finalize any already-open WAV.

Stdin accepts plain `stop`, or a JSON line containing `"stop"`. Unknown commands are ignored.

## Platform and routing

An updated Windows 10 version 2004 (build 19041) or newer is required. Microsoft's sample documents build 20348+, while OBS's process-loopback implementation also supports updated Windows 10 2004+. This implementation was actually activated and smoke-tested on Windows 10 build 19045.

**ASIO or exclusive audio paths can bypass the Windows shared audio engine.** A successful `ready` only confirms capture initialization, not that Kontakt's active driver reaches this capture path. Play a note and inspect `level.peak`. If Kontakt is audible but the meter remains silent, select a compatible WASAPI shared output in Kontakt or set up explicit audio routing. The recorder will not silently capture other applications as a workaround. Recording PID selection does not follow a Kontakt restart; probe again for its new PID.

## Validation

```powershell
dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --self-test
node native-audio/smoke-test.mjs
```

The self-test checks WAV duration, header lengths, sample placement, and silent padding. The live smoke test requires running Kontakt and checks actual process-loopback activation, a temporary one-second recording, and the final WAV header. An idle Kontakt naturally produces a silent take; this alone does not verify audible piano signal or long-session synchronization.

Implementation references:

- [Microsoft ApplicationLoopback sample](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
- [ActivateAudioInterfaceAsync](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync)
- [IAudioCaptureClient timestamps and buffer flags](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer)
- [OBS Windows application audio capture](https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/win-wasapi.cpp)
