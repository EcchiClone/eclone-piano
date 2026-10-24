namespace PianoVisualizer.Audio;

/// <summary>
/// Anchors the first audio packet to the session clock, then follows the audio
/// device's integer frame positions. QPC is a timestamp, not a sample counter:
/// repeatedly padding/trimming to its rounded wall time creates audible gaps
/// when the audio and system clocks differ slightly.
/// </summary>
internal sealed class PacketTimeline
{
    private readonly uint sampleRate;
    private readonly double startedSeconds;
    private bool initialized;
    private bool anchored;
    private long anchorDevice;
    private long anchorFrame;
    private long expectedDevice;
    private long previousDevice;
    private int progressingPositionPackets;
    private readonly List<ClockAnchor> clockAnchors = new();
    private ClockAnchor? latestClockAnchor;
    private double anchorIntervalSeconds = 0.5;
    private const int MaximumClockAnchors = 4096;

    internal long InsertedGapFrames { get; private set; }
    internal int PositionResets { get; private set; }
    internal int TimestampErrors { get; private set; }
    internal long MaxQpcDriftFrames { get; private set; }
    internal int UnavailablePositionPackets { get; private set; }
    internal int RejectedClockAnchors { get; private set; }
    internal string FrameCounterMode => UnavailablePositionPackets > 0
        ? (progressingPositionPackets > 0 ? "mixed" : "packet-count")
        : (progressingPositionPackets > 0 ? "device-frames" : "unconfirmed");

    internal sealed record ClockAnchor(double wallTime, long frame);

    internal ClockAnchor[] GetClockAnchors()
    {
        var result = clockAnchors.ToList();
        if (latestClockAnchor is not null && result.LastOrDefault() != latestClockAnchor)
            result.Add(latestClockAnchor);
        return result.ToArray();
    }

    internal PacketTimeline(uint sampleRate, double startedSeconds)
    {
        this.sampleRate = sampleRate;
        this.startedSeconds = startedSeconds;
    }

    internal long GetOffset(uint frames, uint flags, ulong devicePosition, ulong qpc, long writtenFrames)
    {
        bool valid = (flags & 4) == 0 && devicePosition <= long.MaxValue;
        long device = valid ? (long)devicePosition : 0;
        long qpcFrame = valid && qpc != 0
            ? (long)Math.Round((qpc / 10_000_000d - startedSeconds) * sampleRate)
            : writtenFrames;

        if (!initialized)
        {
            initialized = true;
            anchored = valid;
            anchorDevice = device;
            anchorFrame = qpcFrame;
            expectedDevice = device + frames;
            previousDevice = device;
            if (!valid) TimestampErrors++;
            return ObserveClock(valid, qpc, qpcFrame);
        }

        // A timestamp-error packet is still valid PCM. Append it intact, then
        // re-anchor the next trustworthy frame position without cutting audio.
        if (!valid)
        {
            TimestampErrors++;
            anchored = false;
            return writtenFrames;
        }
        if (device == previousDevice)
        {
            // Windows process-loopback can return zero for every device frame
            // position. That is an unavailable counter, not a reset per packet.
            UnavailablePositionPackets++;
            anchored = false;
            expectedDevice = device + frames;
            return ObserveClock(true, qpc, writtenFrames);
        }
        progressingPositionPackets++;
        if (!anchored || device < expectedDevice)
        {
            if (anchored) PositionResets++;
            anchored = true;
            anchorDevice = device;
            anchorFrame = writtenFrames;
        }
        long offset = anchorFrame + device - anchorDevice;
        previousDevice = device;
        expectedDevice = device + frames;
        if (offset > writtenFrames) InsertedGapFrames += offset - writtenFrames;
        return ObserveClock(true, qpc, offset);
    }

    private long ObserveClock(bool valid, ulong qpc, long offset)
    {
        if (!valid || qpc == 0) return offset;
        var wallTime = qpc / 10_000_000d - startedSeconds;
        MaxQpcDriftFrames = Math.Max(MaxQpcDriftFrames, Math.Abs((long)Math.Round(wallTime * sampleRate) - offset));
        if (latestClockAnchor is not null &&
            (wallTime <= latestClockAnchor.wallTime || offset <= latestClockAnchor.frame))
        {
            RejectedClockAnchors++;
            return offset;
        }
        latestClockAnchor = new ClockAnchor(wallTime, offset);
        if (clockAnchors.Count == 0 || wallTime - clockAnchors[^1].wallTime >= anchorIntervalSeconds)
        {
            // Keep the whole take represented, with bounded output/memory even
            // for multi-hour recordings; always retain first and latest points.
            if (clockAnchors.Count >= MaximumClockAnchors - 1)
            {
                var retained = clockAnchors.Where((_, index) => index % 2 == 0).ToArray();
                clockAnchors.Clear();
                clockAnchors.AddRange(retained);
                anchorIntervalSeconds *= 2;
            }
            clockAnchors.Add(latestClockAnchor);
        }
        return offset;
    }
}
