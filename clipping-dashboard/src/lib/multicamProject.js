import { extractAudioWaveformWithFfmpeg } from './localClipper';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const cleanLabel = (value, fallback) => {
  const text = String(value || '').trim();
  return text || fallback;
};

const createObjectUrl = (file) => {
  return new Promise((resolve, reject) => {
    try {
      resolve(URL.createObjectURL(file));
    } catch (error) {
      reject(error);
    }
  });
};

const loadVideoMetadata = async (file) => {
  const objectUrl = await createObjectUrl(file);

  try {
    const metadata = await new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      let settled = false;

      const cleanup = () => {
        settled = true;
        video.removeAttribute('src');
        video.load();
      };

      const resolveIfReady = () => {
        if (settled) return;
        const durationSeconds = Number(video.duration || 0);
        const width = Number(video.videoWidth || 0);
        const height = Number(video.videoHeight || 0);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
        resolve({
          durationSeconds,
          width,
          height,
        });
        cleanup();
      };

      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`Timed out reading video metadata for ${file.name}`));
      }, 12000);

      const finish = (callback) => {
        if (settled) return;
        window.clearTimeout(timeoutId);
        callback();
      };

      video.onloadedmetadata = () => finish(resolveIfReady);
      video.onloadeddata = () => finish(resolveIfReady);
      video.oncanplay = () => finish(resolveIfReady);

      video.onerror = () => {
        finish(() => {
          const mediaErrorCode = Number(video.error?.code || 0);
          cleanup();
          reject(new Error(`Unable to read video metadata for ${file.name}${mediaErrorCode ? ` (media error ${mediaErrorCode})` : ''}`));
        });
      };

      video.src = objectUrl;
      video.load();
    });

    return metadata;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const getAudioContextCtor = () => window.AudioContext || window.webkitAudioContext;

const loadAudioDuration = async (file) => {
  if (!(file instanceof File)) {
    throw new Error('Expected a File when loading audio duration.');
  }

  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    throw new Error('Web Audio API is unavailable in this browser.');
  }

  const audioContext = new AudioContextCtor();
  try {
    const sourceBuffer = await file.arrayBuffer();
    const decodedBuffer = await audioContext.decodeAudioData(sourceBuffer.slice(0));
    const durationSeconds = Number(decodedBuffer.duration || 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Decoded audio duration is empty.');
    }
    return {
      durationSeconds,
    };
  } catch (error) {
    try {
      const waveform = await extractAudioWaveformWithFfmpeg({ sourceFile: file, targetBins: 400 });
      return {
        durationSeconds: Number(waveform.durationSeconds || 0),
        decodeWarning: String(error?.message || 'Primary audio decode failed. Used FFmpeg fallback duration.'),
      };
    } catch (fallbackError) {
      return {
        durationSeconds: 0,
        decodeWarning: [
          String(error?.message || 'Primary audio decode failed.'),
          String(fallbackError?.message || 'FFmpeg fallback duration failed.'),
        ].filter(Boolean).join(' '),
      };
    }
  } finally {
    audioContext.close().catch(() => {});
  }
};

export const probeLocalMediaAsset = async (file, assetId, label) => {
  if (!(file instanceof File)) {
    throw new Error('Expected a File when probing local media asset.');
  }

  let metadata;
  let metadataWarning = '';
  try {
    metadata = await loadVideoMetadata(file);
  } catch (error) {
    const audioFallback = await loadAudioDuration(file);
    metadata = {
      durationSeconds: Number(audioFallback.durationSeconds || 0),
      width: 0,
      height: 0,
    };
    metadataWarning = [
      String(error?.message || 'Video metadata unavailable.'),
      String(audioFallback?.decodeWarning || ''),
    ].filter(Boolean).join(' ');
  }

  return {
    id: String(assetId || ''),
    label: cleanLabel(label, file.name),
    fileName: String(file.name || ''),
    mimeType: String(file.type || 'video/mp4'),
    sizeBytes: Number(file.size || 0),
    durationSeconds: Number((metadata.durationSeconds || 0).toFixed(3)),
    width: Number(metadata.width || 0),
    height: Number(metadata.height || 0),
    hasEmbeddedAudio: true,
    metadataWarning,
  };
};

export const extractLocalAudioWaveform = async (file, { targetBins = 1600 } = {}) => {
  if (!(file instanceof File)) {
    throw new Error('Expected a File when extracting waveform.');
  }

  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    throw new Error('Web Audio API is unavailable in this browser.');
  }

  const audioContext = new AudioContextCtor();

  try {
    const sourceBuffer = await file.arrayBuffer();
    const decodedBuffer = await audioContext.decodeAudioData(sourceBuffer.slice(0));
    const sampleCount = Number(decodedBuffer.length || 0);
    const sampleRate = Number(decodedBuffer.sampleRate || 0);
    const durationSeconds = Number(decodedBuffer.duration || 0);
    if (!sampleCount || !sampleRate || !durationSeconds) {
      throw new Error('Decoded audio is empty.');
    }

    const channelCount = Math.max(1, Number(decodedBuffer.numberOfChannels || 1));
    const channelData = Array.from({ length: channelCount }, (_, index) => decodedBuffer.getChannelData(index));
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
        for (let channel = 0; channel < channelData.length; channel += 1) {
          const value = channelData[channel][cursor] || 0;
          const absolute = Math.abs(value);
          if (absolute > peak) peak = absolute;
          rmsAccumulator += value * value;
          rmsCount += 1;
        }
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
  } catch (error) {
    const fallbackWaveform = await extractAudioWaveformWithFfmpeg({ sourceFile: file, targetBins });
    return {
      ...fallbackWaveform,
      decodeWarning: String(error?.message || 'Primary audio decode failed. Used FFmpeg fallback waveform.'),
    };
  } finally {
    audioContext.close().catch(() => {});
  }
};

export const estimateScratchAudioSync = ({
  waveformA,
  waveformB,
  maxOffsetSeconds = 30,
}) => {
  const binsA = Array.isArray(waveformA?.bins) ? waveformA.bins : [];
  const binsB = Array.isArray(waveformB?.bins) ? waveformB.bins : [];
  const binDurationSeconds = Math.max(
    Number(waveformA?.binDurationSeconds || 0),
    Number(waveformB?.binDurationSeconds || 0),
    0
  );

  if (binsA.length < 40 || binsB.length < 40 || !binDurationSeconds) {
    return {
      offsetSeconds: 0,
      confidence: 0,
      method: 'insufficient-waveform-data',
    };
  }

  const meanA = binsA.reduce((sum, value) => sum + value, 0) / binsA.length;
  const meanB = binsB.reduce((sum, value) => sum + value, 0) / binsB.length;
  const centeredA = binsA.map((value) => value - meanA);
  const centeredB = binsB.map((value) => value - meanB);
  const maxLagBins = Math.max(1, Math.floor(maxOffsetSeconds / binDurationSeconds));

  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let lag = -maxLagBins; lag <= maxLagBins; lag += 1) {
    const startA = lag > 0 ? 0 : -lag;
    const startB = lag > 0 ? lag : 0;
    const overlap = Math.min(centeredA.length - startA, centeredB.length - startB);
    if (overlap < 30) continue;

    let dot = 0;
    let energyA = 0;
    let energyB = 0;

    for (let index = 0; index < overlap; index += 1) {
      const valueA = centeredA[startA + index];
      const valueB = centeredB[startB + index];
      dot += valueA * valueB;
      energyA += valueA * valueA;
      energyB += valueB * valueB;
    }

    const denom = Math.sqrt(energyA * energyB);
    if (!denom) continue;
    const score = dot / denom;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  return {
    offsetSeconds: Number((bestLag * binDurationSeconds).toFixed(3)),
    confidence: Number(clamp((bestScore + 1) / 2, 0, 1).toFixed(3)),
    method: 'waveform-correlation',
  };
};

export const getMulticamCameraIdForShotId = (shotIdRaw) => {
  const shotId = String(shotIdRaw || '').trim().toUpperCase();
  return shotId.endsWith('B') ? 'camera2' : 'camera1';
};

export const createDefaultMulticamShotPresets = () => ([
  {
    id: '1A',
    cameraId: 'camera1',
    label: 'Full A',
    zoom: 1,
    panX: 0,
    panY: 0,
    enabled: true,
    locked: true,
  },
  {
    id: '2A',
    cameraId: 'camera1',
    label: 'Left A',
    zoom: 1.85,
    panX: -22,
    panY: 0,
    enabled: true,
    locked: true,
  },
  {
    id: '3A',
    cameraId: 'camera1',
    label: 'Right A',
    zoom: 1.85,
    panX: 22,
    panY: 0,
    enabled: true,
    locked: true,
  },
  {
    id: '1B',
    cameraId: 'camera2',
    label: 'Full B',
    zoom: 1,
    panX: 0,
    panY: 0,
    enabled: true,
    locked: true,
  },
  {
    id: '2B',
    cameraId: 'camera2',
    label: 'Left B',
    zoom: 1.85,
    panX: -22,
    panY: 0,
    enabled: true,
    locked: true,
  },
  {
    id: '3B',
    cameraId: 'camera2',
    label: 'Right B',
    zoom: 1.85,
    panX: 22,
    panY: 0,
    enabled: true,
    locked: true,
  },
]);

export const buildManualMulticamTimeline = ({
  durationSeconds,
  initialShotId = '1A',
}) => {
  const totalDuration = Number(durationSeconds || 0);
  const safeDuration = Number(Math.max(1, totalDuration || 60).toFixed(3));
  const shotId = String(initialShotId || '1A').trim().toUpperCase() || '1A';
  return [{
    id: 'segment-1',
    cameraId: getMulticamCameraIdForShotId(shotId),
    shotId,
    startSeconds: 0,
    endSeconds: safeDuration,
    confidence: 1,
    isManual: true,
    manualShotId: shotId,
  }];
};
