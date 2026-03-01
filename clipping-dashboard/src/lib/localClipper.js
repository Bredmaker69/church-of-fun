import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const FFMPEG_CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd';
let ffmpegPromise = null;

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

const getFFmpeg = async () => {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
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
