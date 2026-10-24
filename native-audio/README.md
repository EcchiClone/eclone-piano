# Kontakt process audio recorder

This helper captures **only the selected process and its child processes**, using Windows process-loopback WASAPI. It never falls back to desktop mix or microphone capture. There are no NuGet dependencies.

## Build and use

Requires the .NET 9 SDK to build and .NET 9 runtime to run. Build from the repository root:

```powershell
dotnet build native-audio/ProcessAudio.csproj -c Release
dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --probe
dotnet native-audio/bin/Release/net9.0-windows/ProcessAudio.dll --pid 19592 --output C:\recordings\take-001.wav
```

The PID above is an example. `--probe` / `--list` returns current Kontakt process IDs. Send `stop` followed by a newline to stdin to finish. EOF and Ctrl+C also stop and finalize the file. Keep a spawned process's stdin pipe open for the entire recording. Optional `--seconds 5` stops after five seconds; it does not override stdin closure. Existing output files are never overwritten.

Output WAV: stereo, 48,000 Hz, signed 16-bit PCM. The audio conversion happens inside WASAPI. Leading/trailing silence and packet gaps retain their position on the performance time line. A periodic header checkpoint reduces damage if the parent is forcibly killed; graceful `stop` is required for the final exact header. The helper stops before the classic WAV 4 GiB limit (approximately 6.2 hours at this format).

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
