using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace PianoVisualizer.Native
{
    // MIDI callbacks run on WinMM threads: never call a PowerShell script block here.
    // The callback only enqueues bytes; the main thread owns every device operation.
    public sealed class MidiBridge : IDisposable
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct InputCaps
        {
            public ushort Manufacturer, Product;
            public uint DriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
            public uint Support;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct OutputCaps
        {
            public ushort Manufacturer, Product;
            public uint DriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
            public ushort Technology, Voices, Notes, ChannelMask;
            public uint Support;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate void MidiInCallback(IntPtr handle, uint message, UIntPtr instance, UIntPtr parameter1, UIntPtr parameter2);
        [DllImport("winmm.dll")] private static extern uint midiInGetNumDevs();
        [DllImport("winmm.dll")] private static extern uint midiOutGetNumDevs();
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern uint midiInGetDevCapsW(UIntPtr device, out InputCaps caps, uint size);
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern uint midiOutGetDevCapsW(UIntPtr device, out OutputCaps caps, uint size);
        [DllImport("winmm.dll")] private static extern uint midiInOpen(out IntPtr handle, uint device, MidiInCallback callback, UIntPtr instance, uint flags);
        [DllImport("winmm.dll")] private static extern uint midiInStart(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint midiInStop(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint midiInReset(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint midiInClose(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint midiOutOpen(out IntPtr handle, uint device, IntPtr callback, UIntPtr instance, uint flags);
        [DllImport("winmm.dll")] private static extern uint midiOutShortMsg(IntPtr handle, uint message);
        [DllImport("winmm.dll")] private static extern uint midiOutReset(IntPtr handle);
        [DllImport("winmm.dll")] private static extern uint midiOutClose(IntPtr handle);
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern uint midiInGetErrorTextW(uint error, StringBuilder text, uint length);
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] private static extern uint midiOutGetErrorTextW(uint error, StringBuilder text, uint length);

        private sealed class MidiPacket
        {
            public uint Packed;
            public double Timestamp;
            public double QpcTimestamp;
            public int Generation;
        }

        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly ConcurrentQueue<MidiPacket> midi = new ConcurrentQueue<MidiPacket>();
        private readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
        private readonly AutoResetEvent wake = new AutoResetEvent(false);
        private readonly Dictionary<int, IntPtr> outputs = new Dictionary<int, IntPtr>();
        private readonly MidiInCallback callback;
        private IntPtr input = IntPtr.Zero;
        private int inputId = -1;
        private int generation;
        private int queuedMessages;
        private int droppedMessages;
        private int malformedMessages;
        private volatile bool eof;
        private volatile bool stopping;
        private bool disposed;

        public MidiBridge() { callback = OnMidi; }

        public static void Run()
        {
            using (MidiBridge bridge = new MidiBridge()) { bridge.Loop(); }
        }

        private void Emit(object value)
        {
            Console.Out.WriteLine(json.Serialize(value));
            Console.Out.Flush();
        }

        private void Loop()
        {
            Emit(new { type = "ready", protocol = 1, backend = "winmm", timestamp = clock.Elapsed.TotalMilliseconds });
            EmitPorts();
            EmitStatus();
            Thread reader = new Thread(delegate()
            {
                try
                {
                    string line;
                    while (!stopping && (line = Console.ReadLine()) != null)
                    {
                        if (line.Length > 65536) { commands.Enqueue("{}"); }
                        else { commands.Enqueue(line); }
                        wake.Set();
                    }
                }
                catch (System.IO.IOException) { }
                finally { eof = true; wake.Set(); }
            });
            reader.IsBackground = true;
            reader.Start();
            ConsoleCancelEventHandler cancel = delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; stopping = true; wake.Set(); };
            Console.CancelKeyPress += cancel;
            try
            {
                while (!stopping)
                {
                    string command;
                    // Bound the command batch so a busy sender cannot starve input events.
                    for (int i = 0; i < 256 && commands.TryDequeue(out command); i++)
                    {
                        HandleCommand(command);
                        if (stopping) break;
                    }
                    MidiPacket packet;
                    while (midi.TryDequeue(out packet))
                    {
                        Interlocked.Decrement(ref queuedMessages);
                        if (packet.Generation != generation || input == IntPtr.Zero) continue;
                        int status = (int)(packet.Packed & 255);
                        int length = MessageLength(status);
                        if (length == 0) continue;
                        int[] bytes = new int[length];
                        for (int i = 0; i < length; i++) bytes[i] = (int)((packet.Packed >> (i * 8)) & 255);
                        Emit(new { type = "midi", data = bytes, timestamp = packet.Timestamp, qpcTimestamp = packet.QpcTimestamp, inputId = inputId });
                    }
                    int dropped = Interlocked.Exchange(ref droppedMessages, 0);
                    if (dropped > 0) Emit(new { type = "error", code = "input-overflow", message = "MIDI input queue overflow; reset active notes.", dropped = dropped });
                    int malformed = Interlocked.Exchange(ref malformedMessages, 0);
                    if (malformed > 0) Emit(new { type = "error", code = "invalid-midi", message = "The MIDI driver reported malformed input.", count = malformed });
                    if (eof && commands.IsEmpty) break;
                    wake.WaitOne(2);
                }
            }
            finally { Console.CancelKeyPress -= cancel; }
        }

        private void OnMidi(IntPtr handle, uint message, UIntPtr instance, UIntPtr parameter1, UIntPtr parameter2)
        {
            if (message == 0x3C5) { Interlocked.Increment(ref malformedMessages); return; }
            if (message != 0x3C3 && message != 0x3CC) return;
            if (Interlocked.Increment(ref queuedMessages) > 16384)
            {
                Interlocked.Decrement(ref queuedMessages);
                Interlocked.Increment(ref droppedMessages);
                return;
            }
            midi.Enqueue(new MidiPacket { Packed = unchecked((uint)parameter1.ToUInt64()), Timestamp = clock.Elapsed.TotalMilliseconds, QpcTimestamp = Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency, Generation = generation });
            wake.Set();
        }

        private static int MessageLength(int status)
        {
            if (status >= 0x80 && status < 0xF0) return (status & 0xE0) == 0xC0 ? 2 : 3;
            if (status == 0xF1 || status == 0xF3) return 2;
            if (status == 0xF2) return 3;
            if (status == 0xF6 || status == 0xF8 || status == 0xFA || status == 0xFB || status == 0xFC || status == 0xFE || status == 0xFF) return 1;
            return 0;
        }

        private static void Check(uint result, string operation, bool isInput)
        {
            if (result == 0) return;
            StringBuilder detail = new StringBuilder(256);
            if (isInput) midiInGetErrorTextW(result, detail, 256);
            else midiOutGetErrorTextW(result, detail, 256);
            throw new InvalidOperationException(operation + " failed (" + result + "): " + detail.ToString());
        }

        private void EmitPorts()
        {
            List<object> ins = new List<object>();
            List<object> outs = new List<object>();
            for (uint i = 0; i < midiInGetNumDevs(); i++)
            {
                InputCaps caps;
                if (midiInGetDevCapsW(new UIntPtr(i), out caps, (uint)Marshal.SizeOf(typeof(InputCaps))) == 0)
                    ins.Add(new { id = i, name = caps.Name });
            }
            for (uint i = 0; i < midiOutGetNumDevs(); i++)
            {
                OutputCaps caps;
                if (midiOutGetDevCapsW(new UIntPtr(i), out caps, (uint)Marshal.SizeOf(typeof(OutputCaps))) == 0)
                    outs.Add(new { id = i, name = caps.Name });
            }
            Emit(new { type = "ports", inputs = ins, outputs = outs });
        }

        private void EmitStatus()
        {
            Emit(new { type = "status", connected = input != IntPtr.Zero, inputId = inputId < 0 ? (int?)null : inputId, timestamp = clock.Elapsed.TotalMilliseconds });
        }

        private void OpenInput(int id)
        {
            if (id < 0 || id >= midiInGetNumDevs()) throw new ArgumentException("MIDI input ID is unavailable. Refresh the port list.");
            if (inputId == id && input != IntPtr.Zero) { EmitStatus(); return; }
            CloseInput(false);
            IntPtr opened;
            Check(midiInOpen(out opened, (uint)id, callback, UIntPtr.Zero, 0x30000 | 0x20), "Open MIDI input", true);
            input = opened;
            inputId = id;
            try { Check(midiInStart(input), "Start MIDI input", true); }
            catch { CloseInput(false); throw; }
            EmitStatus();
        }

        private void CloseInput(bool notify)
        {
            if (input != IntPtr.Zero)
            {
                midiInStop(input);
                midiInReset(input);
                midiInClose(input);
                input = IntPtr.Zero;
            }
            inputId = -1;
            generation++;
            if (notify) EmitStatus();
        }

        private static int GetInteger(Dictionary<string, object> command, string key)
        {
            object value;
            if (!command.TryGetValue(key, out value) || !(value is int)) throw new ArgumentException(key + " must be an integer.");
            return (int)value;
        }

        private void Send(Dictionary<string, object> command)
        {
            int id = GetInteger(command, "outputId");
            if (id < 0 || id >= midiOutGetNumDevs()) throw new ArgumentException("MIDI output ID is unavailable. Refresh the port list.");
            object data;
            if (!command.TryGetValue("data", out data) || !(data is System.Collections.IList)) throw new ArgumentException("data must be a short MIDI byte array.");
            System.Collections.IList bytes = (System.Collections.IList)data;
            if (bytes.Count < 1 || bytes.Count > 3 || !(bytes[0] is int)) throw new ArgumentException("Only complete short MIDI messages are supported.");
            int length = MessageLength((int)bytes[0]);
            if (length == 0 || bytes.Count != length) throw new ArgumentException("MIDI message length does not match its status byte.");
            uint packed = 0;
            for (int i = 0; i < bytes.Count; i++)
            {
                if (!(bytes[i] is int)) throw new ArgumentException("MIDI bytes must be integers.");
                int b = (int)bytes[i];
                if (b < 0 || b > (i == 0 ? 255 : 127)) throw new ArgumentException("MIDI byte is out of range.");
                packed |= (uint)b << (i * 8);
            }
            IntPtr output;
            if (!outputs.TryGetValue(id, out output))
            {
                Check(midiOutOpen(out output, (uint)id, IntPtr.Zero, UIntPtr.Zero, 0), "Open MIDI output", false);
                outputs.Add(id, output);
            }
            Check(midiOutShortMsg(output, packed), "Send MIDI", false);
        }

        private void Panic()
        {
            foreach (IntPtr output in outputs.Values)
            {
                for (int channel = 0; channel < 16; channel++)
                {
                    midiOutShortMsg(output, (uint)(0xB0 | channel | (64 << 8)));
                    midiOutShortMsg(output, (uint)(0xB0 | channel | (123 << 8)));
                    midiOutShortMsg(output, (uint)(0xB0 | channel | (120 << 8)));
                }
                midiOutReset(output);
            }
        }

        private void HandleCommand(string line)
        {
            object requestId = null;
            try
            {
                Dictionary<string, object> command = json.Deserialize<Dictionary<string, object>>(line);
                if (command == null) throw new ArgumentException("Expected a JSON command object.");
                command.TryGetValue("requestId", out requestId);
                object commandType;
                if (!command.TryGetValue("type", out commandType) || !(commandType is string)) throw new ArgumentException("Command type is required.");
                string type = (string)commandType;
                switch (type)
                {
                    case "ports": EmitPorts(); break;
                    case "open": OpenInput(GetInteger(command, "inputId")); break;
                    case "close": CloseInput(true); break;
                    case "send": Send(command); break;
                    case "panic": Panic(); Emit(new { type = "panic", timestamp = clock.Elapsed.TotalMilliseconds }); break;
                    case "quit": stopping = true; break;
                    default: throw new ArgumentException("Unknown command: " + type);
                }
                if (requestId != null) Emit(new { type = "ack", command = type, requestId = requestId });
            }
            catch (Exception ex)
            {
                Emit(new { type = "error", code = "command-failed", message = ex.Message, requestId = requestId });
                EmitStatus();
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            stopping = true;
            CloseInput(false);
            Panic();
            foreach (IntPtr output in outputs.Values) midiOutClose(output);
            outputs.Clear();
            disposed = true;
            GC.KeepAlive(callback);
            // A blocked background Console.ReadLine may still own wake until process exit.
        }
    }
}
