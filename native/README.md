# Windows MIDI bridge

Uses the Windows `winmm.dll` MIDI API through C# compiled in memory by the built-in Windows PowerShell. No Python, npm native addon, compiler installation, administrator rights, or custom MIDI driver is needed to **read an already available input**. A virtual cable such as loopMIDI is still needed to route MIDI between Kontakt standalone and this application when no suitable virtual port exists.

Run from Node with `spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true })`. Keep stdin open; closing stdin exits the bridge and releases devices. Only UTF-8 newline-delimited JSON is written to stdout. All device access runs inside this child process, not Electron's renderer.

## Commands

| JSON command | Result |
| --- | --- |
| `{"type":"ports"}` | Current `inputs` and `outputs`, each containing numeric `id` and `name` |
| `{"type":"open","inputId":0}` | Open one selected input; close the prior input; emit `status` |
| `{"type":"close"}` | Close input and emit disconnected `status` |
| `{"type":"send","outputId":1,"data":[144,60,100]}` | Open the explicitly selected output on first use and send a complete short MIDI message |
| `{"type":"panic"}` | Sustain off, all notes off, and all sounds off on every output opened by this process |
| `{"type":"quit"}` | Graceful cleanup and exit |

Add `"requestId":"your-id"` to any command to receive `{"type":"ack","command":"ports","requestId":"your-id"}` after success, or an error with the same request ID. MIDI sends without a request ID have no success response, minimizing playback overhead.

## Events

- Startup: `ready` with protocol version `1`, then `ports`, then disconnected `status`.
- Input: `{"type":"midi","data":[144,60,100],"timestamp":1234.567,"inputId":0}`. Timestamp is milliseconds on the bridge process's monotonic clock, measured at receipt. It is **not** wall clock or browser `performance.now()`; the host should establish its own clock mapping or use receipt time.
- Connection: `{"type":"status","connected":true,"inputId":0,"timestamp":1234.567}`. Disconnected input ID is `null`.
- Failure: `{"type":"error","code":"command-failed","message":"...","requestId":null}`. Port indexes can change after device reconnection; refresh the list and match the user's chosen name.
- Input overflow: error code `input-overflow`. Reset displayed active notes to avoid hangs. The callback queue is capped at 16,384 messages.

The bridge does not forward input to output automatically, preventing software feedback by default. Only explicitly sent short messages go to an output. SysEx is intentionally unsupported. Closing the **input** leaves explicitly opened outputs available for playback; `panic` stops their sound, and process shutdown closes them. A forced operating-system kill cannot run managed cleanup, so the host should request `panic` and `quit` before terminating.

## Verification

`node native/test-bridge.mjs` compiles the bridge, enumerates real device names, validates invalid IDs and command errors, and tests graceful shutdown. It does not play notes or claim that physical MIDI transmission has been tested. To verify a loopback route separately, open a virtual cable's input, explicitly send a note-on and note-off to its matching output, and observe both input events. Do not make the loopback input automatically forward back to itself.

WinMM reference: [Microsoft MIDI functions](https://learn.microsoft.com/en-us/windows/win32/multimedia/midi-functions).
