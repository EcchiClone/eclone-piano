// Encode every presentation time, independent of the monitor or wall clock.
// The encoder queue and upload batches stay bounded for long performances.
export async function encodeCanvasFrames({
  canvas,
  duration,
  render,
  signal,
  onChunk,
  onProgress,
}) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined')
    throw new Error('프레임 단위 영상 생성에는 최신 Chrome 또는 Luma 데스크톱 앱이 필요합니다.');
  const fps = 60,
    totalFrames = Math.ceil(duration * fps);
  let config;
  for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software']) {
    const candidate = {
      codec: 'avc1.64002a',
      width: 1920,
      height: 1080,
      bitrate: 18_000_000,
      framerate: fps,
      latencyMode: 'realtime',
      hardwareAcceleration,
      avc: { format: 'annexb' },
    };
    if ((await VideoEncoder.isConfigSupported(candidate)).supported) {
      config = candidate;
      break;
    }
  }
  if (!config)
    throw new Error(
      '이 환경에서 1080p60 H.264 인코더를 사용할 수 없습니다. Luma 데스크톱 앱에서 다시 시도하세요.',
    );
  const report = {
    method: 'offline',
    fps,
    totalFrames,
    renderedFrames: 0,
    encodedFrames: 0,
    width: 1920,
    height: 1080,
    maxEncodeQueue: 0,
    maxBufferedBytes: 0,
  };
  let failure,
    parts = [],
    bufferedBytes = 0;
  const check = () => {
    if (signal.aborted) throw new Error('EXPORT_CANCELLED');
    if (failure) throw failure;
  };
  const encoder = new VideoEncoder({
    output(chunk) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      parts.push(data);
      bufferedBytes += data.byteLength;
      report.encodedFrames++;
      report.maxBufferedBytes = Math.max(report.maxBufferedBytes, bufferedBytes);
      if (bufferedBytes > 32 * 1024 * 1024)
        failure = new Error('영상 인코딩 버퍼 제한을 초과했습니다.');
    },
    error(error) {
      failure = error;
    },
  });
  const upload = async () => {
    if (!parts.length) return;
    const chunk = new Blob(parts, { type: 'application/octet-stream' });
    parts = [];
    bufferedBytes = 0;
    await onChunk(chunk);
    check();
  };
  try {
    encoder.configure(config);
    for (let index = 0; index < totalFrames; index++) {
      check();
      render(index / fps);
      const timestamp = Math.round((index * 1_000_000) / fps);
      const frame = new VideoFrame(canvas, {
        timestamp,
        duration: Math.round(((index + 1) * 1_000_000) / fps) - timestamp,
      });
      try {
        encoder.encode(frame, { keyFrame: index % 120 === 0 });
      } finally {
        frame.close();
      }
      report.renderedFrames++;
      report.maxEncodeQueue = Math.max(report.maxEncodeQueue, encoder.encodeQueueSize);
      if (encoder.encodeQueueSize >= 4 || (index + 1) % 30 === 0) {
        await encoder.flush();
        check();
      }
      if ((index + 1) % 30 === 0 || bufferedBytes >= 2 * 1024 * 1024) await upload();
      onProgress({ ...report });
      // Let progress/cancel input run without requesting display-rate frames.
      if ((index + 1) % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await encoder.flush();
    check();
    await upload();
    if (report.encodedFrames !== totalFrames)
      throw new Error(`영상 프레임이 누락됐습니다 (${report.encodedFrames}/${totalFrames}).`);
    return report;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    parts = [];
  }
}
