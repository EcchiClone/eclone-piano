// A generated stereo PCM16 WAV. Tests supply the signal/envelope they need.
export function pcm16Stereo({ duration, sampleRate, sample }) {
  const frames = Math.round(duration * sampleRate);
  const wave = Buffer.alloc(44 + frames * 4);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 4, 28);
  wave.writeUInt16LE(4, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    const value = Math.round(sample(frame / sampleRate, frame) * 32767);
    wave.writeInt16LE(value, 44 + frame * 4);
    wave.writeInt16LE(value, 46 + frame * 4);
  }
  return wave;
}
