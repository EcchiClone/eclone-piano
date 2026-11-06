# Windows native components

| Folder   | Purpose                                                           | Details                                            |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `midi/`  | WinMM MIDI input bridge, compiled in memory by Windows PowerShell | [Protocol and usage](midi/README.md)               |
| `audio/` | .NET 9 x64 process-loopback recorder for Kontakt                  | [Build, protocol and limitations](audio/README.md) |

Build the audio helper from the project root with `npm run build:audio`.
Generated `audio/bin/` and `audio/obj/` are not tracked by Git.

Manual diagnostics live in [`scripts/diagnostics/`](../scripts/diagnostics/README.md).
They are separate from the automated test suites: some enumerate devices or
capture a short recording from an explicitly selected Kontakt process.
