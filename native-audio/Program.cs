using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace PianoVisualizer.Audio;

internal static class Program
{
    private static readonly object OutputLock = new();
    internal static void Emit(object value)
    {
        lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value));
    }

    [MTAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Contains("--self-test")) return SelfTest.Run();
            if (args.Contains("--list") || args.Contains("--probe"))
            {
                var processes = Process.GetProcesses().Where(p => p.ProcessName.StartsWith("Kontakt", StringComparison.OrdinalIgnoreCase))
                    .Select(p => new { pid = p.Id, name = p.ProcessName }).ToArray();
                Emit(new { type = "processes", supported = OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041),
                    osVersion = Environment.OSVersion.Version.ToString(), processes });
                return 0;
            }
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
                throw new PlatformNotSupportedException("Process audio capture requires an updated Windows 10 version 2004 or newer. No desktop-audio fallback is used.");
            string? Value(string key)
            {
                var index = Array.IndexOf(args, key);
                return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
            }
            if (!int.TryParse(Value("--pid"), out var pid) || pid <= 0 || Value("--output") is not string output)
                throw new ArgumentException("Usage: ProcessAudio --pid <process id> --output <new .wav path> [--seconds <duration>] | --probe | --self-test");
            using var process = Process.GetProcessById(pid);
            var path = Path.GetFullPath(output);
            if (!Path.GetExtension(path).Equals(".wav", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Output must have a .wav extension.");
            double limit = double.TryParse(Value("--seconds"), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var seconds) ? seconds : 0;
            if (limit < 0 || !double.IsFinite(limit)) throw new ArgumentException("Duration must be finite and positive.");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using var stop = new ManualResetEvent(false);
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Set(); };
            using var capture = new ProcessLoopback((uint)pid, path);
            // Leave stdin open while capturing. Parent exit / pipe closure also finishes the WAV.
            _ = Task.Run(() =>
            {
                while (true)
                {
                    var line = Console.ReadLine();
                    if (line is null || line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase) || line.Contains("\"stop\""))
                    {
                        try { stop.Set(); } catch (ObjectDisposedException) { }
                        return;
                    }
                }
            });
            capture.Run(stop, process, limit);
            return 0;
        }
        catch (Exception exception)
        {
            Emit(new { type = "error", message = exception.Message, hresult = $"0x{exception.HResult:X8}" });
            return 1;
        }
    }
}

internal sealed class ProcessLoopback : IDisposable
{
    private const uint SampleRate = 48000;
    private readonly AutoResetEvent sampleEvent = new(false);
    private readonly WaveWriter writer;
    private IAudioClient? audioClient;
    private IAudioCaptureClient? captureClient;
    private bool started;
    private readonly uint pid;
    private readonly string path;
    private long startedTicks;
    private PacketTimeline? timeline;
    private double maxPeak;
    private double peak;
    private double squareSum;
    private long samples;
    private int discontinuities;
    private bool warnedSilence;
    private readonly List<object> packetDiagnostics = new();
    private byte[] buffer = new byte[48000];

    internal ProcessLoopback(uint pid, string path)
    {
        this.pid = pid;
        this.path = path;
        // CreateNew prevents a mistaken file selection from destroying an earlier take.
        writer = new WaveWriter(path, SampleRate, 2, 16);
        try
        {
            audioClient = Activate(pid);
            var format = new WaveFormat { FormatTag = 1, Channels = 2, SamplesPerSecond = SampleRate,
                AverageBytesPerSecond = SampleRate * 4, BlockAlign = 4, BitsPerSample = 16, ExtraSize = 0 };
            // Shared process loopback converts the process stream to a predictable edit-friendly format.
            Check(audioClient.Initialize(0, 0x80000000u | 0x08000000u | 0x00020000u | 0x00040000u,
                0, 0, ref format, IntPtr.Zero), "Initialize process loopback");
            var captureId = typeof(IAudioCaptureClient).GUID;
            Check(audioClient.GetService(ref captureId, out var service), "Get capture client");
            captureClient = (IAudioCaptureClient)service;
            Check(audioClient.SetEventHandle(sampleEvent.SafeWaitHandle.DangerousGetHandle()), "Set audio event");
        }
        catch { Dispose(); throw; }
    }

    private static IAudioClient Activate(uint pid)
    {
        var parameters = new ActivationParameters { ActivationType = 1, TargetProcessId = pid, ProcessLoopbackMode = 0 };
        var memory = Marshal.AllocHGlobal(Marshal.SizeOf<ActivationParameters>());
        var callback = new ActivationCallback();
        IActivateAudioInterfaceAsyncOperation? operation = null;
        try
        {
            Marshal.StructureToPtr(parameters, memory, false);
            var variant = new BlobVariant { Type = 65, BlobSize = (uint)Marshal.SizeOf<ActivationParameters>(), BlobData = memory };
            var clientId = typeof(IAudioClient).GUID;
            Check(Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref clientId, ref variant, callback, out operation),
                "Activate process loopback");
            if (!callback.Completed.WaitOne(TimeSpan.FromSeconds(15)))
                throw new TimeoutException("Windows did not activate process audio capture within 15 seconds.");
            Check(callback.Result, "Activate audio client");
            return callback.Client ?? throw new InvalidOperationException("Windows returned no process audio client.");
        }
        finally
        {
            // The activation parameters are copied by ActivateAudioInterfaceAsync.
            Marshal.FreeHGlobal(memory);
            if (operation is not null) Marshal.ReleaseComObject(operation);
            GC.KeepAlive(callback);
        }
    }

    internal void Run(WaitHandle stop, Process target, double limitSeconds)
    {
        startedTicks = Stopwatch.GetTimestamp();
        timeline = new PacketTimeline(SampleRate, startedTicks / (double)Stopwatch.Frequency);
        long startedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Check(audioClient!.Start(), "Start audio capture");
        started = true;
        Program.Emit(new { type = "ready", pid, path, sampleRate = SampleRate, channels = 2, bitsPerSample = 16,
            startedUnixMs, startedMonotonicMs = startedTicks * 1000d / Stopwatch.Frequency });
        var handles = new[] { stop, sampleEvent };
        double lastLevel = 0;
        string reason = "requested";
        while (true)
        {
            var signaled = WaitHandle.WaitAny(handles, 100);
            if (signaled == 0) break;
            Drain();
            var elapsed = ElapsedSeconds;
            if (elapsed - lastLevel >= 0.1)
            {
                Program.Emit(new { type = "level", peak, rms = samples > 0 ? Math.Sqrt(squareSum / samples) : 0,
                    durationMs = Math.Round(elapsed * 1000), frames = writer.Frames });
                peak = 0; squareSum = 0; samples = 0;
                if ((int)elapsed != (int)lastLevel) writer.Checkpoint();
                lastLevel = elapsed;
            }
            if (!warnedSilence && elapsed >= 5 && maxPeak < 0.0001)
            {
                warnedSilence = true;
                Program.Emit(new { type = "warning", code = "SILENT_PROCESS_AUDIO",
                    message = "No Kontakt audio has been captured. Play a note. If Kontakt is audible but this meter stays silent, its ASIO/exclusive driver may bypass Windows shared audio; use WASAPI shared output or an explicit audio-routing solution." });
            }
            if (target.HasExited) { reason = "process-exited"; break; }
            if (limitSeconds > 0 && elapsed >= limitSeconds) { reason = "duration"; break; }
            if (writer.DataBytes >= uint.MaxValue - 1024 * 1024)
            {
                reason = "wav-size-limit";
                Program.Emit(new { type = "warning", code = "WAV_SIZE_LIMIT", message = "Recording stopped before the 4 GiB WAV limit. Start another take." });
                break;
            }
        }
        var duration = ElapsedSeconds;
        Check(audioClient.Stop(), "Stop audio capture");
        started = false;
        Drain();
        // Include silent leading/trailing periods so the file time line matches the MIDI session.
        writer.PadToFrame((long)Math.Round(duration * SampleRate));
        writer.Checkpoint();
        Program.Emit(new { type = "stopped", path, reason, frames = writer.Frames,
            durationMs = writer.Frames * 1000d / SampleRate, peak = maxPeak, silent = maxPeak < 0.0001, discontinuities,
            insertedGapFrames = timeline.InsertedGapFrames, clockResets = timeline.PositionResets,
            timestampErrors = timeline.TimestampErrors, maxClockDriftMs = timeline.MaxQpcDriftFrames * 1000d / SampleRate,
            frameCounterMode = timeline.FrameCounterMode, unavailablePositionPackets = timeline.UnavailablePositionPackets,
            rejectedClockAnchors = timeline.RejectedClockAnchors,
            clockMap = new { version = 1, sampleRate = SampleRate, anchors = timeline.GetClockAnchors() },
            packetDiagnostics });
    }

    private double ElapsedSeconds => (Stopwatch.GetTimestamp() - startedTicks) / (double)Stopwatch.Frequency;

    private void Drain()
    {
        while (true)
        {
            Check(captureClient!.GetNextPacketSize(out var available), "Read capture packet size");
            if (available == 0) return;
            Check(captureClient.GetBuffer(out var data, out var frames, out var flags, out var devicePosition, out var qpc), "Read capture packet");
            if (frames == 0) return;
            try
            {
                var byteCount = checked((int)frames * 4);
                if (buffer.Length < byteCount) buffer = new byte[byteCount];
                if ((flags & 2) != 0 || data == IntPtr.Zero) Array.Clear(buffer, 0, byteCount);
                else Marshal.Copy(data, buffer, 0, byteCount);
                if ((flags & 1) != 0) discontinuities++;
                // Keep contiguous audio intact even when QPC and audio clocks drift.
                // Only device-frame gaps indicate missing samples after the initial anchor.
                long offset = timeline!.GetOffset(frames, flags, devicePosition, qpc, writer.Frames);
                if (packetDiagnostics.Count < 8)
                    packetDiagnostics.Add(new { frames, flags, devicePosition, qpc, writtenFrame = writer.Frames, offset });
                var skippedFrames = (int)Math.Min(frames, Math.Max(0, writer.Frames - offset));
                if (offset > writer.Frames) writer.PadToFrame(offset);
                for (var i = skippedFrames * 4; i < byteCount; i += 2)
                {
                    double sample = (short)(buffer[i] | buffer[i + 1] << 8) / 32768d;
                    var absolute = Math.Abs(sample);
                    peak = Math.Max(peak, absolute);
                    maxPeak = Math.Max(maxPeak, absolute);
                    squareSum += sample * sample;
                    samples++;
                }
                writer.Write(buffer, skippedFrames * 4, byteCount - skippedFrames * 4);
            }
            finally { Check(captureClient.ReleaseBuffer(frames), "Release capture packet"); }
        }
    }

    internal static void Check(int result, string action)
    {
        if (result < 0) throw new COMException($"{action} failed (0x{result:X8}): {Marshal.GetExceptionForHR(result)?.Message}", result);
    }

    public void Dispose()
    {
        if (started && audioClient is not null) { audioClient.Stop(); started = false; }
        if (captureClient is not null) { Marshal.ReleaseComObject(captureClient); captureClient = null; }
        if (audioClient is not null) { Marshal.ReleaseComObject(audioClient); audioClient = null; }
        writer.Dispose();
        sampleEvent.Dispose();
    }
}

internal sealed class WaveWriter : IDisposable
{
    private readonly FileStream stream;
    private readonly BinaryWriter writer;
    private readonly ushort blockAlign;
    private readonly byte[] silence = new byte[192000];
    private bool disposed;
    internal long DataBytes { get; private set; }
    internal long Frames => DataBytes / blockAlign;
    internal WaveWriter(string path, uint rate, ushort channels, ushort bits)
    {
        blockAlign = (ushort)(channels * bits / 8);
        stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
        writer = new BinaryWriter(stream, Encoding.ASCII, true);
        writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36u); writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        writer.Write(16u); writer.Write((ushort)1); writer.Write(channels); writer.Write(rate);
        writer.Write(rate * blockAlign); writer.Write(blockAlign); writer.Write(bits);
        writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(0u);
    }
    internal void Write(byte[] bytes, int offset, int count)
    {
        if (count % blockAlign != 0) throw new ArgumentException("Audio data must contain complete frames.");
        if (DataBytes + count > uint.MaxValue - 36) throw new IOException("The WAV file has reached its 4 GiB limit.");
        stream.Write(bytes, offset, count); DataBytes += count;
    }
    internal void PadToFrame(long frame)
    {
        long remaining = Math.Max(0, frame * blockAlign - DataBytes);
        while (remaining > 0)
        {
            int count = (int)Math.Min(remaining, silence.Length);
            Write(silence, 0, count); remaining -= count;
        }
    }
    internal void Checkpoint()
    {
        stream.Position = 4; writer.Write(checked((uint)DataBytes + 36));
        stream.Position = 40; writer.Write(checked((uint)DataBytes));
        stream.Position = 44 + DataBytes; writer.Flush(); stream.Flush();
    }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try { Checkpoint(); } finally { writer.Dispose(); stream.Dispose(); }
    }
}

internal static class SelfTest
{
    internal static int Run()
    {
        string path = Path.Combine(Path.GetTempPath(), $"piano-audio-test-{Guid.NewGuid():N}.wav");
        try
        {
            using (var writer = new WaveWriter(path, 48000, 2, 16))
            {
                writer.PadToFrame(2400);
                writer.Write(new byte[] { 255, 127, 0, 128 }, 0, 4);
                writer.PadToFrame(4800);
                writer.Checkpoint();
            }
            var bytes = File.ReadAllBytes(path);
            if (bytes.Length != 19244 || BitConverter.ToUInt32(bytes, 4) != 19236 || BitConverter.ToUInt32(bytes, 40) != 19200 ||
                BitConverter.ToUInt32(bytes, 24) != 48000 || bytes[44 + 2400 * 4] != 255 || bytes[44 + 2400 * 4 + 3] != 128)
                throw new Exception("WAV header, duration, or PCM sample test failed.");
            TestPacketTimeline();
            Program.Emit(new { type = "self-test", passed = true, frames = 4800, bytes = bytes.Length,
                tests = new[] { "wave-header", "pcm-samples", "qpc-clock-drift", "device-frame-gap", "timestamp-recovery", "device-clock-reset", "initial-frame-anchor", "unavailable-device-counter", "bounded-clock-map" } });
            return 0;
        }
        finally { File.Delete(path); }
    }

    private static void TestPacketTimeline()
    {
        const ulong startQpc = 10_000_000_000;
        const uint packetFrames = 480;
        var timeline = new PacketTimeline(48000, startQpc / 10_000_000d);
        long written = 0;
        // 20s of contiguous PCM with 0.1% QPC drift used to inject 241 zeros
        // about every 5s. It must now remain exactly contiguous after its anchor.
        for (uint packet = 0; packet < 2000; packet++)
        {
            ulong qpc = startQpc + 50_000 + packet * 100_100UL;
            long offset = timeline.GetOffset(packetFrames, 0, packet * (ulong)packetFrames, qpc, written);
            long expected = 240 + packet * packetFrames;
            if (offset != expected) throw new Exception($"Clock drift inserted or dropped PCM at packet {packet}.");
            written = offset + packetFrames;
        }
        if (written != 960240 || timeline.InsertedGapFrames != 0 || timeline.MaxQpcDriftFrames < 900)
            throw new Exception("Continuous audio clock-drift regression failed.");

        var gaps = new PacketTimeline(48000, startQpc / 10_000_000d);
        if (gaps.GetOffset(480, 0, 0, startQpc, 0) != 0 ||
            gaps.GetOffset(480, 0, 480, startQpc + 100_000, 480) != 480 ||
            gaps.GetOffset(480, 1, 1440, startQpc + 300_000, 960) != 1440 ||
            gaps.InsertedGapFrames != 480)
            throw new Exception("Actual device-frame gaps were not preserved.");
        if (gaps.GetOffset(480, 4, 999999, 0, 1920) != 1920 ||
            gaps.GetOffset(480, 0, 2400, startQpc + 600_000, 2400) != 2400 ||
            gaps.TimestampErrors != 1)
            throw new Exception("Invalid timestamps must not drop valid PCM.");
        if (gaps.GetOffset(480, 1, 0, startQpc + 700_000, 2880) != 2880 || gaps.PositionResets != 1)
            throw new Exception("Device clock reset must re-anchor without cutting audio.");

        var anchor = new PacketTimeline(48000, startQpc / 10_000_000d);
        // A buffer may begin slightly before Start's wall-clock anchor, and the
        // device counter need not begin at zero. Only pre-session frames trim.
        if (anchor.GetOffset(480, 0, 10000, startQpc - 50_000, 0) != -240 ||
            anchor.GetOffset(480, 0, 10480, startQpc + 50_000, 240) != 240 ||
            anchor.InsertedGapFrames != 0)
            throw new Exception("Initial frame anchor did not preserve a non-zero device origin.");

        var unavailable = new PacketTimeline(48000, startQpc / 10_000_000d);
        for (uint packet = 0; packet < 1000; packet++)
        {
            long offset = unavailable.GetOffset(336, 0, 0, startQpc + packet * 70_068UL, packet * 336);
            if (offset != packet * 336) throw new Exception("Unavailable device counter interrupted contiguous PCM.");
        }
        var anchors = unavailable.GetClockAnchors();
        if (unavailable.PositionResets != 0 || unavailable.UnavailablePositionPackets != 999 ||
            unavailable.FrameCounterMode != "packet-count" || unavailable.InsertedGapFrames != 0 ||
            anchors.Length < 10 || anchors[0].frame != 0 || anchors[^1].frame != 999 * 336 ||
            unavailable.MaxQpcDriftFrames < 300)
            throw new Exception("Unavailable frame counter or QPC-to-PCM clock map regression failed.");
        var longTake = new PacketTimeline(48000, startQpc / 10_000_000d);
        for (uint packet = 0; packet < 20000; packet++)
            longTake.GetOffset(48000, 0, 0, startQpc + packet * 10_010_000UL, packet * 48000L);
        var bounded = longTake.GetClockAnchors();
        if (bounded.Length > 4096 || bounded[0].frame != 0 || bounded[^1].frame != 19999 * 48000L)
            throw new Exception("Clock-map bounds lost the beginning or end of a long take.");
    }
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
internal struct WaveFormat
{
    internal ushort FormatTag, Channels;
    internal uint SamplesPerSecond, AverageBytesPerSecond;
    internal ushort BlockAlign, BitsPerSample, ExtraSize;
}
[StructLayout(LayoutKind.Sequential)]
internal struct ActivationParameters { internal int ActivationType; internal uint TargetProcessId; internal int ProcessLoopbackMode; }
[StructLayout(LayoutKind.Explicit, Size = 24)]
internal struct BlobVariant
{
    [FieldOffset(0)] internal ushort Type;
    [FieldOffset(8)] internal uint BlobSize;
    [FieldOffset(16)] internal IntPtr BlobData;
}
internal static class Native
{
    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    internal static extern int ActivateAudioInterfaceAsync(string deviceInterfacePath, ref Guid iid,
        ref BlobVariant activationParams, IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation operation);
}
[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceAsyncOperation
{
    [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object audioInterface);
}
[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceCompletionHandler
{
    [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}
[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAgileObject { }
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
internal sealed class ActivationCallback : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    internal readonly ManualResetEvent Completed = new(false);
    internal int Result;
    internal IAudioClient? Client;
    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        try
        {
            Result = operation.GetActivateResult(out var activationResult, out var activated);
            if (Result >= 0) Result = activationResult;
            if (Result >= 0) Client = (IAudioClient)activated;
        }
        catch (Exception exception) { Result = exception.HResult; }
        finally { Completed.Set(); }
        return 0;
    }
}
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, uint flags, long duration, long periodicity, ref WaveFormat format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr eventHandle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}
