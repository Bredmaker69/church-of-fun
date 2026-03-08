import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const FFMPEG_CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/esm';
let ffmpegPromise = null;

const formatUnknownError = (error) => {
  if (typeof error === 'string') return error;
  if (error?.message) return String(error.message);
  if (error?.name) return String(error.name);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || 'Unknown error');
  }
};

const toSeconds = (timestamp) => {
  const parts = String(timestamp || '00:00').split(':').map(Number);
  if (parts.some((value) => !Number.isFinite(value))) return 0;
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  return 0;
};

const toTimecode = (totalSeconds) => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
};

const sanitize = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const getExtension = (fileName) => {
  const cleaned = String(fileName || '').trim();
  const dotIndex = cleaned.lastIndexOf('.');
  if (dotIndex < 0) return 'mp4';
  const ext = cleaned.slice(dotIndex + 1).toLowerCase();
  return ext || 'mp4';
};

const computeWaveformBinsFromSamples = ({ samples, sampleRate, targetBins = 1600 }) => {
  const sampleCount = Number(samples?.length || 0);
  if (!sampleCount || !sampleRate) {
    throw new Error('PCM sample data is empty.');
  }

  const durationSeconds = sampleCount / sampleRate;
  const binCount = Math.max(300, Math.min(targetBins, sampleCount));
  const samplesPerBin = sampleCount / binCount;
  const bins = [];

  for (let index = 0; index < binCount; index += 1) {
    const startIndex = Math.floor(index * samplesPerBin);
    const endIndex = Math.max(startIndex + 1, Math.floor((index + 1) * samplesPerBin));
    let peak = 0;
    let rmsAccumulator = 0;
    let rmsCount = 0;

    for (let cursor = startIndex; cursor < endIndex && cursor < sampleCount; cursor += 1) {
      const value = Number(samples[cursor] || 0);
      const absolute = Math.abs(value);
      if (absolute > peak) peak = absolute;
      rmsAccumulator += value * value;
      rmsCount += 1;
    }

    const rms = rmsCount > 0 ? Math.sqrt(rmsAccumulator / rmsCount) : 0;
    bins.push(Number(Math.max(peak * 0.5, rms).toFixed(6)));
  }

  return {
    durationSeconds: Number(durationSeconds.toFixed(3)),
    sampleRate,
    binDurationSeconds: Number((durationSeconds / Math.max(1, bins.length)).toFixed(6)),
    bins,
  };
};

const parseMono16BitWav = (wavBytes) => {
  if (!(wavBytes instanceof Uint8Array) || wavBytes.length < 44) {
    throw new Error('Invalid WAV data.');
  }

  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const readAscii = (offset, length) => String.fromCharCode(...wavBytes.slice(offset, offset + length));
  if (readAscii(0, 4) !== 'RIFF' || readAscii(8, 4) !== 'WAVE') {
    throw new Error('Unsupported WAV container.');
  }

  let offset = 12;
  let audioFormat = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = view.getUint16(chunkDataOffset, true);
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || channelCount !== 1 || bitsPerSample !== 16 || dataOffset < 0 || !sampleRate) {
    throw new Error('Unsupported WAV audio format.');
  }

  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(dataOffset + index * 2, true);
    samples[index] = sample / 32768;
  }

  return { samples, sampleRate };
};

const getFFmpeg = async () => {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      try {
        const ffmpeg = new FFmpeg();
        const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');
        await ffmpeg.load({ coreURL, wasmURL });
        return ffmpeg;
      } catch (error) {
        ffmpegPromise = null;
        throw new Error(`Unable to load ffmpeg.wasm core. ${formatUnknownError(error)}`);
      }
    })();
  }

  return ffmpegPromise;
};

const execOrThrow = async (ffmpeg, args, description) => {
  const exitCode = await ffmpeg.exec(args);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed (${description}) with exit code ${exitCode}`);
  }
};

export const extractAudioWaveformWithFfmpeg = async ({ sourceFile, targetBins = 1600 }) => {
  if (!(sourceFile instanceof File)) {
    throw new Error('Missing source video file.');
  }

  let ffmpeg = null;
  let sourceName = '';
  let outputName = '';
  try {
    ffmpeg = await getFFmpeg();
    const sourceExtension = getExtension(sourceFile.name);
    sourceName = `waveform-source-${Date.now()}.${sourceExtension}`;
    outputName = `waveform-${Date.now()}.wav`;
    const inputData = await fetchFile(sourceFile);
    await ffmpeg.writeFile(sourceName, inputData);

    await execOrThrow(
      ffmpeg,
      ['-i', sourceName, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputName],
      'extract waveform wav'
    );

    const outputData = await ffmpeg.readFile(outputName);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('Unexpected FFmpeg waveform output type.');
    }

    const { samples, sampleRate } = parseMono16BitWav(outputData);
    return computeWaveformBinsFromSamples({ samples, sampleRate, targetBins });
  } catch (error) {
    throw new Error(`Unable to extract waveform with ffmpeg. ${formatUnknownError(error)}`);
  } finally {
    if (ffmpeg && outputName) {
      try {
        await ffmpeg.deleteFile(outputName);
      } catch {
        // best effort cleanup
      }
    }
    if (ffmpeg && sourceName) {
      try {
        await ffmpeg.deleteFile(sourceName);
      } catch {
        // best effort cleanup
      }
    }
  }
};

export const renderLocalClipFiles = async ({ sourceFile, clips, onProgress }) => {
  if (!sourceFile) throw new Error('Missing source video file.');
  if (!Array.isArray(clips) || clips.length === 0) return [];

  const ffmpeg = await getFFmpeg();
  const sourceExtension = getExtension(sourceFile.name);
  const sourceName = `source-${Date.now()}.${sourceExtension}`;
  const inputData = await fetchFile(sourceFile);
  await ffmpeg.writeFile(sourceName, inputData);

  const renderedClips = [];

  try {
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      onProgress?.({ current: i + 1, total: clips.length, clip });

      const start = toSeconds(clip.startTimestamp);
      const end = toSeconds(clip.endTimestamp);
      const duration = Math.max(1, end - start);

      const outputName = `clip-${i + 1}-${Date.now()}.mp4`;
      const clipSlug = sanitize(clip.title) || `clip-${i + 1}`;
      const outputFileName = `${clipSlug}-${i + 1}.mp4`;

      try {
        await execOrThrow(
          ffmpeg,
          ['-ss', toTimecode(start), '-t', String(duration), '-i', sourceName, '-c', 'copy', outputName],
          `stream copy clip ${i + 1}`
        );
      } catch {
        await execOrThrow(
          ffmpeg,
          ['-ss', toTimecode(start), '-t', String(duration), '-i', sourceName, outputName],
          `re-encode clip ${i + 1}`
        );
      }

      const outputData = await ffmpeg.readFile(outputName);
      if (!(outputData instanceof Uint8Array)) {
        throw new Error(`Unexpected output type for clip ${i + 1}`);
      }

      const blob = new Blob([outputData], { type: 'video/mp4' });
      const downloadUrl = URL.createObjectURL(blob);

      renderedClips.push({
        ...clip,
        fileName: outputFileName,
        downloadUrl,
        durationSeconds: duration,
      });

      await ffmpeg.deleteFile(outputName);
    }
  } finally {
    try {
      await ffmpeg.deleteFile(sourceName);
    } catch {
      // best effort cleanup
    }
  }

  return renderedClips;
};
