import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { renderLocalClipFiles } from '../lib/localClipper';

const PRECISION_ALIGNMENT_ENABLED = String(import.meta.env.VITE_ENABLE_PRECISION_ALIGNMENT || '').toLowerCase() === 'true';
const MIN_ALIGNMENT_CONFIDENCE_FOR_AUTO_APPLY = 0.55;
const ALIGNMENT_PROVIDER_OPTIONS = [
  { id: 'openai_fast', label: 'Fast', description: 'OpenAI timed word sync' },
  { id: 'stable_ts_local', label: 'High Accuracy', description: 'Local stable-ts aligner (beta)' },
  { id: 'ab_compare', label: 'A/B Test', description: 'Run comparison mode and report metrics' },
];

const pad2 = (value) => String(Math.max(0, Math.floor(value))).padStart(2, '0');

const formatTimestamp = (totalSeconds) => {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(remaining)}`;
  return `${pad2(minutes)}:${pad2(remaining)}`;
};

const formatTimestampPrecise = (totalSeconds, fractionDigits = 2) => {
  const safeDigits = Math.max(0, Math.min(3, Math.floor(Number(fractionDigits) || 0)));
  if (safeDigits === 0) return formatTimestamp(totalSeconds);

  const scale = 10 ** safeDigits;
  let scaled = Math.round(Math.max(0, Number(totalSeconds) || 0) * scale);

  const hours = Math.floor(scaled / (3600 * scale));
  scaled -= hours * 3600 * scale;
  const minutes = Math.floor(scaled / (60 * scale));
  scaled -= minutes * 60 * scale;
  const wholeSeconds = Math.floor(scaled / scale);
  const fraction = scaled % scale;
  const secondText = `${String(wholeSeconds).padStart(2, '0')}.${String(fraction).padStart(safeDigits, '0')}`;

  if (hours > 0) {
    return `${pad2(hours)}:${pad2(minutes)}:${secondText}`;
  }
  return `${pad2(minutes)}:${secondText}`;
};

const parseTimestamp = (value) => {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
};

const isFiniteNumber = (value) => Number.isFinite(value);
const approximatelyEqual = (left, right, tolerance = 0.005) => Math.abs(Number(left) - Number(right)) <= tolerance;

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const withTimeout = async (promise, timeoutMs, errorMessage) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const looksLikeYouTubeUrl = (value) => {
  const url = String(value || '').toLowerCase();
  return url.includes('youtube.com') || url.includes('youtu.be');
};

const extractYouTubeVideoId = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'youtu.be') {
      const directId = url.pathname.split('/').filter(Boolean)[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(directId || '')) return directId;
    }

    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const watchId = url.searchParams.get('v');
      if (/^[A-Za-z0-9_-]{11}$/.test(watchId || '')) return watchId;

      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0].toLowerCase())) {
        if (/^[A-Za-z0-9_-]{11}$/.test(parts[1] || '')) return parts[1];
      }
    }
  } catch {
    // no-op, fallback regex below
  }

  const fallback = text.match(
    /(?:youtube\.com\/(?:shorts|embed|live|v|e)\/|youtube\.com\/.*[?&]v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i
  );
  return fallback ? fallback[1] : '';
};

let youtubeApiPromise;
const ensureYouTubeIframeApi = () => {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise((resolve) => {
    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existingScript) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      document.body.appendChild(script);
    }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };

    if (window.YT?.Player) {
      resolve(window.YT);
    }
  });

  return youtubeApiPromise;
};

const buildTimedUrl = (sourceUrl, seconds) => {
  try {
    const url = new URL(sourceUrl);
    const value = `${Math.max(0, Math.floor(seconds))}s`;
    url.searchParams.set('t', value);
    return url.toString();
  } catch {
    return sourceUrl;
  }
};

const escapeRegExp = (value) => {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'for', 'on', 'in', 'at', 'by', 'with',
  'from', 'up', 'down', 'into', 'out', 'about', 'as', 'is', 'it', 'this', 'that', 'these', 'those',
  'be', 'been', 'being', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'not',
  'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'them', 'i', 'im', 'its',
]);

const cleanTitleText = (value) => {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\[\s*_{2,}\s*\]/g, ' ')
    .replace(/[[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const tokenizeCaptionWords = (value) => (
  cleanTitleText(value)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
);

const toTitleCase = (value) => {
  return String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const shortHash = (value) => {
  let hash = 0;
  const source = String(value || '');
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, '0').slice(-4);
};

const buildSemanticTitleFromText = ({ text, startTimestamp, endTimestamp }) => {
  const cleaned = cleanTitleText(text);
  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const weighted = words.filter((word) => word.length > 2 && !TITLE_STOP_WORDS.has(word));
  const selectedWords = (weighted.length >= 3 ? weighted : words).slice(0, 6);
  const base = toTitleCase(selectedWords.join(' ')) || 'Untitled Moment';
  const hash = shortHash(`${cleaned}|${startTimestamp}|${endTimestamp}`);
  return `${base} (${startTimestamp}-${endTimestamp}) ${hash}`;
};

const buildFocusedTrimWindow = ({ clipStartSeconds, clipEndSeconds, mediaDurationSeconds }) => {
  const start = Number(clipStartSeconds);
  const end = Number(clipEndSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const clipLength = Math.max(1, end - start);
  const edgeRatio = 0.2;
  const centerRatio = 1 - edgeRatio * 2; // 60% of viewport is active clip
  const targetViewportLength = clipLength / centerRatio;
  const durationCap = Number.isFinite(mediaDurationSeconds) && mediaDurationSeconds > 0
    ? mediaDurationSeconds
    : end + clipLength;
  const viewportLength = Math.min(
    durationCap,
    Math.max(clipLength + 1, targetViewportLength)
  );

  let viewportStart = start - viewportLength * edgeRatio;
  let viewportEnd = viewportStart + viewportLength;

  if (viewportStart < 0) {
    viewportEnd -= viewportStart;
    viewportStart = 0;
  }
  if (viewportEnd > durationCap) {
    const overshoot = viewportEnd - durationCap;
    viewportStart = Math.max(0, viewportStart - overshoot);
    viewportEnd = durationCap;
  }

  if (viewportEnd - viewportStart < clipLength + 1) {
    viewportEnd = Math.min(durationCap, viewportStart + clipLength + 1);
  }

  return {
    start: viewportStart,
    end: viewportEnd,
  };
};

const getCallableErrorMessage = (error) => {
  const detailText = (
    error?.details && typeof error.details === 'string'
      ? error.details.trim()
      : ''
  );
  const messageText = String(error?.message || '').trim();
  if (detailText && messageText && !messageText.includes(detailText)) {
    return `${messageText} ${detailText}`.trim();
  }
  return detailText || messageText || 'Unknown error';
};

const formatAlignmentMetrics = (payload) => {
  const confidence = Number(payload?.matchConfidence);
  const coverage = Number(payload?.matchCoverage);
  const similarity = Number(payload?.matchAverageSimilarity);
  const strategy = String(payload?.matchStrategy || '').trim();
  const providerUsed = String(payload?.alignmentProviderUsed || '').trim();
  const parts = [];

  if (Number.isFinite(confidence)) parts.push(`${Math.round(confidence * 100)}% confidence`);
  if (Number.isFinite(coverage)) parts.push(`${Math.round(coverage * 100)}% coverage`);
  if (Number.isFinite(similarity)) parts.push(`${Math.round(similarity * 100)}% similarity`);
  if (strategy) parts.push(strategy.replace(/-/g, ' '));
  if (providerUsed) {
    const providerLabel = providerUsed === 'stable_ts_local'
      ? 'stable-ts local'
      : providerUsed === 'ab_compare'
        ? 'a/b compare'
        : 'openai fast';
    parts.push(`provider ${providerLabel}`);
  }

  return parts.length > 0 ? ` (${parts.join(' • ')})` : '';
};

const formatAlignmentComparisonSummary = (payload) => {
  const mode = String(payload?.alignmentComparison?.mode || '').trim();
  if (mode !== 'ab_compare') return '';

  const baseline = payload?.alignmentComparison?.baseline || null;
  const candidate = payload?.alignmentComparison?.candidate || null;
  const baseConfidence = Number(baseline?.confidence);
  const baseCoverage = Number(baseline?.coverage);
  const baseLabel = Number.isFinite(baseConfidence) && Number.isFinite(baseCoverage)
    ? `OpenAI Fast ${Math.round(baseConfidence * 100)}%/${Math.round(baseCoverage * 100)}%`
    : 'OpenAI Fast baseline';

  if (!candidate || candidate.available === false) {
    return ` A/B: ${baseLabel}. High Accuracy local unavailable on this runtime.`;
  }

  const candConfidence = Number(candidate?.confidence);
  const candCoverage = Number(candidate?.coverage);
  const candLabel = Number.isFinite(candConfidence) && Number.isFinite(candCoverage)
    ? `High Accuracy ${Math.round(candConfidence * 100)}%/${Math.round(candCoverage * 100)}%`
    : 'High Accuracy candidate';
  return ` A/B: ${baseLabel} vs ${candLabel}.`;
};

const ManualClipLab = ({
  activeSource,
  contentProfile = 'generic',
  onClipsRendered,
  onProjectNameSuggestion,
}) => {
  const videoRef = useRef(null);
  const youtubePlayerMountRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubeTimePollRef = useRef(null);
  const previewOverlayRef = useRef(null);
  const trimTimelineRef = useRef(null);
  const transcriptAvailabilityRequestRef = useRef(0);
  const autoCaptionLoadKeyRef = useRef('');
  const transcriptPaneRef = useRef(null);
  const transcriptRowRefs = useRef({});
  const transcriptAutoScrollRef = useRef(false);
  const trimDragSessionRef = useRef(null);
  const scrubToolPointerIdRef = useRef(null);
  const scrubToolSessionRef = useRef(null);
  const scrubAudioPauseTimeoutRef = useRef(null);
  const edgeSeekThrottleRef = useRef(0);
  const edgePreviewStateRef = useRef({ active: false, wasPlaying: false, mode: null });
  const dragStateRafRef = useRef(null);
  const pendingDragRangeRef = useRef(null);
  const stableActiveTranscriptIndexRef = useRef(-1);
  const precisionAlignRequestRef = useRef(0);
  const clipCounterRef = useRef(0);
  const youtubeVideoTitleRef = useRef('');

  const [localVideoUrl, setLocalVideoUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDurationSeconds, setMediaDurationSeconds] = useState(null);
  const [startTime, setStartTime] = useState('00:00');
  const [endTime, setEndTime] = useState('00:15');
  const [stagedClipDraft, setStagedClipDraft] = useState(null);
  const [trimViewportRange, setTrimViewportRange] = useState(null);
  const [manualViewportStartSeconds, setManualViewportStartSeconds] = useState(null);
  const [activeTrimDragMode, setActiveTrimDragMode] = useState(null);
  const [isAuditioningClip, setIsAuditioningClip] = useState(false);
  const [isLoopPlayback, setIsLoopPlayback] = useState(false);
  const [trimZoomLevel, setTrimZoomLevel] = useState(1);
  const [isScrubToolActive, setIsScrubToolActive] = useState(false);
  const [nextScrubCutTarget, setNextScrubCutTarget] = useState('start');
  const [transcriptSegments, setTranscriptSegments] = useState([]);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [transcriptAvailability, setTranscriptAvailability] = useState(null);
  const [isCheckingTranscriptAvailability, setIsCheckingTranscriptAvailability] = useState(false);
  const [autoFollowTranscript, setAutoFollowTranscript] = useState(true);
  const [selectedTranscriptSelection, setSelectedTranscriptSelection] = useState(null);
  const [youtubePlayerError, setYoutubePlayerError] = useState('');
  const [youtubeVideoTitle, setYoutubeVideoTitle] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isPrecisionAligning, setIsPrecisionAligning] = useState(false);
  const [alignmentProvider, setAlignmentProvider] = useState('openai_fast');
  const [transcriptLoadMode, setTranscriptLoadMode] = useState('idle');
  const [status, setStatus] = useState('Use the Clip Studio ingest panel to load a source video.');
  const [localWaveformData, setLocalWaveformData] = useState(null);
  const [alignmentWaveformData, setAlignmentWaveformData] = useState(null);
  const [showCaptionPreview, setShowCaptionPreview] = useState(true);
  const [captionPreviewWordsPerChunk, setCaptionPreviewWordsPerChunk] = useState(5);
  const [alignedPreviewWordCues, setAlignedPreviewWordCues] = useState([]);
  const [precisionPreviewClip, setPrecisionPreviewClip] = useState(null);
  const [isGeneratingPrecisionPreview, setIsGeneratingPrecisionPreview] = useState(false);

  const generateTranscript = useMemo(
    () => httpsCallable(functions, 'generateTranscript'),
    []
  );
  const checkTranscriptAvailability = useMemo(
    () => httpsCallable(functions, 'checkTranscriptAvailability'),
    []
  );
  const renderYouTubeClips = useMemo(
    () => httpsCallable(functions, 'renderYouTubeClips'),
    []
  );
  const alignTranscriptSelection = useMemo(
    () => httpsCallable(functions, 'alignTranscriptSelection'),
    []
  );

  const sourceMode = activeSource?.kind === 'file'
    ? 'file'
    : activeSource?.kind === 'url'
      ? 'url'
      : 'none';

  const sourceFile = sourceMode === 'file' ? activeSource?.payload : null;
  const sourceUrl = sourceMode === 'url' ? activeSource?.payload || '' : '';

  const isYouTubeSource = sourceMode === 'url' && looksLikeYouTubeUrl(sourceUrl);
  const youtubeVideoId = isYouTubeSource ? extractYouTubeVideoId(sourceUrl) : '';
  const sourceReference = sourceMode === 'file' && sourceFile
    ? `local-file://${encodeURIComponent(sourceFile.name)}`
    : sourceMode === 'url' && sourceUrl
      ? sourceUrl
      : '';
  const sourceTitle = sourceMode === 'file'
    ? sourceFile?.name || ''
    : (youtubeVideoTitle || sourceUrl);
  const isPrecisionPreviewActive = (
    sourceMode === 'url'
    && isYouTubeSource
    && Boolean(precisionPreviewClip?.downloadUrl)
  );
  const previewVideoUrl = sourceMode === 'file'
    ? localVideoUrl
    : (isPrecisionPreviewActive ? String(precisionPreviewClip?.downloadUrl || '') : '');

  useEffect(() => {
    return () => {
      if (youtubeTimePollRef.current) {
        clearInterval(youtubeTimePollRef.current);
        youtubeTimePollRef.current = null;
      }
      if (youtubePlayerRef.current) {
        youtubePlayerRef.current.destroy();
        youtubePlayerRef.current = null;
      }
      if (scrubAudioPauseTimeoutRef.current) {
        clearTimeout(scrubAudioPauseTimeoutRef.current);
        scrubAudioPauseTimeoutRef.current = null;
      }
      if (dragStateRafRef.current) {
        cancelAnimationFrame(dragStateRafRef.current);
        dragStateRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    youtubeVideoTitleRef.current = youtubeVideoTitle;
  }, [youtubeVideoTitle]);

  useEffect(() => {
    if (!sourceFile) {
      setLocalVideoUrl('');
      return undefined;
    }

    const nextUrl = URL.createObjectURL(sourceFile);
    setLocalVideoUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [sourceFile]);

  useEffect(() => {
    let cancelled = false;

    if (sourceMode !== 'file' || !sourceFile) {
      setLocalWaveformData(null);
      return () => {
        cancelled = true;
      };
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      setLocalWaveformData(null);
      return () => {
        cancelled = true;
      };
    }

    const audioContext = new AudioContextCtor();
    void (async () => {
      try {
        const sourceBuffer = await sourceFile.arrayBuffer();
        if (cancelled) return;
        const decodedBuffer = await audioContext.decodeAudioData(sourceBuffer.slice(0));
        if (cancelled) return;

        const sampleCount = Number(decodedBuffer.length || 0);
        const sampleRate = Number(decodedBuffer.sampleRate || 0);
        const durationSeconds = Number(decodedBuffer.duration || 0);
        if (!sampleCount || !sampleRate || !durationSeconds) {
          setLocalWaveformData(null);
          return;
        }

        const channelCount = Math.max(1, Number(decodedBuffer.numberOfChannels || 1));
        const channelData = Array.from({ length: channelCount }, (_, index) => decodedBuffer.getChannelData(index));
        const targetBins = 1400;
        const binCount = Math.max(200, Math.min(targetBins, sampleCount));
        const samplesPerBin = sampleCount / binCount;
        const bins = [];

        for (let index = 0; index < binCount; index += 1) {
          const startIndex = Math.floor(index * samplesPerBin);
          const endIndex = Math.max(startIndex + 1, Math.floor((index + 1) * samplesPerBin));
          let peak = 0;
          for (let cursor = startIndex; cursor < endIndex && cursor < sampleCount; cursor += 1) {
            for (let channel = 0; channel < channelData.length; channel += 1) {
              const value = Math.abs(channelData[channel][cursor] || 0);
              if (value > peak) peak = value;
            }
          }
          bins.push(Number(peak.toFixed(4)));
        }

        setLocalWaveformData({
          source: 'web-audio-local',
          sampleRate,
          durationSeconds: Number(durationSeconds.toFixed(3)),
          windowStartSeconds: 0,
          windowEndSeconds: Number(durationSeconds.toFixed(3)),
          binDurationSeconds: Number((durationSeconds / Math.max(1, bins.length)).toFixed(6)),
          bins,
        });
      } catch (error) {
        if (!cancelled) {
          console.warn('Unable to generate local waveform:', error);
          setLocalWaveformData(null);
        }
      } finally {
        audioContext.close().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      audioContext.close().catch(() => {});
    };
  }, [sourceFile, sourceMode]);

  const clearProcessingState = useCallback(() => {
    transcriptAvailabilityRequestRef.current += 1;
    precisionAlignRequestRef.current += 1;
    autoCaptionLoadKeyRef.current = '';
    setTranscriptSegments([]);
    setTranscriptQuery('');
    setTranscriptAvailability(null);
    setAutoFollowTranscript(true);
    setSelectedTranscriptSelection(null);
    setStagedClipDraft(null);
    setTrimViewportRange(null);
    setManualViewportStartSeconds(null);
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
    setTrimZoomLevel(1);
    setYoutubePlayerError('');
    setYoutubeVideoTitle('');
    setMediaDurationSeconds(null);
    setIsPrecisionAligning(false);
    setIsCheckingTranscriptAvailability(false);
    setTranscriptLoadMode('idle');
    setAlignmentWaveformData(null);
    setAlignedPreviewWordCues([]);
    setPrecisionPreviewClip(null);
    setIsGeneratingPrecisionPreview(false);
    transcriptRowRefs.current = {};
    edgePreviewStateRef.current = { active: false, wasPlaying: false, mode: null };
  }, []);

  const checkUrlTranscriptAvailability = useCallback(async (url) => {
    const requestId = transcriptAvailabilityRequestRef.current + 1;
    transcriptAvailabilityRequestRef.current = requestId;

    if (!looksLikeYouTubeUrl(url)) {
      setTranscriptAvailability({
        status: 'ready',
        isYouTube: false,
        hasCaptions: false,
        segmentCount: 0,
        message: 'Non-YouTube URL detected. Transcript generation will use OpenAI.',
      });
      setIsCheckingTranscriptAvailability(false);
      return;
    }

    setIsCheckingTranscriptAvailability(true);
    setTranscriptAvailability({
      status: 'checking',
      isYouTube: true,
      hasCaptions: false,
      segmentCount: 0,
      message: 'Checking YouTube captions...',
    });

    try {
      const result = await withTimeout(
        checkTranscriptAvailability({ videoUrl: url }),
        90000,
        'Timed out checking YouTube captions.'
      );

      if (transcriptAvailabilityRequestRef.current !== requestId) return;

      const data = result.data || {};
      setTranscriptAvailability({
        status: 'ready',
        isYouTube: Boolean(data.isYouTube),
        hasCaptions: Boolean(data.hasCaptions),
        segmentCount: Number(data.segmentCount) || 0,
        providerUsed: String(data.providerUsed || ''),
        languageUsed: String(data.languageUsed || ''),
        cacheHit: Boolean(data.cacheHit),
        message: String(data.message || 'Transcript availability checked.'),
      });
    } catch (error) {
      if (transcriptAvailabilityRequestRef.current !== requestId) return;
      setTranscriptAvailability({
        status: 'error',
        isYouTube: true,
        hasCaptions: false,
        segmentCount: 0,
        message: error.message || 'Unable to check YouTube captions.',
      });
    } finally {
      if (transcriptAvailabilityRequestRef.current === requestId) {
        setIsCheckingTranscriptAvailability(false);
      }
    }
  }, [checkTranscriptAvailability]);

  useEffect(() => {
    clearProcessingState();
    setCurrentTime(0);
    setStartTime('00:00');
    setEndTime('00:15');

    if (sourceMode === 'none') {
      setStatus('Use the Clip Studio ingest panel to load a source video.');
      return;
    }

    if (sourceMode === 'file') {
      setStatus(`Local source ready: ${sourceFile?.name || 'video file'}`);
      return;
    }

    if (sourceMode === 'url') {
      if (isYouTubeSource) {
        setStatus('YouTube URL ready. Checking caption availability...');
        checkUrlTranscriptAvailability(sourceUrl);
      } else {
        setStatus('URL source ready: non-YouTube link.');
        setTranscriptAvailability({
          status: 'ready',
          isYouTube: false,
          hasCaptions: false,
          segmentCount: 0,
          message: 'Non-YouTube URL detected. Transcript generation will use OpenAI.',
        });
      }
    }
  }, [sourceMode, sourceFile, sourceUrl, isYouTubeSource, clearProcessingState, checkUrlTranscriptAvailability]);

  const renderClipFromRange = useCallback(async ({
    startTimestamp,
    endTimestamp,
    title,
    description,
    selectedText = '',
  }) => {
    const startSeconds = parseTimestamp(startTimestamp);
    const endSeconds = parseTimestamp(endTimestamp);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      setStatus('Invalid segment range. Use MM:SS and ensure end is after start.');
      return false;
    }

    if (sourceMode === 'url' && !isYouTubeSource) {
      setStatus('URL rendering currently supports YouTube links only.');
      return false;
    }
    if (sourceMode === 'file' && !sourceFile) {
      setStatus('Select a local source video first.');
      return false;
    }
    if (!sourceReference) {
      setStatus('Load a source before rendering clips.');
      return false;
    }
    if (isRendering) {
      setStatus('Render already in progress...');
      return false;
    }

    clipCounterRef.current += 1;
    const normalizedSelectedText = cleanTitleText(selectedText || '');

    const collectTranscriptRowsForRange = (rangeStart, rangeEnd) => {
      return transcriptSegments
        .map((segment) => {
          const segmentStart = parseTimestamp(segment.startTimestamp);
          const segmentEnd = parseTimestamp(segment.endTimestamp);
          const normalizedStart = isFiniteNumber(segmentStart) ? segmentStart : null;
          const normalizedEnd = isFiniteNumber(segmentEnd) && segmentEnd > segmentStart
            ? segmentEnd
            : (isFiniteNumber(segmentStart) ? segmentStart + 2 : null);
          return {
            text: cleanTitleText(segment.text || ''),
            startSeconds: normalizedStart,
            endSeconds: normalizedEnd,
          };
        })
        .filter((segment) => (
          isFiniteNumber(segment.startSeconds)
          && isFiniteNumber(segment.endSeconds)
          && segment.endSeconds > rangeStart
          && segment.startSeconds < rangeEnd
        ))
        .sort((left, right) => left.startSeconds - right.startSeconds);
    };

    const initialRows = collectTranscriptRowsForRange(startSeconds, endSeconds);
    const initialTranscriptSourceText = initialRows
      .map((row) => row.text)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    let finalStartSeconds = startSeconds;
    let finalEndSeconds = endSeconds;
    let wordLevelCaptionCues = [];
    let usedWordSync = false;

    const alignmentSeedText = (normalizedSelectedText || initialTranscriptSourceText || cleanTitleText(description || ''))
      .slice(0, 900);
    if (sourceMode === 'url' && isYouTubeSource && sourceUrl && alignmentSeedText) {
      setStatus('Syncing word-level caption timing...');
      setIsPrecisionAligning(true);
      try {
        const alignmentResult = await withTimeout(
          alignTranscriptSelection({
            videoUrl: sourceUrl,
            startTimestamp: formatTimestampPrecise(startSeconds, 2),
            endTimestamp: formatTimestampPrecise(endSeconds, 2),
            selectedText: alignmentSeedText,
            transcriptLanguage: String(transcriptAvailability?.languageUsed || '').trim() || undefined,
            alignmentProvider,
          }),
          240000,
          'Timed out syncing word-level captions.'
        );

        const payload = alignmentResult?.data || {};
        const alignmentLabel = formatAlignmentMetrics(payload);
        const providerFallbackMessage = String(payload?.alignmentProviderFallbackMessage || '').trim();
        const comparisonSummary = formatAlignmentComparisonSummary(payload);
        const alignmentConfidence = Number(payload.matchConfidence);
        const isStableLocalMode = alignmentProvider === 'stable_ts_local';
        const applyAlignedBounds = (
          isStableLocalMode ||
          !Number.isFinite(alignmentConfidence) ||
          alignmentConfidence >= MIN_ALIGNMENT_CONFIDENCE_FOR_AUTO_APPLY
        );
        const waveformPayload = payload?.waveform || null;
        const waveformBins = Array.isArray(waveformPayload?.bins)
          ? waveformPayload.bins
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value >= 0)
          : [];
        if (waveformBins.length > 0) {
          const waveformWindowStart = Number.isFinite(Number(waveformPayload.windowStartSeconds))
            ? Number(waveformPayload.windowStartSeconds)
            : startSeconds;
          const waveformWindowEnd = Number.isFinite(Number(waveformPayload.windowEndSeconds))
            ? Number(waveformPayload.windowEndSeconds)
            : endSeconds;
          const inferredBinDuration = Number.isFinite(Number(waveformPayload.binDurationSeconds))
            ? Number(waveformPayload.binDurationSeconds)
            : ((waveformWindowEnd - waveformWindowStart) / waveformBins.length);
          setAlignmentWaveformData({
            source: String(waveformPayload.source || 'youtube-alignment'),
            sampleRate: Number(waveformPayload.sampleRate) || null,
            durationSeconds: Number(waveformPayload.durationSeconds) || null,
            windowStartSeconds: Number(waveformWindowStart.toFixed(3)),
            windowEndSeconds: Number(waveformWindowEnd.toFixed(3)),
            binDurationSeconds: Number((Number.isFinite(inferredBinDuration) ? inferredBinDuration : 0).toFixed(6)),
            bins: waveformBins,
          });
        } else {
          setAlignmentWaveformData(null);
        }
        const alignedStart = Number.isFinite(Number(payload.alignedStartSeconds))
          ? Number(payload.alignedStartSeconds)
          : parseTimestamp(payload.alignedStartTimestamp);
        const alignedEnd = Number.isFinite(Number(payload.alignedEndSeconds))
          ? Number(payload.alignedEndSeconds)
          : parseTimestamp(payload.alignedEndTimestamp);
        if (applyAlignedBounds && isFiniteNumber(alignedStart) && isFiniteNumber(alignedEnd) && alignedEnd > alignedStart) {
          finalStartSeconds = alignedStart;
          finalEndSeconds = alignedEnd;
        }

        const clipDurationForWords = Math.max(0.1, finalEndSeconds - finalStartSeconds);
        const rawWordCues = Array.isArray(payload.alignedWordCues) ? payload.alignedWordCues : [];
        wordLevelCaptionCues = rawWordCues
          .map((cue, index) => {
            const text = cleanTitleText(cue?.text || '');
            if (!text) return null;

            const sourceStart = Number(cue?.sourceStartSeconds);
            const sourceEnd = Number(cue?.sourceEndSeconds);
            const rawStart = Number.isFinite(Number(cue?.startSeconds))
              ? Number(cue.startSeconds)
              : (Number.isFinite(sourceStart) ? sourceStart - finalStartSeconds : null);
            const rawEnd = Number.isFinite(Number(cue?.endSeconds))
              ? Number(cue.endSeconds)
              : (Number.isFinite(sourceEnd) ? sourceEnd - finalStartSeconds : null);
            if (!isFiniteNumber(rawStart) || !isFiniteNumber(rawEnd)) return null;

            const cueStart = Math.max(0, Math.min(rawStart, clipDurationForWords - 0.02));
            const cueEnd = Math.min(clipDurationForWords, Math.max(rawEnd, cueStart + 0.02));
            if (!isFiniteNumber(cueStart) || !isFiniteNumber(cueEnd) || cueEnd <= cueStart) return null;

            const normalizedSourceStart = Number.isFinite(sourceStart)
              ? sourceStart
              : finalStartSeconds + cueStart;
            const normalizedSourceEnd = Number.isFinite(sourceEnd)
              ? sourceEnd
              : finalStartSeconds + cueEnd;

            return {
              id: String(cue?.id || `word-${index + 1}`),
              text,
              startSeconds: Number(cueStart.toFixed(3)),
              endSeconds: Number(cueEnd.toFixed(3)),
              sourceStartSeconds: Number(normalizedSourceStart.toFixed(3)),
              sourceEndSeconds: Number(normalizedSourceEnd.toFixed(3)),
            };
          })
          .filter(Boolean)
          .sort((left, right) => left.startSeconds - right.startSeconds);

        if (wordLevelCaptionCues.length > 0 && applyAlignedBounds) {
          usedWordSync = true;
          setStatus(`Word-level sync ready${alignmentLabel} (${wordLevelCaptionCues.length} words). Rendering...${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`);
        } else if (!applyAlignedBounds && Number.isFinite(alignmentConfidence)) {
          setStatus(`Word-level sync confidence is low${alignmentLabel}. Keeping manual range and transcript timing.${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`);
        } else {
          setStatus(`Word-level sync returned no usable word cues${alignmentLabel}. Rendering with transcript timing.${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`);
        }
      } catch (error) {
        setStatus(`Word-level sync unavailable: ${getCallableErrorMessage(error)}. Rendering with transcript timing.`);
      } finally {
        setIsPrecisionAligning(false);
      }
    }

    const semanticTitle = buildSemanticTitleFromText({
      text: description || title || 'untitled moment',
      startTimestamp: formatTimestampPrecise(finalStartSeconds),
      endTimestamp: formatTimestampPrecise(finalEndSeconds),
    });
    const clipDurationSeconds = Math.max(0.1, finalEndSeconds - finalStartSeconds);
    const overlappingRows = collectTranscriptRowsForRange(finalStartSeconds, finalEndSeconds);
    const captionCues = [...wordLevelCaptionCues];

    if (captionCues.length === 0) {
      overlappingRows.forEach((row, index) => {
        if (!row.text) return;
        const sourceStart = Math.max(finalStartSeconds, row.startSeconds);
        const sourceEnd = Math.min(finalEndSeconds, row.endSeconds);
        if (!isFiniteNumber(sourceStart) || !isFiniteNumber(sourceEnd) || sourceEnd <= sourceStart) return;

        const cueStart = Math.max(0, sourceStart - finalStartSeconds);
        const cueEnd = Math.min(clipDurationSeconds, sourceEnd - finalStartSeconds);
        if (!isFiniteNumber(cueStart) || !isFiniteNumber(cueEnd) || cueEnd <= cueStart) return;

        captionCues.push({
          id: `cue-${index + 1}-${Math.round(sourceStart * 100)}`,
          text: row.text,
          startSeconds: Number(cueStart.toFixed(2)),
          endSeconds: Number(cueEnd.toFixed(2)),
          sourceStartSeconds: Number(sourceStart.toFixed(2)),
          sourceEndSeconds: Number(sourceEnd.toFixed(2)),
        });
      });
    }

    const transcriptSourceText = overlappingRows
      .map((row) => row.text)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (captionCues.length === 0 && normalizedSelectedText) {
      captionCues.push({
        id: 'cue-fallback-selection',
        text: normalizedSelectedText,
        startSeconds: 0,
        endSeconds: Number(clipDurationSeconds.toFixed(2)),
        sourceStartSeconds: Number(finalStartSeconds.toFixed(2)),
        sourceEndSeconds: Number(finalEndSeconds.toFixed(2)),
      });
    }

    const transcriptProvider = String(
      usedWordSync
        ? 'openai_audio_transcription_word_align'
        : (
          transcriptAvailability?.providerUsed
          || (transcriptLoadMode === 'ai'
            ? 'openai_audio_transcription'
            : (isYouTubeSource ? 'youtube_caption' : 'local'))
        )
    ).trim() || 'unknown';
    const transcriptLanguage = String(transcriptAvailability?.languageUsed || '').trim() || 'unknown';
    const transcriptSnippet = (normalizedSelectedText || transcriptSourceText || cleanTitleText(description || ''))
      .slice(0, 260);

    const segment = {
      id: `manual-${Date.now()}-${clipCounterRef.current}`,
      title: semanticTitle,
      description: description || 'Manual selection',
      viralScore: 80,
      startTimestamp: formatTimestampPrecise(finalStartSeconds),
      endTimestamp: formatTimestampPrecise(finalEndSeconds),
      transcriptSourceText,
      transcriptSnippet,
      transcriptSelectedText: normalizedSelectedText,
      transcriptProvider,
      transcriptLanguage,
      selectionStartSeconds: Number(finalStartSeconds.toFixed(2)),
      selectionEndSeconds: Number(finalEndSeconds.toFixed(2)),
      captionCues,
      captionStylePreset: usedWordSync ? 'pop-punch' : 'reel-bold',
      captionConfirmationStatus: 'pending',
      captionConfirmedText: '',
      captionConfirmedAt: '',
    };

    setIsRendering(true);
    setStatus(sourceMode === 'url' ? 'Rendering clip from YouTube...' : 'Rendering clip locally...');

    try {
      if (sourceMode === 'url') {
        const result = await withTimeout(
          renderYouTubeClips({
            videoUrl: sourceUrl,
            clips: [segment],
          }),
          420000,
          'Timed out rendering YouTube clip.'
        );

        const clips = Array.isArray(result.data?.clips) ? result.data.clips : [];
        const failures = Array.isArray(result.data?.failures) ? result.data.failures : [];
        if (clips.length === 0) {
          const failureDetail = failures[0]?.error ? ` ${failures[0].error}` : '';
          throw new Error(`No clips were rendered.${failureDetail}`);
        }

        const enrichedClips = clips.map((renderedClip) => ({
          ...renderedClip,
          transcriptSourceText: segment.transcriptSourceText,
          transcriptSnippet: segment.transcriptSnippet,
          transcriptSelectedText: segment.transcriptSelectedText,
          transcriptProvider: segment.transcriptProvider,
          transcriptLanguage: segment.transcriptLanguage,
          selectionStartSeconds: segment.selectionStartSeconds,
          selectionEndSeconds: segment.selectionEndSeconds,
          captionCues: segment.captionCues,
          captionStylePreset: segment.captionStylePreset,
          captionConfirmationStatus: segment.captionConfirmationStatus,
          captionConfirmedText: segment.captionConfirmedText,
          captionConfirmedAt: segment.captionConfirmedAt,
          description: segment.description,
        }));

        onClipsRendered?.(enrichedClips, {
          sourceRef: sourceReference,
          sourceTitle,
          sourceType: 'youtube-url',
          contentProfile,
          origin: 'render-youtube-auto',
          projectNameHint: sourceTitle,
        });
        setStatus(failures.length > 0
          ? `Rendered 1 clip. ${failures.length} additional clip failure(s) were reported.`
          : 'Rendered and sent to Clip Vault.');
        return true;
      }

      const clips = await renderLocalClipFiles({
        sourceFile,
        clips: [segment],
        onProgress: ({ current, total }) => setStatus(`Rendering ${current}/${total}...`),
      });
      if (clips.length === 0) {
        throw new Error('No clip was rendered.');
      }

      const enrichedClips = clips.map((renderedClip) => ({
        ...renderedClip,
        transcriptSourceText: segment.transcriptSourceText,
        transcriptSnippet: segment.transcriptSnippet,
        transcriptSelectedText: segment.transcriptSelectedText,
        transcriptProvider: segment.transcriptProvider,
        transcriptLanguage: segment.transcriptLanguage,
        selectionStartSeconds: segment.selectionStartSeconds,
        selectionEndSeconds: segment.selectionEndSeconds,
        captionCues: segment.captionCues,
        captionStylePreset: segment.captionStylePreset,
        captionConfirmationStatus: segment.captionConfirmationStatus,
        captionConfirmedText: segment.captionConfirmedText,
        captionConfirmedAt: segment.captionConfirmedAt,
        description: segment.description,
      }));

      onClipsRendered?.(enrichedClips, {
        sourceRef: sourceReference,
        sourceTitle,
        sourceType: 'local-file',
        contentProfile,
        origin: 'render-local-auto',
        projectNameHint: sourceTitle,
      });
      setStatus('Rendered and sent to Clip Vault.');
      return true;
    } catch (error) {
      setStatus(`Render failed: ${error.message || 'Unknown error'}`);
      return false;
    } finally {
      setIsRendering(false);
    }
  }, [
    alignmentProvider,
    alignTranscriptSelection,
    contentProfile,
    isRendering,
    isYouTubeSource,
    onClipsRendered,
    renderYouTubeClips,
    sourceFile,
    sourceMode,
    sourceReference,
    sourceTitle,
    sourceUrl,
    transcriptAvailability?.languageUsed,
    transcriptAvailability?.providerUsed,
    transcriptLoadMode,
    transcriptSegments,
  ]);

  const findTranscriptSnippetForRange = useCallback((startTimestamp, endTimestamp) => {
    const startSeconds = parseTimestamp(startTimestamp);
    const endSeconds = parseTimestamp(endTimestamp);
    if (!isFiniteNumber(startSeconds) || !isFiniteNumber(endSeconds) || endSeconds <= startSeconds) return '';

    const snippet = transcriptSegments
      .filter((segment) => {
        const segmentStart = parseTimestamp(segment.startTimestamp);
        const segmentEnd = parseTimestamp(segment.endTimestamp);
        if (!isFiniteNumber(segmentStart) || !isFiniteNumber(segmentEnd)) return false;
        return segmentStart < endSeconds && segmentEnd > startSeconds;
      })
      .map((segment) => segment.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!snippet) return '';
    return snippet.slice(0, 260);
  }, [transcriptSegments]);

  const addSegment = () => {
    const transcriptSnippet = findTranscriptSnippetForRange(startTime, endTime);
    const nextManualIndex = clipCounterRef.current + 1;
    const nextTitle = stagedClipDraft?.title || transcriptSnippet || `Manual Clip ${nextManualIndex}`;
    const nextDescription = stagedClipDraft?.description || transcriptSnippet || 'Manual selection';

    void (async () => {
      const success = await renderClipFromRange({
        startTimestamp: startTime,
        endTimestamp: endTime,
        title: nextTitle,
        description: nextDescription,
        selectedText: stagedClipDraft?.origin === 'transcript-selection' ? nextDescription : '',
      });
      if (success) {
        setStagedClipDraft(null);
      }
    })();
  };

  const seekToSeconds = useCallback((rawSeconds, { allowExternalOpen = true } = {}) => {
    if (!isFiniteNumber(rawSeconds)) return;
    const seconds = Math.max(0, rawSeconds);

    if ((sourceMode === 'file' || isPrecisionPreviewActive) && videoRef.current) {
      if (isPrecisionPreviewActive) {
        const previewStart = Number(precisionPreviewClip?.windowStartSeconds);
        const safePreviewStart = isFiniteNumber(previewStart) ? previewStart : 0;
        const previewEnd = Number(precisionPreviewClip?.windowEndSeconds);
        const fallbackRangeStart = parseTimestamp(startTime);
        const fallbackRangeEnd = parseTimestamp(endTime);
        const fallbackSpan = (
          isFiniteNumber(fallbackRangeStart)
          && isFiniteNumber(fallbackRangeEnd)
          && fallbackRangeEnd > fallbackRangeStart
        )
          ? fallbackRangeEnd - fallbackRangeStart
          : 1;
        const safePreviewEnd = isFiniteNumber(previewEnd) && previewEnd > safePreviewStart
          ? previewEnd
          : safePreviewStart + Math.max(1, fallbackSpan);
        const boundedAbsolute = clampNumber(seconds, safePreviewStart, safePreviewEnd);
        videoRef.current.currentTime = Math.max(0, boundedAbsolute - safePreviewStart);
        setCurrentTime(boundedAbsolute);
        return;
      }
      videoRef.current.currentTime = seconds;
      setCurrentTime(seconds);
      return;
    }

    if (sourceMode === 'url' && isYouTubeSource && youtubePlayerRef.current) {
      try {
        youtubePlayerRef.current.seekTo(seconds, true);
        setCurrentTime(seconds);
        return;
      } catch {
        // fallback to opening timed URL below when allowed
      }
    }

    if (allowExternalOpen && sourceMode === 'url' && sourceUrl) {
      window.open(buildTimedUrl(sourceUrl, seconds), '_blank', 'noopener,noreferrer');
    }
  }, [
    isPrecisionPreviewActive,
    isYouTubeSource,
    precisionPreviewClip,
    startTime,
    endTime,
    sourceMode,
    sourceUrl,
  ]);

  const jumpToTimestamp = useCallback((timestamp) => {
    const seconds = parseTimestamp(timestamp);
    if (!Number.isFinite(seconds)) return;
    seekToSeconds(seconds);
  }, [seekToSeconds]);

  const playPreview = useCallback(() => {
    if ((sourceMode === 'file' || isPrecisionPreviewActive) && videoRef.current) {
      videoRef.current.play().catch(() => {});
      return true;
    }
    if (sourceMode === 'url' && isYouTubeSource && youtubePlayerRef.current) {
      try {
        youtubePlayerRef.current.playVideo?.();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, [sourceMode, isYouTubeSource, isPrecisionPreviewActive]);

  const pausePreview = useCallback(() => {
    if ((sourceMode === 'file' || isPrecisionPreviewActive) && videoRef.current) {
      videoRef.current.pause();
      return;
    }
    if (sourceMode === 'url' && isYouTubeSource && youtubePlayerRef.current) {
      try {
        youtubePlayerRef.current.pauseVideo?.();
      } catch {
        // ignore pause errors
      }
    }
  }, [sourceMode, isYouTubeSource, isPrecisionPreviewActive]);

  const finishOverlayDrag = useCallback(() => {
    trimDragSessionRef.current = null;
    edgeSeekThrottleRef.current = 0;
    if (dragStateRafRef.current) {
      cancelAnimationFrame(dragStateRafRef.current);
      dragStateRafRef.current = null;
    }
    const pendingRange = pendingDragRangeRef.current;
    if (pendingRange) {
      setStartTime(String(pendingRange.startText || formatTimestampPrecise(pendingRange.start, 2)));
      setEndTime(String(pendingRange.endText || formatTimestampPrecise(pendingRange.end, 2)));
      pendingDragRangeRef.current = null;
    }
    setActiveTrimDragMode(null);
    const previewState = edgePreviewStateRef.current;
    if (previewState.active && !previewState.wasPlaying) {
      pausePreview();
      setIsAuditioningClip(false);
    }
    edgePreviewStateRef.current = { active: false, wasPlaying: false, mode: null };
  }, [pausePreview]);

  const stopScrubAudioPreview = useCallback(() => {
    if (scrubAudioPauseTimeoutRef.current) {
      clearTimeout(scrubAudioPauseTimeoutRef.current);
      scrubAudioPauseTimeoutRef.current = null;
    }
    pausePreview();
  }, [pausePreview]);

  const generatePrecisionPreviewClip = useCallback(async () => {
    if (sourceMode !== 'url' || !isYouTubeSource || !sourceUrl) {
      setStatus('Precision preview is available for YouTube sources only.');
      return;
    }
    const previewMinClipSeconds = 1;
    const rangeStart = parseTimestamp(startTime);
    const rangeEnd = parseTimestamp(endTime);
    if (!isFiniteNumber(rangeStart) || !isFiniteNumber(rangeEnd) || rangeEnd <= rangeStart) {
      setStatus('Set a valid In/Out range before creating precision preview.');
      return;
    }
    if (isPrecisionAligning || isRendering || isGeneratingPrecisionPreview) {
      setStatus('Please wait for the current operation to finish.');
      return;
    }

    let previewStartSeconds = Math.max(0, rangeStart);
    let previewEndSeconds = rangeEnd;
    if (previewEndSeconds <= previewStartSeconds) {
      previewEndSeconds = previewStartSeconds + previewMinClipSeconds;
    }

    setIsGeneratingPrecisionPreview(true);
    setStatus('Rendering precision preview clip...');
    try {
      const previewTitle = `Precision Preview ${formatTimestampPrecise(rangeStart, 2)}-${formatTimestampPrecise(rangeEnd, 2)}`;
      const result = await withTimeout(
        renderYouTubeClips({
          videoUrl: sourceUrl,
          clips: [{
            title: previewTitle,
            startTimestamp: formatTimestampPrecise(previewStartSeconds, 2),
            endTimestamp: formatTimestampPrecise(previewEndSeconds, 2),
            description: 'Precision preview window',
            viralScore: 80,
          }],
        }),
        420000,
        'Timed out rendering precision preview clip.'
      );

      const renderedClip = Array.isArray(result?.data?.clips) ? result.data.clips[0] : null;
      if (!renderedClip?.downloadUrl) {
        throw new Error('Precision preview render did not return a download URL.');
      }

      const renderedStart = parseTimestamp(renderedClip.startTimestamp);
      const renderedEnd = parseTimestamp(renderedClip.endTimestamp);
      const nextWindowStart = isFiniteNumber(renderedStart) ? renderedStart : previewStartSeconds;
      const nextWindowEnd = isFiniteNumber(renderedEnd) && renderedEnd > nextWindowStart
        ? renderedEnd
        : previewEndSeconds;

      pausePreview();
      setIsAuditioningClip(false);
      setIsLoopPlayback(false);
      setPrecisionPreviewClip({
        downloadUrl: String(renderedClip.downloadUrl || ''),
        fileName: String(renderedClip.fileName || ''),
        expiresAt: String(renderedClip.expiresAt || ''),
        warning: String(renderedClip.warning || ''),
        windowStartSeconds: Number(nextWindowStart.toFixed(3)),
        windowEndSeconds: Number(nextWindowEnd.toFixed(3)),
      });
      seekToSeconds(rangeStart, { allowExternalOpen: false });
      setStatus('Precision preview ready from exact trim range. You are now trimming against rendered video (no YouTube polling jitter).');
    } catch (error) {
      setStatus(`Precision preview failed: ${getCallableErrorMessage(error)}`);
    } finally {
      setIsGeneratingPrecisionPreview(false);
    }
  }, [
    isGeneratingPrecisionPreview,
    isPrecisionAligning,
    isRendering,
    isYouTubeSource,
    pausePreview,
    renderYouTubeClips,
    seekToSeconds,
    startTime,
    endTime,
    sourceMode,
    sourceUrl,
  ]);

  const requestTranscript = useCallback(async ({
    forceOpenAiTranscript = false,
    statusMessage = 'Generating transcript index...',
    transcriptMode = '',
  } = {}) => {
    const activeSourceRef = (
      sourceReference
        ? {
          sourceRef: sourceReference,
          sourceTitle: sourceTitle || sourceReference,
        }
          : null
    );
    if (!activeSourceRef) {
      setStatus('Choose a source file or URL first.');
      return false;
    }

    if (!forceOpenAiTranscript && sourceMode === 'url' && isYouTubeSource && isCheckingTranscriptAvailability) {
      setStatus('Still checking YouTube captions. Wait a moment, then try again.');
      return false;
    }

    const effectiveMode = String(transcriptMode || '').trim()
      || (forceOpenAiTranscript ? 'ai' : (sourceMode === 'url' && isYouTubeSource ? 'youtube-captions' : 'transcript'));
    setTranscriptLoadMode(effectiveMode);
    setIsTranscribing(true);
    setStatus(statusMessage);

    try {
      const result = await withTimeout(
        generateTranscript({
          videoUrl: activeSourceRef.sourceRef,
          videoTitle: activeSourceRef.sourceTitle,
          contentType: contentProfile,
          allowOpenAiFallback: forceOpenAiTranscript,
          forceOpenAiTranscript,
        }),
        90000,
        'Timed out generating transcript.'
      );

      const segmentsData = Array.isArray(result.data?.segments) ? result.data.segments : [];
      const sourceTag = result.data?.transcriptSource || 'unknown';
      const providerTag = result.data?.transcriptProviderUsed || '';
      const languageTag = result.data?.transcriptLanguageUsed || '';
      const cacheHit = Boolean(result.data?.cacheHit);

      if (segmentsData.length === 0) {
        throw new Error('No transcript segments were returned.');
      }

      setTranscriptSegments(segmentsData);

      if (sourceTag === 'youtube_caption') {
        const cacheText = cacheHit ? ' (cache hit)' : '';
        const detail = providerTag ? ` via ${providerTag}${languageTag ? ` (${languageTag})` : ''}` : '';
        setStatus(`Transcript ready: ${segmentsData.length} segments from YouTube captions${detail}${cacheText} (no OpenAI tokens used).`);
      } else if (forceOpenAiTranscript) {
        setStatus(`AI transcript ready: ${segmentsData.length} segments.`);
      } else {
        setStatus(`Transcript ready: ${segmentsData.length} segments (${sourceTag}).`);
      }

      return true;
    } catch (error) {
      setStatus(`Transcript failed: ${error.message || 'Unknown error'}`);
      return false;
    } finally {
      setIsTranscribing(false);
      setTranscriptLoadMode('idle');
    }
  }, [
    contentProfile,
    generateTranscript,
    isCheckingTranscriptAvailability,
    isYouTubeSource,
    sourceMode,
    sourceReference,
    sourceTitle,
  ]);

  const handleRunAiTranscriber = () => {
    void requestTranscript({
      forceOpenAiTranscript: true,
      statusMessage: 'Running AI transcriber...',
      transcriptMode: 'ai',
    });
  };

  useEffect(() => {
    if (sourceMode !== 'url' || !isYouTubeSource) return;
    if (isCheckingTranscriptAvailability || isTranscribing) return;
    if (transcriptSegments.length > 0) return;
    if (transcriptAvailability?.status !== 'ready' || !transcriptAvailability?.hasCaptions) return;

    const autoLoadKey = `${sourceUrl}:${transcriptAvailability.providerUsed || ''}:${transcriptAvailability.languageUsed || ''}`;
    if (autoCaptionLoadKeyRef.current === autoLoadKey) return;
    autoCaptionLoadKeyRef.current = autoLoadKey;

    void requestTranscript({
      forceOpenAiTranscript: false,
      statusMessage: 'Loading YouTube captions into transcript pane...',
      transcriptMode: 'youtube-captions',
    });
  }, [
    isCheckingTranscriptAvailability,
    isTranscribing,
    isYouTubeSource,
    requestTranscript,
    sourceMode,
    sourceUrl,
    transcriptAvailability,
    transcriptSegments.length,
  ]);

  const transcriptQueryNormalized = transcriptQuery.trim().toLowerCase();

  const transcriptRows = useMemo(() => {
    return transcriptSegments.map((segment) => {
      const startSeconds = parseTimestamp(segment.startTimestamp);
      const endSeconds = parseTimestamp(segment.endTimestamp);
      const normalizedStart = isFiniteNumber(startSeconds) ? startSeconds : 0;
      const normalizedEnd = isFiniteNumber(endSeconds) && endSeconds > normalizedStart
        ? endSeconds
        : normalizedStart + 2;

      return {
        ...segment,
        startSeconds: normalizedStart,
        endSeconds: normalizedEnd,
      };
    });
  }, [transcriptSegments]);

  const transcriptMatchIndices = useMemo(() => {
    if (!transcriptQueryNormalized) return [];
    const indices = [];
    transcriptRows.forEach((segment, index) => {
      const haystack = `${segment.speaker} ${segment.text}`.toLowerCase();
      if (haystack.includes(transcriptQueryNormalized)) {
        indices.push(index);
      }
    });
    return indices;
  }, [transcriptQueryNormalized, transcriptRows]);

  const transcriptSearchMatchCount = transcriptMatchIndices.length;
  const [activeTranscriptMatchCursor, setActiveTranscriptMatchCursor] = useState(-1);
  const activeTranscriptMatchIndex = (
    activeTranscriptMatchCursor >= 0 && activeTranscriptMatchCursor < transcriptMatchIndices.length
  )
    ? transcriptMatchIndices[activeTranscriptMatchCursor]
    : -1;

  const navigateTranscriptMatches = useCallback((direction) => {
    if (!transcriptQueryNormalized || transcriptMatchIndices.length === 0) return;

    setActiveTranscriptMatchCursor((previousCursor) => {
      const lastCursor = transcriptMatchIndices.length - 1;
      if (previousCursor < 0 || previousCursor > lastCursor) {
        return direction < 0 ? lastCursor : 0;
      }
      if (direction < 0) {
        return previousCursor === 0 ? lastCursor : previousCursor - 1;
      }
      return previousCursor === lastCursor ? 0 : previousCursor + 1;
    });
  }, [transcriptMatchIndices.length, transcriptQueryNormalized]);

  const getHighlightedTranscriptParts = useCallback((text) => {
    const rawText = String(text || '');
    if (!transcriptQueryNormalized) {
      return [{ text: rawText, isMatch: false }];
    }

    const expression = new RegExp(`(${escapeRegExp(transcriptQueryNormalized)})`, 'ig');
    return rawText
      .split(expression)
      .filter((part) => part.length > 0)
      .map((part) => ({
        text: part,
        isMatch: part.toLowerCase() === transcriptQueryNormalized,
      }));
  }, [transcriptQueryNormalized]);

  const activeTranscriptIndex = useMemo(() => {
    if (transcriptRows.length === 0) return -1;
    const seconds = Number(currentTime || 0);
    if (!isFiniteNumber(seconds)) return -1;

    let nearestIndex = -1;
    for (let index = 0; index < transcriptRows.length; index += 1) {
      const row = transcriptRows[index];
      if (seconds >= row.startSeconds && seconds < row.endSeconds) {
        return index;
      }
      if (seconds >= row.startSeconds) {
        nearestIndex = index;
      }
    }
    return nearestIndex >= 0 ? nearestIndex : 0;
  }, [transcriptRows, currentTime]);
  useEffect(() => {
    if (activeTrimDragMode) return;
    stableActiveTranscriptIndexRef.current = activeTranscriptIndex;
  }, [activeTranscriptIndex, activeTrimDragMode]);
  const displayedActiveTranscriptIndex = activeTrimDragMode
    ? stableActiveTranscriptIndexRef.current
    : activeTranscriptIndex;

  const addClipFromTranscriptSelection = useCallback(() => {
    if (!selectedTranscriptSelection) {
      setStatus('Select transcript text first.');
      return;
    }

    const startRow = transcriptRows[selectedTranscriptSelection.startIndex];
    const endRow = transcriptRows[selectedTranscriptSelection.endIndex];
    if (!startRow || !endRow) {
      setStatus('Selected transcript range is no longer available.');
      return;
    }

    const clipStartSeconds = isFiniteNumber(startRow.startSeconds)
      ? startRow.startSeconds
      : parseTimestamp(startRow.startTimestamp);
    const clipEndSecondsRaw = isFiniteNumber(endRow.endSeconds)
      ? endRow.endSeconds
      : parseTimestamp(endRow.endTimestamp);
    if (!isFiniteNumber(clipStartSeconds) || !isFiniteNumber(clipEndSecondsRaw)) {
      setStatus('Selected transcript range has invalid timing.');
      return;
    }

    const clipEndSeconds = Math.max(clipStartSeconds + 1, clipEndSecondsRaw);
    pausePreview();
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
    setStartTime(formatTimestamp(clipStartSeconds));
    setEndTime(formatTimestamp(clipEndSeconds));

    const clipLength = Math.max(1, clipEndSeconds - clipStartSeconds);
    const mediaDurationHint = isFiniteNumber(mediaDurationSeconds) && mediaDurationSeconds > 0
      ? mediaDurationSeconds
      : Math.max(Number(currentTime || 0), clipEndSeconds + clipLength);
    const focusedWindow = buildFocusedTrimWindow({
      clipStartSeconds,
      clipEndSeconds,
      mediaDurationSeconds: mediaDurationHint,
    });
    if (focusedWindow) {
      setTrimViewportRange(focusedWindow);
      setManualViewportStartSeconds(focusedWindow.start);
    }

    setStagedClipDraft({
      title: `Transcript Selection ${clipCounterRef.current + 1}`,
      description: selectedTranscriptSelection.text,
      origin: 'transcript-selection',
    });
    setAlignedPreviewWordCues([]);
    seekToSeconds(clipStartSeconds, { allowExternalOpen: false });
    setStatus('Transcript selection loaded and zoomed for trim. Drag handles to fine tune and render.');

    if (!PRECISION_ALIGNMENT_ENABLED) {
      setAlignmentWaveformData(null);
      return;
    }

    if (sourceMode !== 'url' || !isYouTubeSource || !sourceUrl) {
      setAlignmentWaveformData(null);
      setStatus('Transcript selection ready for trim. Use Go To In to return to clip start anytime.');
      return;
    }

    const requestId = precisionAlignRequestRef.current + 1;
    precisionAlignRequestRef.current = requestId;
    setIsPrecisionAligning(true);

    const startTimestamp = formatTimestampPrecise(clipStartSeconds, 2);
    const endTimestamp = formatTimestampPrecise(clipEndSeconds, 2);
    const preferredLanguage = String(transcriptAvailability?.languageUsed || '').trim();

    void (async () => {
      try {
        const result = await withTimeout(
          alignTranscriptSelection({
            videoUrl: sourceUrl,
            startTimestamp,
            endTimestamp,
            selectedText: selectedTranscriptSelection.text,
            transcriptLanguage: preferredLanguage || undefined,
            alignmentProvider,
          }),
          240000,
          'Timed out while aligning transcript selection.'
        );

        if (precisionAlignRequestRef.current !== requestId) return;
        const payload = result?.data || {};
        const alignmentLabel = formatAlignmentMetrics(payload);
        const providerFallbackMessage = String(payload?.alignmentProviderFallbackMessage || '').trim();
        const comparisonSummary = formatAlignmentComparisonSummary(payload);
        const waveformPayload = payload?.waveform || null;
        const waveformBins = Array.isArray(waveformPayload?.bins)
          ? waveformPayload.bins
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value >= 0)
          : [];
        if (waveformBins.length > 0) {
          const waveformWindowStart = Number.isFinite(Number(waveformPayload.windowStartSeconds))
            ? Number(waveformPayload.windowStartSeconds)
            : clipStartSeconds;
          const waveformWindowEnd = Number.isFinite(Number(waveformPayload.windowEndSeconds))
            ? Number(waveformPayload.windowEndSeconds)
            : clipEndSeconds;
          const inferredBinDuration = Number.isFinite(Number(waveformPayload.binDurationSeconds))
            ? Number(waveformPayload.binDurationSeconds)
            : ((waveformWindowEnd - waveformWindowStart) / waveformBins.length);
          setAlignmentWaveformData({
            source: String(waveformPayload.source || 'youtube-alignment'),
            sampleRate: Number(waveformPayload.sampleRate) || null,
            durationSeconds: Number(waveformPayload.durationSeconds) || null,
            windowStartSeconds: Number(waveformWindowStart.toFixed(3)),
            windowEndSeconds: Number(waveformWindowEnd.toFixed(3)),
            binDurationSeconds: Number((Number.isFinite(inferredBinDuration) ? inferredBinDuration : 0).toFixed(6)),
            bins: waveformBins,
          });
        } else {
          setAlignmentWaveformData(null);
        }
        const nextStart = String(payload.alignedStartTimestamp || '').trim();
        const nextEnd = String(payload.alignedEndTimestamp || '').trim();
        const nextStartSeconds = Number.isFinite(Number(payload.alignedStartSeconds))
          ? Number(payload.alignedStartSeconds)
          : parseTimestamp(nextStart);
        const nextEndSeconds = Number.isFinite(Number(payload.alignedEndSeconds))
          ? Number(payload.alignedEndSeconds)
          : parseTimestamp(nextEnd);
        const cueBaseStartSeconds = isFiniteNumber(nextStartSeconds) ? nextStartSeconds : clipStartSeconds;
        const normalizedAlignedPreviewCues = (Array.isArray(payload.alignedWordCues) ? payload.alignedWordCues : [])
          .map((cue, index) => {
            const text = cleanTitleText(cue?.text || '');
            if (!text) return null;
            const directSourceStart = Number(cue?.sourceStartSeconds);
            const directSourceEnd = Number(cue?.sourceEndSeconds);
            const relativeStart = Number(cue?.startSeconds);
            const relativeEnd = Number(cue?.endSeconds);
            const absoluteStart = Number.isFinite(directSourceStart)
              ? directSourceStart
              : (Number.isFinite(relativeStart) ? cueBaseStartSeconds + relativeStart : Number.NaN);
            const absoluteEnd = Number.isFinite(directSourceEnd)
              ? directSourceEnd
              : (Number.isFinite(relativeEnd) ? cueBaseStartSeconds + relativeEnd : Number.NaN);
            if (!isFiniteNumber(absoluteStart) || !isFiniteNumber(absoluteEnd) || absoluteEnd <= absoluteStart) return null;
            return {
              id: String(cue?.id || `aligned-preview-${index + 1}`),
              text,
              startSeconds: Number(absoluteStart.toFixed(3)),
              endSeconds: Number(absoluteEnd.toFixed(3)),
            };
          })
          .filter(Boolean);
        setAlignedPreviewWordCues(normalizedAlignedPreviewCues);
        const confidence = Number(payload.matchConfidence);
        const confidenceKnown = Number.isFinite(confidence);
        const isStableLocalMode = alignmentProvider === 'stable_ts_local';
        const shouldApplyAlignedBounds = (
          isStableLocalMode ||
          !confidenceKnown || confidence >= MIN_ALIGNMENT_CONFIDENCE_FOR_AUTO_APPLY
        );

        if (
          shouldApplyAlignedBounds &&
          isFiniteNumber(nextStartSeconds) &&
          isFiniteNumber(nextEndSeconds) &&
          nextEndSeconds > nextStartSeconds
        ) {
          setStartTime(formatTimestampPrecise(nextStartSeconds, 2));
          setEndTime(formatTimestampPrecise(nextEndSeconds, 2));

          const nextFocusedWindow = buildFocusedTrimWindow({
            clipStartSeconds: nextStartSeconds,
            clipEndSeconds: nextEndSeconds,
            mediaDurationSeconds: isFiniteNumber(mediaDurationSeconds) && mediaDurationSeconds > 0
              ? mediaDurationSeconds
              : Math.max(Number(currentTime || 0), nextEndSeconds + Math.max(1, nextEndSeconds - nextStartSeconds)),
          });
          if (nextFocusedWindow) {
            setTrimViewportRange(nextFocusedWindow);
            setManualViewportStartSeconds(nextFocusedWindow.start);
          }

          pausePreview();
          setIsAuditioningClip(false);
          setIsLoopPlayback(false);
          seekToSeconds(nextStartSeconds, { allowExternalOpen: false });
          setStatus(`Precision timing ready${alignmentLabel}. Playback is now limited to your trim handles.${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`);
          return;
        }

        if (
          !shouldApplyAlignedBounds &&
          isFiniteNumber(nextStartSeconds) &&
          isFiniteNumber(nextEndSeconds) &&
          nextEndSeconds > nextStartSeconds
        ) {
          pausePreview();
          setIsAuditioningClip(false);
          setIsLoopPlayback(false);
          seekToSeconds(clipStartSeconds, { allowExternalOpen: false });
          setStatus(
            `Precision alignment confidence is low${alignmentLabel}. Kept original timing and loaded waveform for manual trim.${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`
          );
          return;
        }

        pausePreview();
        setIsAuditioningClip(false);
        setIsLoopPlayback(false);
        seekToSeconds(clipStartSeconds, { allowExternalOpen: false });
        setStatus(`Precision alignment returned no usable timestamps${alignmentLabel}. Using caption timing.${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`);
      } catch (error) {
        if (precisionAlignRequestRef.current !== requestId) return;
        setAlignmentWaveformData(null);
        setAlignedPreviewWordCues([]);
        pausePreview();
        setIsAuditioningClip(false);
        setIsLoopPlayback(false);
        seekToSeconds(clipStartSeconds, { allowExternalOpen: false });
        setStatus(`Precision alignment unavailable: ${getCallableErrorMessage(error)}. Using caption timing.`);
      } finally {
        if (precisionAlignRequestRef.current === requestId) {
          setIsPrecisionAligning(false);
        }
      }
    })();
  }, [
    alignmentProvider,
    selectedTranscriptSelection,
    transcriptRows,
    mediaDurationSeconds,
    currentTime,
    seekToSeconds,
    pausePreview,
    sourceMode,
    isYouTubeSource,
    sourceUrl,
    transcriptAvailability?.languageUsed,
    alignTranscriptSelection,
  ]);

  const handleTranscriptMouseUp = useCallback(() => {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) {
      setSelectedTranscriptSelection(null);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !transcriptPaneRef.current) {
      setSelectedTranscriptSelection(null);
      return;
    }

    if (
      !transcriptPaneRef.current.contains(anchorNode) ||
      !transcriptPaneRef.current.contains(focusNode)
    ) {
      setSelectedTranscriptSelection(null);
      return;
    }

    const resolveTranscriptIndex = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const transcriptRow = element?.closest?.('[data-transcript-index]');
      if (!transcriptRow) return null;
      const indexValue = Number(transcriptRow.getAttribute('data-transcript-index'));
      return Number.isInteger(indexValue) ? indexValue : null;
    };

    const anchorIndex = resolveTranscriptIndex(anchorNode);
    const focusIndex = resolveTranscriptIndex(focusNode);
    if (!isFiniteNumber(anchorIndex) || !isFiniteNumber(focusIndex)) {
      setSelectedTranscriptSelection(null);
      return;
    }

    const startIndex = Math.min(anchorIndex, focusIndex);
    const endIndex = Math.max(anchorIndex, focusIndex);
    const selectedText = String(selection.toString() || '').replace(/\s+/g, ' ').trim();
    if (!selectedText) {
      setSelectedTranscriptSelection(null);
      return;
    }

    setSelectedTranscriptSelection({
      startIndex,
      endIndex,
      text: selectedText.slice(0, 600),
    });
  }, []);

  const canRunAiTranscriber = !isTranscribing && sourceMode !== 'none';
  const aiTranscriberButtonLabel = isTranscribing && transcriptLoadMode === 'ai'
    ? 'AI Transcription in Progress...'
    : 'Use AI Transcriber';
  const isLoadingYouTubeCaptions = isTranscribing && transcriptLoadMode === 'youtube-captions';
  const isCheckingYouTubeCaptions = isCheckingTranscriptAvailability;

  const statusToneClass = /failed|error|invalid|timed out|unable|unavailable/i.test(status)
    ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-100'
    : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200';

  const MIN_CLIP_SECONDS = 0.1;
  const effectiveMinClipSeconds = MIN_CLIP_SECONDS;
  const dragFractionDigits = 3;
  const queueDragRangeUpdate = useCallback((nextStart, nextEnd) => {
    pendingDragRangeRef.current = {
      start: nextStart,
      end: nextEnd,
      startText: formatTimestampPrecise(nextStart, dragFractionDigits),
      endText: formatTimestampPrecise(nextEnd, dragFractionDigits),
    };
    if (dragStateRafRef.current) return;
    dragStateRafRef.current = requestAnimationFrame(() => {
      dragStateRafRef.current = null;
      const pendingRange = pendingDragRangeRef.current;
      if (!pendingRange) return;
      setStartTime(String(pendingRange.startText || formatTimestampPrecise(pendingRange.start, dragFractionDigits)));
      setEndTime(String(pendingRange.endText || formatTimestampPrecise(pendingRange.end, dragFractionDigits)));
      pendingDragRangeRef.current = null;
    });
  }, [dragFractionDigits]);
  const rangeStartSeconds = parseTimestamp(startTime);
  const rangeEndSeconds = parseTimestamp(endTime);
  const fallbackRangeStart = isFiniteNumber(rangeStartSeconds) ? rangeStartSeconds : 0;
  const fallbackRangeEnd = isFiniteNumber(rangeEndSeconds) && rangeEndSeconds > fallbackRangeStart
    ? rangeEndSeconds
    : fallbackRangeStart + 15;
  const effectiveDurationSeconds = Math.max(
    effectiveMinClipSeconds + 1,
    Math.ceil(
      isFiniteNumber(mediaDurationSeconds) && mediaDurationSeconds > 0
        ? mediaDurationSeconds
        : Math.max(Number(currentTime || 0), fallbackRangeEnd + 10)
    )
  );
  const normalizedRangeStart = Math.max(0, Math.min(fallbackRangeStart, effectiveDurationSeconds - effectiveMinClipSeconds));
  const normalizedRangeEnd = Math.max(
    normalizedRangeStart + effectiveMinClipSeconds,
    Math.min(fallbackRangeEnd, effectiveDurationSeconds)
  );
  const hasValidRange = (
    isFiniteNumber(normalizedRangeStart) &&
    isFiniteNumber(normalizedRangeEnd) &&
    normalizedRangeEnd > normalizedRangeStart
  );
  const precisionPreviewWindowStart = Number(precisionPreviewClip?.windowStartSeconds);
  const rangeDurationLabel = hasValidRange
    ? formatTimestamp(normalizedRangeEnd - normalizedRangeStart)
    : '--:--';
  const normalizedCaptionWordsPerChunk = Math.round(
    clampNumber(Number(captionPreviewWordsPerChunk) || 5, 3, 8)
  );
  const alignedPreviewWordCuesInRange = useMemo(() => (
    (Array.isArray(alignedPreviewWordCues) ? alignedPreviewWordCues : [])
      .map((cue, index) => {
        const text = cleanTitleText(cue?.text || '');
        if (!text) return null;
        const cueStart = Number(cue?.startSeconds);
        const cueEnd = Number(cue?.endSeconds);
        if (!isFiniteNumber(cueStart) || !isFiniteNumber(cueEnd) || cueEnd <= cueStart) return null;
        if (cueEnd <= normalizedRangeStart || cueStart >= normalizedRangeEnd) return null;
        return {
          id: String(cue?.id || `aligned-cue-${index + 1}`),
          text,
          startSeconds: Number(Math.max(normalizedRangeStart, cueStart).toFixed(3)),
          endSeconds: Number(Math.min(normalizedRangeEnd, cueEnd).toFixed(3)),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.startSeconds - right.startSeconds)
  ), [alignedPreviewWordCues, normalizedRangeEnd, normalizedRangeStart]);
  const transcriptDerivedPreviewWordCues = useMemo(() => {
    const cues = [];
    transcriptRows.forEach((row, rowIndex) => {
      const rowStart = Number(row?.startSeconds);
      const rowEnd = Number(row?.endSeconds);
      if (!isFiniteNumber(rowStart) || !isFiniteNumber(rowEnd) || rowEnd <= rowStart) return;
      const segmentStart = Math.max(normalizedRangeStart, rowStart);
      const segmentEnd = Math.min(normalizedRangeEnd, rowEnd);
      if (!(segmentEnd > segmentStart)) return;

      const words = tokenizeCaptionWords(row?.text || '');
      if (words.length === 0) return;
      const slotDuration = Math.max(0.02, (segmentEnd - segmentStart) / words.length);
      words.forEach((word, index) => {
        const wordStart = segmentStart + slotDuration * index;
        const wordEnd = index === words.length - 1
          ? segmentEnd
          : segmentStart + slotDuration * (index + 1);
        cues.push({
          id: `transcript-cue-${rowIndex + 1}-${index + 1}`,
          text: word,
          startSeconds: Number(wordStart.toFixed(3)),
          endSeconds: Number(Math.max(wordStart + 0.02, wordEnd).toFixed(3)),
        });
      });
    });
    return cues;
  }, [normalizedRangeEnd, normalizedRangeStart, transcriptRows]);
  const previewWordCues = alignedPreviewWordCuesInRange.length > 0
    ? alignedPreviewWordCuesInRange
    : transcriptDerivedPreviewWordCues;
  const activePreviewWordIndex = useMemo(() => {
    if (previewWordCues.length === 0) return -1;
    const playheadSeconds = Number(currentTime);
    if (!isFiniteNumber(playheadSeconds)) return 0;
    const leadInToleranceSeconds = 0.12;
    const tailToleranceSeconds = 0.14;

    for (let index = 0; index < previewWordCues.length; index += 1) {
      const cue = previewWordCues[index];
      if (
        playheadSeconds >= (cue.startSeconds - leadInToleranceSeconds) &&
        playheadSeconds < (cue.endSeconds + tailToleranceSeconds)
      ) {
        return index;
      }
    }

    if (playheadSeconds < previewWordCues[0].startSeconds - leadInToleranceSeconds) return 0;
    if (playheadSeconds >= previewWordCues[previewWordCues.length - 1].endSeconds) {
      return previewWordCues.length - 1;
    }

    // If playhead lands between cues, follow the last cue start so highlight keeps pace.
    let nearestPastIndex = 0;
    for (let index = 0; index < previewWordCues.length; index += 1) {
      if (previewWordCues[index].startSeconds <= playheadSeconds) {
        nearestPastIndex = index;
      } else {
        break;
      }
    }
    return nearestPastIndex;
  }, [currentTime, previewWordCues]);
  const captionPreviewChunkWords = useMemo(() => {
    if (previewWordCues.length === 0) return [];
    const safeActiveIndex = activePreviewWordIndex >= 0 ? activePreviewWordIndex : 0;
    const chunkStart = Math.floor(safeActiveIndex / normalizedCaptionWordsPerChunk) * normalizedCaptionWordsPerChunk;
    return previewWordCues
      .slice(chunkStart, chunkStart + normalizedCaptionWordsPerChunk)
      .map((word, index) => {
        const globalIndex = chunkStart + index;
        return {
          ...word,
          globalIndex,
          isActive: globalIndex === activePreviewWordIndex,
        };
      });
  }, [activePreviewWordIndex, normalizedCaptionWordsPerChunk, previewWordCues]);
  const captionPreviewLines = useMemo(() => {
    if (captionPreviewChunkWords.length === 0) return [];
    const firstLineCount = Math.max(1, Math.ceil(captionPreviewChunkWords.length / 2));
    return [
      captionPreviewChunkWords.slice(0, firstLineCount),
      captionPreviewChunkWords.slice(firstLineCount),
    ].filter((line) => line.length > 0);
  }, [captionPreviewChunkWords]);
  const captionPreviewSourceLabel = alignedPreviewWordCuesInRange.length > 0
    ? 'Aligned words'
    : 'Transcript estimate';

  const baseViewportStart = isFiniteNumber(trimViewportRange?.start)
    ? trimViewportRange.start
    : 0;
  const baseViewportEnd = isFiniteNumber(trimViewportRange?.end)
    ? trimViewportRange.end
    : effectiveDurationSeconds;
  const boundedBaseStart = Math.max(0, Math.min(baseViewportStart, effectiveDurationSeconds - effectiveMinClipSeconds));
  const boundedBaseEnd = Math.max(
    boundedBaseStart + effectiveMinClipSeconds,
    Math.min(baseViewportEnd, effectiveDurationSeconds)
  );
  const baseViewportDuration = Math.max(effectiveMinClipSeconds, boundedBaseEnd - boundedBaseStart);
  const zoomLevel = Math.max(1, Math.min(8, Number(trimZoomLevel) || 1));
  // Keep timeline scale stable while trimming. Tying viewport width to clip length
  // makes pointer-to-time mapping shift under the cursor during drag.
  const zoomedViewportDuration = Math.max(
    effectiveMinClipSeconds + 0.5,
    baseViewportDuration / zoomLevel
  );
  const viewportDurationSeconds = Math.min(baseViewportDuration, zoomedViewportDuration);
  const desiredViewportStart = ((normalizedRangeStart + normalizedRangeEnd) / 2) - (viewportDurationSeconds / 2);
  const viewportStartMin = 0;
  const viewportStartMax = Math.max(viewportStartMin, effectiveDurationSeconds - viewportDurationSeconds);
  const preferredViewportStart = isFiniteNumber(manualViewportStartSeconds)
    ? manualViewportStartSeconds
    : desiredViewportStart;
  const viewportStartSeconds = Math.max(viewportStartMin, Math.min(preferredViewportStart, viewportStartMax));
  const viewportEndSeconds = viewportStartSeconds + viewportDurationSeconds;

  const trimStartPercent = Math.max(
    0,
    Math.min(100, ((normalizedRangeStart - viewportStartSeconds) / viewportDurationSeconds) * 100)
  );
  const trimEndPercent = Math.max(
    0,
    Math.min(100, ((normalizedRangeEnd - viewportStartSeconds) / viewportDurationSeconds) * 100)
  );
  const clampedCurrentSeconds = Math.max(
    viewportStartSeconds,
    Math.min(viewportEndSeconds, Number(currentTime || 0))
  );
  const currentPercent = Math.max(
    0,
    Math.min(100, ((clampedCurrentSeconds - viewportStartSeconds) / viewportDurationSeconds) * 100)
  );
  const formatTrimTimeLabel = (seconds) => (
    zoomLevel >= 3
      ? formatTimestampPrecise(seconds, 2)
      : formatTimestamp(seconds)
  );
  const viewportPanStepSeconds = Math.max(0.25, viewportDurationSeconds * 0.25);
  const viewportStartLabel = formatTrimTimeLabel(viewportStartSeconds);
  const viewportEndLabel = formatTrimTimeLabel(viewportEndSeconds);
  const activeWaveformData = useMemo(() => {
    if (sourceMode === 'file') {
      return localWaveformData?.bins?.length ? localWaveformData : null;
    }
    if (alignmentWaveformData?.bins?.length) return alignmentWaveformData;
    return null;
  }, [alignmentWaveformData, localWaveformData, sourceMode]);
  const waveformPoints = useMemo(() => {
    const bins = Array.isArray(activeWaveformData?.bins) ? activeWaveformData.bins : [];
    if (bins.length === 0) return [];
    const waveformWindowStart = Number(activeWaveformData?.windowStartSeconds);
    const waveformWindowEnd = Number(activeWaveformData?.windowEndSeconds);
    const inferredWindowEnd = Number.isFinite(waveformWindowEnd)
      ? waveformWindowEnd
      : (Number.isFinite(waveformWindowStart) ? waveformWindowStart + (Number(activeWaveformData?.durationSeconds) || 0) : null);
    const startSeconds = Number.isFinite(waveformWindowStart) ? waveformWindowStart : 0;
    const endSeconds = Number.isFinite(inferredWindowEnd) ? inferredWindowEnd : startSeconds;
    if (!(endSeconds > startSeconds)) return [];

    const fallbackBinDuration = (endSeconds - startSeconds) / bins.length;
    const binDuration = Number.isFinite(Number(activeWaveformData?.binDurationSeconds))
      ? Number(activeWaveformData.binDurationSeconds)
      : fallbackBinDuration;
    if (!Number.isFinite(binDuration) || binDuration <= 0) return [];

    const rawPoints = [];
    for (let index = 0; index < bins.length; index += 1) {
      const binStart = startSeconds + index * binDuration;
      const binEnd = binStart + binDuration;
      if (binEnd <= viewportStartSeconds || binStart >= viewportEndSeconds) continue;
      const center = Math.max(viewportStartSeconds, Math.min(viewportEndSeconds, (binStart + binEnd) / 2));
      const xPercent = clampNumber(((center - viewportStartSeconds) / viewportDurationSeconds) * 100, 0, 100);
      const amplitude = clampNumber(Number(bins[index]) || 0, 0, 1);
      rawPoints.push({
        xPercent,
        amplitude,
      });
    }
    if (rawPoints.length === 0) return [];

    const maxPoints = 520;
    if (rawPoints.length <= maxPoints) {
      return rawPoints;
    }

    const groupSize = Math.ceil(rawPoints.length / maxPoints);
    const compactPoints = [];
    for (let cursor = 0; cursor < rawPoints.length; cursor += groupSize) {
      const chunk = rawPoints.slice(cursor, cursor + groupSize);
      const xPercent = chunk.reduce((sum, point) => sum + point.xPercent, 0) / chunk.length;
      const amplitude = chunk.reduce((peak, point) => Math.max(peak, point.amplitude), 0);
      compactPoints.push({
        xPercent,
        amplitude,
      });
    }
    return compactPoints;
  }, [activeWaveformData, viewportDurationSeconds, viewportEndSeconds, viewportStartSeconds]);
  const hasWaveformShape = waveformPoints.length > 1;
  const waveformFillPath = useMemo(() => {
    if (!hasWaveformShape) return '';
    const topPoints = waveformPoints.map((point) => (
      `${point.xPercent.toFixed(3)},${(50 - (point.amplitude * 44)).toFixed(3)}`
    ));
    const bottomPoints = [...waveformPoints]
      .reverse()
      .map((point) => `${point.xPercent.toFixed(3)},${(50 + (point.amplitude * 44)).toFixed(3)}`);
    return `M ${topPoints.join(' L ')} L ${bottomPoints.join(' L ')} Z`;
  }, [hasWaveformShape, waveformPoints]);
  const waveformTopStrokePoints = useMemo(() => {
    if (!hasWaveformShape) return '';
    return waveformPoints
      .map((point) => `${point.xPercent.toFixed(3)},${(50 - (point.amplitude * 44)).toFixed(3)}`)
      .join(' ');
  }, [hasWaveformShape, waveformPoints]);
  const waveformBottomStrokePoints = useMemo(() => {
    if (!hasWaveformShape) return '';
    return waveformPoints
      .map((point) => `${point.xPercent.toFixed(3)},${(50 + (point.amplitude * 44)).toFixed(3)}`)
      .join(' ');
  }, [hasWaveformShape, waveformPoints]);
  const waveformSourceLabel = useMemo(() => {
    if (!activeWaveformData?.source) return '';
    if (activeWaveformData.source === 'web-audio-local') return 'Waveform: local audio';
    return 'Waveform: YouTube alignment window';
  }, [activeWaveformData?.source]);
  const playClipFromCurrent = useCallback(() => {
    if (!hasValidRange || isPrecisionAligning) return;

    const requestedStart = Number(currentTime || normalizedRangeStart);
    const isInsideTrimRange = requestedStart >= normalizedRangeStart && requestedStart < normalizedRangeEnd;
    const playbackStart = isInsideTrimRange
      ? requestedStart
      : normalizedRangeStart;
    seekToSeconds(playbackStart, { allowExternalOpen: false });
    const started = playPreview();
    setIsAuditioningClip(Boolean(started));
    setIsLoopPlayback(false);
  }, [
    currentTime,
    hasValidRange,
    isPrecisionAligning,
    normalizedRangeEnd,
    normalizedRangeStart,
    playPreview,
    seekToSeconds,
  ]);

  const playClipLoop = useCallback(() => {
    if (!hasValidRange || isPrecisionAligning) return;

    seekToSeconds(normalizedRangeStart, { allowExternalOpen: false });
    const started = playPreview();
    setIsAuditioningClip(Boolean(started));
    setIsLoopPlayback(Boolean(started));
  }, [hasValidRange, isPrecisionAligning, normalizedRangeStart, playPreview, seekToSeconds]);

  const stopClipPlayback = useCallback(() => {
    pausePreview();
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
    edgePreviewStateRef.current = { active: false, wasPlaying: false, mode: null };
  }, [pausePreview]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      if (event.code !== 'Space') return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = String(target.tagName || '').toUpperCase();
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') {
          return;
        }
        if (target.isContentEditable) return;
      }

      if (sourceMode === 'none' || !hasValidRange || isPrecisionAligning) return;
      event.preventDefault();
      if (isAuditioningClip) {
        stopClipPlayback();
      } else {
        playClipFromCurrent();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasValidRange, isAuditioningClip, isPrecisionAligning, playClipFromCurrent, sourceMode, stopClipPlayback]);

  const endEdgeDragPreview = useCallback(() => {
    const previewState = edgePreviewStateRef.current;
    if (!previewState.active) return;

    if (!previewState.wasPlaying) {
      pausePreview();
      setIsAuditioningClip(false);
    }
    edgePreviewStateRef.current = { active: false, wasPlaying: false, mode: null };
  }, [pausePreview]);

  const panViewportBy = useCallback((deltaSeconds) => {
    setManualViewportStartSeconds((previousStart) => {
      const currentStart = isFiniteNumber(previousStart) ? previousStart : viewportStartSeconds;
      const maxStart = Math.max(0, effectiveDurationSeconds - viewportDurationSeconds);
      return clampNumber(currentStart + deltaSeconds, 0, maxStart);
    });
  }, [effectiveDurationSeconds, viewportDurationSeconds, viewportStartSeconds]);

  const seekClipInPoint = useCallback(() => {
    if (!hasValidRange) return;
    stopClipPlayback();
    seekToSeconds(normalizedRangeStart, { allowExternalOpen: false });
  }, [hasValidRange, normalizedRangeStart, seekToSeconds, stopClipPlayback]);

  const seekClipOutPoint = useCallback(() => {
    if (!hasValidRange) return;
    stopClipPlayback();
    seekToSeconds(normalizedRangeEnd, { allowExternalOpen: false });
  }, [hasValidRange, normalizedRangeEnd, seekToSeconds, stopClipPlayback]);

  const snapBoundarySeconds = useCallback((rawSeconds, {
    min = 0,
    max = effectiveDurationSeconds,
  } = {}) => {
    if (!isFiniteNumber(rawSeconds)) return null;
    return clampNumber(rawSeconds, min, max);
  }, [
    effectiveDurationSeconds,
  ]);

  const getSecondsFromOverlayPointer = useCallback((clientX) => {
    const element = trimDragSessionRef.current?.trackElement
      || trimTimelineRef.current
      || previewOverlayRef.current;
    if (!element) return null;

    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const ratio = clampNumber((clientX - bounds.left) / bounds.width, 0, 1);
    return viewportStartSeconds + ratio * viewportDurationSeconds;
  }, [viewportDurationSeconds, viewportStartSeconds]);

  const playScrubAudioPreview = useCallback((seconds, deltaSeconds, speedSecondsPerSecond) => {
    if (!isFiniteNumber(seconds)) return;
    if (isPrecisionAligning) return;

    if (scrubAudioPauseTimeoutRef.current) {
      clearTimeout(scrubAudioPauseTimeoutRef.current);
      scrubAudioPauseTimeoutRef.current = null;
    }

    const absoluteSpeed = clampNumber(Math.abs(Number(speedSecondsPerSecond) || 0), 0.05, 8);
    const previewWindowMs = Math.round(clampNumber(120 - (absoluteSpeed * 14), 48, 120));

    if ((sourceMode === 'file' || isPrecisionPreviewActive) && videoRef.current) {
      const media = videoRef.current;
      const playbackRate = clampNumber(0.25 + (absoluteSpeed * 0.45), 0.25, 4);
      const lookbackSeconds = deltaSeconds < 0
        ? Math.min(0.32, (Math.abs(deltaSeconds) * 1.8) + 0.04)
        : 0;
      const previewStartRaw = Number(precisionPreviewClip?.windowStartSeconds);
      const previewEndRaw = Number(precisionPreviewClip?.windowEndSeconds);
      const safePreviewStart = isFiniteNumber(previewStartRaw) ? previewStartRaw : 0;
      const safePreviewEnd = isFiniteNumber(previewEndRaw) && previewEndRaw > safePreviewStart
        ? previewEndRaw
        : Math.max(seconds, safePreviewStart + 0.2);
      const previewStart = isPrecisionPreviewActive
        ? clampNumber(
          seconds - lookbackSeconds,
          safePreviewStart,
          safePreviewEnd
        )
        : Math.max(0, seconds - lookbackSeconds);
      try {
        media.currentTime = isPrecisionPreviewActive
          ? Math.max(0, previewStart - safePreviewStart)
          : previewStart;
        media.playbackRate = playbackRate;
        media.play().catch(() => {});
        scrubAudioPauseTimeoutRef.current = window.setTimeout(() => {
          media.pause();
          scrubAudioPauseTimeoutRef.current = null;
        }, previewWindowMs);
      } catch {
        // best effort preview
      }
      return;
    }

    if (sourceMode === 'url' && isYouTubeSource && youtubePlayerRef.current) {
      try {
        const lookbackSeconds = deltaSeconds < 0
          ? Math.min(0.36, (Math.abs(deltaSeconds) * 2.0) + 0.05)
          : 0;
        const previewStart = Math.max(0, seconds - lookbackSeconds);
        youtubePlayerRef.current.seekTo(previewStart, true);
        const targetRate = clampNumber(0.25 + (absoluteSpeed * 0.35), 0.25, 2);
        const availableRates = [0.25, 0.5, 1, 1.5, 2];
        const nearestRate = availableRates.reduce((best, value) => (
          Math.abs(value - targetRate) < Math.abs(best - targetRate) ? value : best
        ), availableRates[0]);
        youtubePlayerRef.current.setPlaybackRate?.(nearestRate);
        youtubePlayerRef.current.playVideo?.();
        scrubAudioPauseTimeoutRef.current = window.setTimeout(() => {
          try {
            youtubePlayerRef.current?.pauseVideo?.();
          } catch {
            // no-op
          }
          scrubAudioPauseTimeoutRef.current = null;
        }, previewWindowMs);
      } catch {
        // best effort preview
      }
    }
  }, [
    isPrecisionAligning,
    isYouTubeSource,
    isPrecisionPreviewActive,
    precisionPreviewClip,
    sourceMode,
  ]);

  const applyScrubCutAtPlayhead = useCallback((seconds) => {
    if (!hasValidRange || !isFiniteNumber(seconds)) return;

    const cutSeconds = clampNumber(seconds, 0, effectiveDurationSeconds);
    const formatCutTime = (value) => (
      zoomLevel >= 3
        ? formatTimestampPrecise(value, 2)
        : formatTimestamp(value)
    );
    if (nextScrubCutTarget === 'start') {
      const maxStart = normalizedRangeEnd - effectiveMinClipSeconds;
      const nextStart = snapBoundarySeconds(cutSeconds, {
        min: 0,
        max: maxStart,
        enableSnap: false,
      });
      if (!isFiniteNumber(nextStart)) return;
      setStartTime(formatTimestampPrecise(nextStart, dragFractionDigits));
      seekToSeconds(nextStart, { allowExternalOpen: false });
      setNextScrubCutTarget('end');
      setStatus(`Cut placed at ${formatCutTime(nextStart)} and set as In point. Next click sets Out point.`);
      return;
    }

    const minEnd = normalizedRangeStart + effectiveMinClipSeconds;
    const nextEnd = snapBoundarySeconds(cutSeconds, {
      min: minEnd,
      max: effectiveDurationSeconds,
      enableSnap: false,
    });
    if (!isFiniteNumber(nextEnd)) return;
    setEndTime(formatTimestampPrecise(nextEnd, dragFractionDigits));
    seekToSeconds(nextEnd, { allowExternalOpen: false });
    setNextScrubCutTarget('start');
    setStatus(`Cut placed at ${formatCutTime(nextEnd)} and set as Out point. Next click sets In point.`);
  }, [
    dragFractionDigits,
    effectiveMinClipSeconds,
    effectiveDurationSeconds,
    hasValidRange,
    nextScrubCutTarget,
    normalizedRangeEnd,
    normalizedRangeStart,
    seekToSeconds,
    snapBoundarySeconds,
    zoomLevel,
  ]);

  const finishScrubSession = useCallback(({ applyCutIfClick = true } = {}) => {
    const session = scrubToolSessionRef.current;
    scrubToolSessionRef.current = null;
    scrubToolPointerIdRef.current = null;
    if (!session) {
      stopScrubAudioPreview();
      return;
    }

    stopScrubAudioPreview();
    if (!applyCutIfClick) return;

    const movementX = Math.abs((session.lastClientX ?? session.startClientX) - session.startClientX);
    const movementY = Math.abs((session.lastClientY ?? session.startClientY) - session.startClientY);
    const durationMs = Math.max(0, Date.now() - session.startedAtMs);
    const wasClick = movementX < 4 && movementY < 4 && durationMs < 350;
    if (!wasClick) return;

    const cutSeconds = isFiniteNumber(session.lastSeconds)
      ? session.lastSeconds
      : getSecondsFromOverlayPointer(session.startClientX);
    if (!isFiniteNumber(cutSeconds)) return;
    applyScrubCutAtPlayhead(cutSeconds);
  }, [applyScrubCutAtPlayhead, getSecondsFromOverlayPointer, stopScrubAudioPreview]);

  const handlePreviewScrubPointerDown = useCallback((event) => {
    if (!isScrubToolActive || isPrecisionAligning) return;
    if (activeTrimDragMode) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const pointerSeconds = getSecondsFromOverlayPointer(event.clientX);
    if (!isFiniteNumber(pointerSeconds)) return;

    event.preventDefault();
    event.stopPropagation();
    stopClipPlayback();

    scrubToolPointerIdRef.current = event.pointerId;
    scrubToolSessionRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastSeconds: pointerSeconds,
      lastTimestampMs: Date.now(),
      startedAtMs: Date.now(),
    };

    seekToSeconds(pointerSeconds, { allowExternalOpen: false });
    playScrubAudioPreview(pointerSeconds, 0, 0.25);
  }, [
    activeTrimDragMode,
    getSecondsFromOverlayPointer,
    isPrecisionAligning,
    isScrubToolActive,
    playScrubAudioPreview,
    seekToSeconds,
    stopClipPlayback,
  ]);

  const applyOverlayDrag = useCallback((mode, clientX) => {
    const pointerSeconds = getSecondsFromOverlayPointer(clientX);
    if (!isFiniteNumber(pointerSeconds)) return;
    if (mode === 'start' || mode === 'end') {
      if (mode === 'start') {
        const maxStart = normalizedRangeEnd - effectiveMinClipSeconds;
        const nextStart = snapBoundarySeconds(pointerSeconds, {
          min: 0,
          max: maxStart,
        });
        if (!isFiniteNumber(nextStart)) return;
        queueDragRangeUpdate(nextStart, normalizedRangeEnd);
      } else {
        const minEnd = normalizedRangeStart + effectiveMinClipSeconds;
        const nextEnd = snapBoundarySeconds(pointerSeconds, {
          min: minEnd,
          max: effectiveDurationSeconds,
        });
        if (!isFiniteNumber(nextEnd)) return;
        queueDragRangeUpdate(normalizedRangeStart, nextEnd);
      }
      return;
    }
    if (mode !== 'block') return;

    const session = trimDragSessionRef.current || {};
    const clipSpanSeconds = Math.max(
      effectiveMinClipSeconds,
      Number(session.clipSpanSeconds) || (normalizedRangeEnd - normalizedRangeStart)
    );
    const maxStart = Math.max(0, effectiveDurationSeconds - clipSpanSeconds);
    const rawAnchorOffset = Number(session.anchorOffsetSeconds);
    const anchorOffsetSeconds = isFiniteNumber(rawAnchorOffset)
      ? clampNumber(rawAnchorOffset, 0, clipSpanSeconds)
      : clipSpanSeconds / 2;

    let nextStart = clampNumber(pointerSeconds - anchorOffsetSeconds, 0, maxStart);
    const nextEnd = nextStart + clipSpanSeconds;
    queueDragRangeUpdate(nextStart, nextEnd);
  }, [
    effectiveMinClipSeconds,
    effectiveDurationSeconds,
    getSecondsFromOverlayPointer,
    normalizedRangeEnd,
    normalizedRangeStart,
    queueDragRangeUpdate,
    snapBoundarySeconds,
  ]);

  const beginOverlayDrag = useCallback((mode, event) => {
    if (isPrecisionAligning) return;
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const trackElement = event.currentTarget?.closest?.('[data-trim-track]')
      || trimTimelineRef.current
      || previewOverlayRef.current;

    trimDragSessionRef.current = {
      trackElement,
    };
    setManualViewportStartSeconds(viewportStartSeconds);
    if (mode === 'block') {
      const pointerSeconds = getSecondsFromOverlayPointer(event.clientX);
      const clipSpanSeconds = Math.max(effectiveMinClipSeconds, normalizedRangeEnd - normalizedRangeStart);
      const rawOffset = isFiniteNumber(pointerSeconds)
        ? pointerSeconds - normalizedRangeStart
        : clipSpanSeconds / 2;
      trimDragSessionRef.current.clipSpanSeconds = clipSpanSeconds;
      trimDragSessionRef.current.anchorOffsetSeconds = clampNumber(rawOffset, 0, clipSpanSeconds);
    }

    endEdgeDragPreview();
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
    setActiveTrimDragMode(mode);
    applyOverlayDrag(mode, event.clientX);
  }, [
    applyOverlayDrag,
    endEdgeDragPreview,
    effectiveMinClipSeconds,
    getSecondsFromOverlayPointer,
    isPrecisionAligning,
    normalizedRangeEnd,
    normalizedRangeStart,
    viewportStartSeconds,
  ]);

  useEffect(() => {
    if (
      approximatelyEqual(rangeStartSeconds, normalizedRangeStart) &&
      approximatelyEqual(rangeEndSeconds, normalizedRangeEnd)
    ) {
      return;
    }
    setStartTime(formatTimestampPrecise(normalizedRangeStart, dragFractionDigits));
    setEndTime(formatTimestampPrecise(normalizedRangeEnd, dragFractionDigits));
  }, [dragFractionDigits, normalizedRangeEnd, normalizedRangeStart, rangeEndSeconds, rangeStartSeconds]);

  useEffect(() => {
    if (!isPrecisionAligning) return;
    stopClipPlayback();
  }, [isPrecisionAligning, stopClipPlayback]);

  useEffect(() => {
    if (!activeTrimDragMode) return undefined;

    const onMouseMove = (event) => {
      if (event.buttons === 0) {
        finishOverlayDrag();
        return;
      }
      applyOverlayDrag(activeTrimDragMode, event.clientX);
    };
    const onMouseUp = () => {
      finishOverlayDrag();
    };
    const onWindowBlur = () => {
      finishOverlayDrag();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [activeTrimDragMode]);

  useEffect(() => {
    const onPointerMove = (event) => {
      const activePointerId = scrubToolPointerIdRef.current;
      if (activePointerId === null || event.pointerId !== activePointerId) return;

      const session = scrubToolSessionRef.current;
      if (!session) return;

      const nextSeconds = getSecondsFromOverlayPointer(event.clientX);
      if (!isFiniteNumber(nextSeconds)) return;

      const nowMs = Date.now();
      const dtMs = Math.max(1, nowMs - Number(session.lastTimestampMs || nowMs));
      const deltaSeconds = nextSeconds - Number(session.lastSeconds || nextSeconds);
      const speed = Math.abs(deltaSeconds) / (dtMs / 1000);

      session.lastClientX = event.clientX;
      session.lastClientY = event.clientY;
      session.lastSeconds = nextSeconds;
      session.lastTimestampMs = nowMs;

      seekToSeconds(nextSeconds, { allowExternalOpen: false });
      playScrubAudioPreview(nextSeconds, deltaSeconds, speed);
    };

    const onPointerUp = (event) => {
      const activePointerId = scrubToolPointerIdRef.current;
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      finishScrubSession({ applyCutIfClick: true });
    };

    const onPointerCancel = (event) => {
      const activePointerId = scrubToolPointerIdRef.current;
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      finishScrubSession({ applyCutIfClick: false });
    };

    const onWindowBlur = () => {
      if (scrubToolPointerIdRef.current === null) return;
      finishScrubSession({ applyCutIfClick: false });
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [finishScrubSession, getSecondsFromOverlayPointer, playScrubAudioPreview, seekToSeconds]);

  useEffect(() => {
    finishOverlayDrag();
    finishScrubSession({ applyCutIfClick: false });
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
  }, [sourceMode, sourceUrl, sourceFile, finishOverlayDrag, finishScrubSession]);

  useEffect(() => {
    if (isScrubToolActive) return;
    finishScrubSession({ applyCutIfClick: false });
  }, [finishScrubSession, isScrubToolActive]);

  useEffect(() => {
    if (stagedClipDraft?.origin === 'transcript-selection') return;
    setTrimViewportRange(null);
    setManualViewportStartSeconds(null);
  }, [stagedClipDraft]);

  useEffect(() => {
    if (!isAuditioningClip) return;
    if (!isFiniteNumber(currentTime)) return;
    if (currentTime < normalizedRangeEnd) return;

    if (isLoopPlayback) {
      seekToSeconds(normalizedRangeStart, { allowExternalOpen: false });
      const restarted = playPreview();
      if (!restarted) {
        setIsLoopPlayback(false);
        setIsAuditioningClip(false);
      }
      return;
    }

    pausePreview();
    setIsAuditioningClip(false);
  }, [
    currentTime,
    isAuditioningClip,
    isLoopPlayback,
    normalizedRangeEnd,
    normalizedRangeStart,
    pausePreview,
    playPreview,
    seekToSeconds,
  ]);

  useEffect(() => {
    const destroyPlayer = () => {
      if (youtubeTimePollRef.current) {
        clearInterval(youtubeTimePollRef.current);
        youtubeTimePollRef.current = null;
      }
      if (youtubePlayerRef.current) {
        youtubePlayerRef.current.destroy();
        youtubePlayerRef.current = null;
      }
    };

    if (
      sourceMode !== 'url'
      || !isYouTubeSource
      || !youtubeVideoId
      || !youtubePlayerMountRef.current
      || isPrecisionPreviewActive
    ) {
      destroyPlayer();
      return undefined;
    }

    let disposed = false;
    setYoutubePlayerError('');

    const initPlayer = async () => {
      try {
        const YT = await ensureYouTubeIframeApi();
        if (disposed || !youtubePlayerMountRef.current) return;

        destroyPlayer();

        youtubePlayerRef.current = new YT.Player(youtubePlayerMountRef.current, {
          videoId: youtubeVideoId,
          playerVars: {
            controls: 1,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
          },
          events: {
            onReady: () => {
              if (disposed) return;
              const initialVideoTitle = String(youtubePlayerRef.current?.getVideoData?.()?.title || '').trim();
              const initialDuration = Number(youtubePlayerRef.current?.getDuration?.() || 0);
              if (isFiniteNumber(initialDuration) && initialDuration > 0) {
                setMediaDurationSeconds(initialDuration);
              }
              if (initialVideoTitle) {
                setYoutubeVideoTitle(initialVideoTitle);
                youtubeVideoTitleRef.current = initialVideoTitle;
                onProjectNameSuggestion?.(initialVideoTitle);
              }
              youtubeTimePollRef.current = setInterval(() => {
                const seconds = Number(youtubePlayerRef.current?.getCurrentTime?.() || 0);
                if (Number.isFinite(seconds)) setCurrentTime(seconds);
                const polledDuration = Number(youtubePlayerRef.current?.getDuration?.() || 0);
                if (isFiniteNumber(polledDuration) && polledDuration > 0) {
                  setMediaDurationSeconds((previous) => {
                    if (isFiniteNumber(previous) && Math.abs(previous - polledDuration) < 0.5) {
                      return previous;
                    }
                    return polledDuration;
                  });
                }

                if (!youtubeVideoTitleRef.current) {
                  const polledTitle = String(youtubePlayerRef.current?.getVideoData?.()?.title || '').trim();
                  if (polledTitle) {
                    setYoutubeVideoTitle(polledTitle);
                    youtubeVideoTitleRef.current = polledTitle;
                    onProjectNameSuggestion?.(polledTitle);
                  }
                }
              }, 500);
            },
            onError: (event) => {
              const code = Number(event?.data);
              const message = (
                code === 101 || code === 150
                  ? 'This video cannot be embedded. Use Jump to open it in YouTube.'
                  : 'YouTube player error. Use Jump to open this timestamp in YouTube.'
              );
              setYoutubePlayerError(message);
            },
          },
        });
      } catch {
        setYoutubePlayerError('Failed to load embedded YouTube player.');
      }
    };

    initPlayer();

    return () => {
      disposed = true;
      destroyPlayer();
    };
  }, [onProjectNameSuggestion, sourceMode, isYouTubeSource, youtubeVideoId, isPrecisionPreviewActive]);

  useEffect(() => {
    if (transcriptQueryNormalized) {
      setAutoFollowTranscript(false);
      return;
    }
    setAutoFollowTranscript(true);
  }, [transcriptQueryNormalized, sourceMode]);

  useEffect(() => {
    if (!transcriptQueryNormalized || transcriptMatchIndices.length === 0) {
      setActiveTranscriptMatchCursor(-1);
      return;
    }
    setActiveTranscriptMatchCursor((previousCursor) => {
      if (previousCursor >= 0 && previousCursor < transcriptMatchIndices.length) {
        return previousCursor;
      }
      return 0;
    });
  }, [transcriptMatchIndices.length, transcriptQueryNormalized]);

  useEffect(() => {
    setSelectedTranscriptSelection(null);
  }, [transcriptQueryNormalized, sourceMode, sourceUrl, sourceFile, transcriptRows.length]);

  useEffect(() => {
    if (!transcriptQueryNormalized) return;
    if (activeTranscriptMatchCursor < 0) return;
    const rowIndex = transcriptMatchIndices[activeTranscriptMatchCursor];
    if (!isFiniteNumber(rowIndex)) return;

    const rowElement = transcriptRowRefs.current[rowIndex];
    if (!rowElement) return;

    transcriptAutoScrollRef.current = true;
    rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timeoutId = window.setTimeout(() => {
      transcriptAutoScrollRef.current = false;
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [activeTranscriptMatchCursor, transcriptMatchIndices, transcriptQueryNormalized]);

  useEffect(() => {
    if (transcriptQueryNormalized) return;
    if (!autoFollowTranscript) return;
    if (activeTrimDragMode) return;
    if (displayedActiveTranscriptIndex < 0) return;

    const rowElement = transcriptRowRefs.current[displayedActiveTranscriptIndex];
    if (!rowElement) return;

    transcriptAutoScrollRef.current = true;
    rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timeoutId = window.setTimeout(() => {
      transcriptAutoScrollRef.current = false;
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [activeTrimDragMode, autoFollowTranscript, displayedActiveTranscriptIndex, transcriptQueryNormalized]);

  const transcriptPaneContent = useMemo(() => {
    if (transcriptRows.length === 0) {
      return (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Generate transcript to view full transcript here.
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-slate-200/60 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 p-4 text-[15px] leading-7 text-slate-700 dark:text-slate-200 select-text">
        {transcriptRows.map((segment, index) => {
          const isActive = displayedActiveTranscriptIndex === index && !transcriptQueryNormalized;
          const isActiveSearchMatch = activeTranscriptMatchIndex === index && transcriptQueryNormalized;
          const isSelectedRange = selectedTranscriptSelection &&
            index >= selectedTranscriptSelection.startIndex &&
            index <= selectedTranscriptSelection.endIndex;
          const highlightedParts = getHighlightedTranscriptParts(segment.text);

          return (
            <span
              key={`${segment.startTimestamp}-${segment.endTimestamp}-${index}`}
              data-transcript-index={index}
              data-start={segment.startTimestamp}
              data-end={segment.endTimestamp}
              ref={(node) => {
                if (node) transcriptRowRefs.current[index] = node;
              }}
              onDoubleClick={() => jumpToTimestamp(segment.startTimestamp)}
              onClick={() => {
                if (!transcriptQueryNormalized) return;
                const matchCursor = transcriptMatchIndices.indexOf(index);
                if (matchCursor >= 0) {
                  setActiveTranscriptMatchCursor(matchCursor);
                }
              }}
              title="Double-click to jump preview to this line"
              className={`inline rounded px-0.5 py-0.5 transition-colors ${
                isSelectedRange
                  ? 'bg-primary/20'
                  : isActiveSearchMatch
                    ? 'bg-amber-300/45 dark:bg-amber-500/35 ring-1 ring-amber-400/70 dark:ring-amber-300/60'
                    : isActive
                      ? 'bg-emerald-400/20'
                      : ''
              }`}
            >
              {highlightedParts.map((part, partIndex) => (
                part.isMatch ? (
                  <mark key={partIndex} className="bg-amber-300/70 dark:bg-amber-500/40 text-inherit rounded px-0.5">
                    {part.text}
                  </mark>
                ) : (
                  <React.Fragment key={partIndex}>{part.text}</React.Fragment>
                )
              ))}
              {' '}
            </span>
          );
        })}
      </div>
    );
  }, [
    activeTranscriptMatchIndex,
    displayedActiveTranscriptIndex,
    getHighlightedTranscriptParts,
    jumpToTimestamp,
    selectedTranscriptSelection,
    transcriptMatchIndices,
    transcriptQueryNormalized,
    transcriptRows,
  ]);

  return (
    <section className="glass rounded-3xl p-5 lg:p-6 space-y-5">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4 items-start">
        <div className="space-y-4">
          {(sourceMode === 'file' && localVideoUrl)
            || isPrecisionPreviewActive
            || (sourceMode === 'url' && isYouTubeSource && youtubeVideoId) ? (
            <div className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Preview and Trim</div>
                <div className="inline-flex items-center gap-2 flex-wrap">
                  {isPrecisionPreviewActive && (
                    <span className="text-xs font-semibold px-2 py-1 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                      Precision Preview Active
                    </span>
                  )}
                  <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    Clip Length: {rangeDurationLabel}
                  </span>
                </div>
              </div>

              {stagedClipDraft?.origin === 'transcript-selection' && (
                <div className="rounded-xl border border-primary/35 bg-primary/10 px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-primary">Transcript selection loaded for trim</div>
                    <button
                      onClick={() => setStagedClipDraft(null)}
                      className="text-[11px] font-semibold px-2 py-1 rounded-md border border-primary/40 text-primary"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="text-xs text-slate-700 dark:text-slate-200 line-clamp-2">
                    {stagedClipDraft.description}
                  </div>
                </div>
              )}

              <div
                ref={previewOverlayRef}
                className={`relative aspect-video w-full rounded-xl overflow-hidden bg-black/80 select-none ${
                  isScrubToolActive ? 'cursor-col-resize' : ''
                }`}
              >
                {previewVideoUrl && (
                  <video
                    ref={videoRef}
                    src={previewVideoUrl}
                    controls={!isPrecisionAligning && !isScrubToolActive}
                    className="w-full h-full rounded-xl bg-black/70"
                    onTimeUpdate={(event) => {
                      const seconds = Number(event.currentTarget.currentTime || 0);
                      if (isPrecisionPreviewActive) {
                        const baseStart = isFiniteNumber(precisionPreviewWindowStart) ? precisionPreviewWindowStart : 0;
                        setCurrentTime(baseStart + seconds);
                        return;
                      }
                      setCurrentTime(seconds);
                    }}
                    onLoadedMetadata={(event) => {
                      const duration = Number(event.currentTarget.duration || 0);
                      if (isFiniteNumber(duration) && duration > 0) {
                        if (sourceMode === 'file') {
                          setMediaDurationSeconds(duration);
                        } else if (isPrecisionPreviewActive) {
                          const baseStart = isFiniteNumber(precisionPreviewWindowStart) ? precisionPreviewWindowStart : 0;
                          const estimatedEnd = baseStart + duration;
                          setPrecisionPreviewClip((previous) => {
                            if (!previous) return previous;
                            return {
                              ...previous,
                              windowEndSeconds: Number(estimatedEnd.toFixed(3)),
                            };
                          });
                        }
                      }
                    }}
                    onError={() => {
                      if (!isPrecisionPreviewActive) return;
                      setPrecisionPreviewClip(null);
                      setStatus('Precision preview clip is unavailable or expired. Switched back to YouTube source.');
                    }}
                  />
                )}

                {sourceMode === 'url' && isYouTubeSource && youtubeVideoId && !isPrecisionPreviewActive && (
                  <div className="w-full h-full">
                    <div ref={youtubePlayerMountRef} className="w-full h-full" />
                  </div>
                )}

                {isPrecisionAligning && (
                  <div className="absolute inset-0 z-20 bg-black/55 backdrop-blur-[1px] flex items-center justify-center text-center pointer-events-auto px-4">
                    <div className="inline-flex items-center gap-2 rounded-lg border border-sky-300/55 bg-sky-900/35 px-3 py-2 text-xs font-semibold text-sky-100">
                      <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                      Precision transcription in progress. Playback resumes when alignment finishes.
                    </div>
                  </div>
                )}

                {isScrubToolActive && !isPrecisionAligning && (
                  <div
                    className="absolute inset-0 z-10 bg-transparent cursor-col-resize"
                    onPointerDown={handlePreviewScrubPointerDown}
                  />
                )}

                {showCaptionPreview && captionPreviewLines.length > 0 && (
                  <div className="absolute inset-x-3 bottom-3 z-30 pointer-events-none flex justify-center">
                    <div className="max-w-[90%] rounded-xl border border-white/20 bg-black/70 px-3 py-2 shadow-lg shadow-black/50 backdrop-blur-[1px]">
                      <div className="space-y-1.5 text-center leading-tight">
                        {captionPreviewLines.map((line, lineIndex) => (
                          <div
                            key={`caption-line-${lineIndex}`}
                            className="flex flex-wrap justify-center items-baseline gap-x-1.5 gap-y-1"
                          >
                            {line.map((word) => (
                              <span
                                key={word.id}
                                className={`inline-block px-1 rounded transition-all duration-100 ${
                                  word.isActive
                                    ? 'text-amber-300 scale-110 font-extrabold drop-shadow-[0_0_6px_rgba(251,191,36,0.75)]'
                                    : 'text-white/95 font-semibold'
                                }`}
                              >
                                {word.text}
                              </span>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                  <span>Viewport {viewportStartLabel} - {viewportEndLabel}</span>
                  <div className="inline-flex items-center gap-3">
                    {waveformSourceLabel && (
                      <span className="text-[10px] uppercase tracking-wide text-sky-700 dark:text-sky-300">
                        {waveformSourceLabel}
                      </span>
                    )}
                    <span>In {formatTrimTimeLabel(normalizedRangeStart)} / Out {formatTrimTimeLabel(normalizedRangeEnd)}</span>
                  </div>
                </div>

                <div ref={trimTimelineRef} data-trim-track className={`relative h-20 rounded-lg border border-slate-300/80 dark:border-slate-600/70 bg-white/90 dark:bg-slate-800/80 overflow-hidden select-none ${isPrecisionAligning ? 'opacity-70 pointer-events-none' : ''}`}>
                  <div className="absolute inset-0 z-0 pointer-events-none">
                    <svg
                      className="absolute inset-0 h-full w-full"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden
                    >
                      <line
                        x1="0"
                        y1="50"
                        x2="100"
                        y2="50"
                        className="stroke-slate-500/35 dark:stroke-slate-300/25"
                        strokeWidth="0.65"
                      />
                      {hasWaveformShape && (
                        <>
                          <path d={waveformFillPath} className="fill-[#10228A]/85 dark:fill-cyan-300/65" />
                          <polyline
                            points={waveformTopStrokePoints}
                            fill="none"
                            className="stroke-[#0A124F]/90 dark:stroke-cyan-100/90"
                            strokeWidth="0.45"
                          />
                          <polyline
                            points={waveformBottomStrokePoints}
                            fill="none"
                            className="stroke-[#0A124F]/90 dark:stroke-cyan-100/90"
                            strokeWidth="0.45"
                          />
                        </>
                      )}
                    </svg>
                  </div>
                  <div
                    role="slider"
                    aria-label="Trim clip start"
                    aria-valuemin={0}
                    aria-valuemax={effectiveDurationSeconds}
                    aria-valuenow={normalizedRangeStart}
                    className="absolute inset-y-0 z-30 w-6 -translate-x-1/2 cursor-ew-resize pointer-events-auto"
                    style={{ left: `${trimStartPercent}%` }}
                    onMouseDown={(event) => beginOverlayDrag('start', event)}
                    title="Drag In point"
                  >
                    <div className="mx-auto h-full w-[2px] bg-primary/95 shadow-[0_0_0_1px_rgba(255,255,255,0.18)]" />
                  </div>

                  <div
                    role="slider"
                    aria-label="Trim clip end"
                    aria-valuemin={0}
                    aria-valuemax={effectiveDurationSeconds}
                    aria-valuenow={normalizedRangeEnd}
                    className="absolute inset-y-0 z-30 w-6 -translate-x-1/2 cursor-ew-resize pointer-events-auto"
                    style={{ left: `${trimEndPercent}%` }}
                    onMouseDown={(event) => beginOverlayDrag('end', event)}
                    title="Drag Out point"
                  >
                    <div className="mx-auto h-full w-[2px] bg-primary/95 shadow-[0_0_0_1px_rgba(255,255,255,0.18)]" />
                  </div>

                  <div
                    className="absolute top-0 bottom-0 z-40 w-[2px] bg-sky-500 pointer-events-none"
                    style={{ left: `${currentPercent}%` }}
                  />
                </div>

                {sourceMode === 'url' && !isPrecisionAligning && !hasWaveformShape && (
                  <div className="text-[11px] text-amber-700 dark:text-amber-300">
                    Waveform unavailable for this clip window yet. Select transcript text and wait for precision alignment to finish.
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 flex-wrap text-[11px]">
                  <div className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
                    <button
                      type="button"
                      onClick={() => panViewportBy(-viewportPanStepSeconds)}
                      className="px-2 h-7 rounded-md border border-slate-300 dark:border-slate-600 font-semibold"
                      title="Pan viewport left"
                      disabled={isPrecisionAligning}
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrimZoomLevel((previous) => clampNumber(previous - 0.5, 1, 8))}
                      className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-600 font-semibold"
                      title="Zoom out trim timeline"
                      disabled={isPrecisionAligning}
                    >
                      -
                    </button>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      step="0.5"
                      value={zoomLevel}
                      onChange={(event) => setTrimZoomLevel(clampNumber(Number(event.target.value), 1, 8))}
                      className="w-28 accent-primary"
                      aria-label="Trim timeline zoom"
                      disabled={isPrecisionAligning}
                    />
                    <button
                      type="button"
                      onClick={() => setTrimZoomLevel((previous) => clampNumber(previous + 0.5, 1, 8))}
                      className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-600 font-semibold"
                      title="Zoom in trim timeline"
                      disabled={isPrecisionAligning}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => panViewportBy(viewportPanStepSeconds)}
                      className="px-2 h-7 rounded-md border border-slate-300 dark:border-slate-600 font-semibold"
                      title="Pan viewport right"
                      disabled={isPrecisionAligning}
                    >
                      ▶
                    </button>
                    <span className="font-semibold">Zoom {zoomLevel.toFixed(1)}x</span>
                  </div>

                </div>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap rounded-lg bg-black/65 border border-white/20 px-3 py-2 text-[11px] text-slate-100">
                <span>Current {formatTrimTimeLabel(clampedCurrentSeconds)}</span>
                <div className="inline-flex items-center gap-2">
                  <button
                    onClick={() => {
                      setIsScrubToolActive((previous) => !previous);
                      setNextScrubCutTarget('start');
                    }}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50 ${
                      isScrubToolActive
                        ? 'bg-amber-500/90 text-white'
                        : 'bg-white/15 text-white'
                    }`}
                    title="Toggle scrub tool for precise playhead cuts"
                  >
                    <span className="material-symbols-outlined text-[13px]">content_cut</span>
                    {isScrubToolActive ? 'Scrub On' : 'Scrub Tool'}
                  </button>
                  <button
                    onClick={seekClipInPoint}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                    title="Move playhead to trim start"
                  >
                    Go To In
                  </button>
                  <button
                    onClick={seekClipOutPoint}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                    title="Move playhead to trim end"
                  >
                    Go To Out
                  </button>
                  <button
                    onClick={isAuditioningClip ? stopClipPlayback : playClipFromCurrent}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-sky-500/90 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                  >
                    {isAuditioningClip ? 'Stop' : 'Play Clip'}
                  </button>
                  <button
                    onClick={isLoopPlayback ? stopClipPlayback : playClipLoop}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-violet-500/90 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                  >
                    {isLoopPlayback ? 'Stop Loop' : 'Loop Clip'}
                  </button>
                  {sourceMode === 'url' && isYouTubeSource && (
                    <>
                      <button
                        onClick={generatePrecisionPreviewClip}
                        disabled={!hasValidRange || isPrecisionAligning || isRendering || isGeneratingPrecisionPreview}
                        className="bg-emerald-500/90 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                      >
                        {isGeneratingPrecisionPreview
                          ? 'Rendering Preview...'
                          : isPrecisionPreviewActive
                            ? 'Refresh Preview Clip'
                            : 'Create Preview Clip'}
                      </button>
                      {isPrecisionPreviewActive && (
                        <button
                          onClick={() => {
                            setPrecisionPreviewClip(null);
                            setStatus('Switched back to embedded YouTube preview.');
                          }}
                          disabled={isPrecisionAligning || isGeneratingPrecisionPreview}
                          className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                        >
                          Back To YouTube
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={addSegment}
                    disabled={sourceMode === 'none' || !hasValidRange || isRendering || isPrecisionAligning || isGeneratingPrecisionPreview}
                    className="bg-primary text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                  >
                    {isPrecisionAligning
                      ? 'Aligning...'
                      : isRendering
                      ? 'Rendering...'
                      : stagedClipDraft
                        ? 'Render Trimmed Clip'
                        : 'Render Clip'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 px-3 py-2 text-[11px]">
                <div className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowCaptionPreview((previous) => !previous)}
                    className={`px-2.5 py-1.5 rounded-md border font-semibold ${
                      showCaptionPreview
                        ? 'border-primary/60 bg-primary/15 text-primary'
                        : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {showCaptionPreview ? 'Caption Preview On' : 'Caption Preview Off'}
                  </button>
                  <span className="text-slate-600 dark:text-slate-300">
                    {previewWordCues.length} timed words ({captionPreviewSourceLabel})
                  </span>
                </div>
                <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
                  <span className="font-semibold">Words</span>
                  <input
                    type="range"
                    min="3"
                    max="8"
                    step="1"
                    value={normalizedCaptionWordsPerChunk}
                    onChange={(event) => setCaptionPreviewWordsPerChunk(Number(event.target.value))}
                    className="w-24 accent-primary"
                    aria-label="Caption preview words per chunk"
                  />
                  <span className="w-5 text-center font-semibold">{normalizedCaptionWordsPerChunk}</span>
                </label>
              </div>

              <div className="text-xs text-slate-500 dark:text-slate-400">
                Drag left/right handles for edge trim. Use ◀ ▶ to pan the viewport, enable Scrub Tool to shuttle audio and click-to-cut In/Out at the playhead, and press Space to play/stop.
              </div>
              {isPrecisionAligning && (
                <div className="text-xs text-sky-700 dark:text-sky-300">
                  Running precision audio alignment on selected transcript text...
                </div>
              )}
              {youtubePlayerError && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  {youtubePlayerError}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <aside className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 flex flex-col min-h-[480px] max-h-[72vh]">
          <div className="p-4 border-b border-slate-200/70 dark:border-slate-700/70 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Transcript Pane</div>
              <button
                onClick={handleRunAiTranscriber}
                disabled={!canRunAiTranscriber}
                className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 via-primary to-cyan-600 text-white px-3 py-2 rounded-lg text-xs font-bold shadow-lg shadow-indigo-500/30 hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {isTranscribing ? 'hourglass_top' : 'auto_awesome'}
                </span>
                {aiTranscriberButtonLabel}
              </button>
            </div>

            {PRECISION_ALIGNMENT_ENABLED && (
              <div className="rounded-lg border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/80 dark:bg-slate-900/45 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
                  Precision Sync Engine
                </div>
                <div className="mt-2 inline-flex rounded-md border border-slate-300 dark:border-slate-600 overflow-hidden">
                  {ALIGNMENT_PROVIDER_OPTIONS.map((option) => {
                    const selected = alignmentProvider === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setAlignmentProvider(option.id)}
                        disabled={isPrecisionAligning}
                        className={`px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
                          selected
                            ? 'bg-primary text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200'
                        }`}
                        title={option.description}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {alignmentProvider === 'stable_ts_local'
                    ? 'High Accuracy runs local stable-ts only (beta). It fails fast when unavailable; no OpenAI fallback.'
                    : alignmentProvider === 'ab_compare'
                      ? 'A/B Test reports baseline Fast metrics versus High Accuracy candidate metrics when available.'
                    : 'Fast mode uses OpenAI timed transcription plus fuzzy word matching.'}
                </div>
              </div>
            )}

            <label htmlFor="transcript-query" className="sr-only">Search transcript keywords</label>
            <input
              id="transcript-query"
              name="transcriptQuery"
              type="text"
              value={transcriptQuery}
              onChange={(event) => setTranscriptQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                navigateTranscriptMatches(event.shiftKey ? -1 : 1);
              }}
              placeholder="Search transcript keywords"
              className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
            />

            <div className="flex items-center justify-end gap-2 text-xs">
              {!transcriptQueryNormalized && (
                autoFollowTranscript ? (
                  <span className="text-emerald-600 dark:text-emerald-300 font-semibold">Following playback</span>
                ) : (
                  <button
                    onClick={() => setAutoFollowTranscript(true)}
                    className="font-semibold text-primary hover:underline"
                  >
                    Follow playback
                  </button>
                )
              )}
              {transcriptQueryNormalized && (
                <div className="inline-flex items-center gap-2">
                  <span className="text-amber-600 dark:text-amber-300 font-semibold">
                    {transcriptSearchMatchCount === 0
                      ? '0 matches'
                      : `${activeTranscriptMatchCursor + 1} of ${transcriptSearchMatchCount}`}
                  </span>
                  <button
                    onClick={() => navigateTranscriptMatches(-1)}
                    disabled={transcriptSearchMatchCount === 0}
                    className="px-2 py-1 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 font-semibold disabled:opacity-50"
                    title="Previous match (Shift+Enter)"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => navigateTranscriptMatches(1)}
                    disabled={transcriptSearchMatchCount === 0}
                    className="px-2 py-1 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 font-semibold disabled:opacity-50"
                    title="Next match (Enter)"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            {sourceMode === 'url' && isYouTubeSource && (isCheckingYouTubeCaptions || isLoadingYouTubeCaptions) && (
              <div className="rounded-lg border border-sky-300/60 dark:border-sky-500/50 bg-sky-50/90 dark:bg-sky-950/25 px-3 py-2 text-xs text-sky-800 dark:text-sky-200 inline-flex items-center gap-2">
                <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                {isCheckingYouTubeCaptions
                  ? 'Checking YouTube captions availability...'
                  : 'Loading YouTube transcript...'}
              </div>
            )}

            {selectedTranscriptSelection && (
              <div className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 space-y-2">
                <div className="text-xs font-semibold text-primary">
                  Selected transcript text ({selectedTranscriptSelection.startIndex + 1}-{selectedTranscriptSelection.endIndex + 1})
                </div>
                <div className="text-xs text-slate-700 dark:text-slate-200 line-clamp-3">
                  {selectedTranscriptSelection.text}
                </div>
                <button
                  onClick={addClipFromTranscriptSelection}
                  disabled={isPrecisionAligning}
                  className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-primary text-white disabled:opacity-50"
                >
                  {isPrecisionAligning ? 'Aligning Selection...' : 'Load Selection Into Trim Tools'}
                </button>
              </div>
            )}
          </div>

          <div
            ref={transcriptPaneRef}
            onMouseUp={handleTranscriptMouseUp}
            onScroll={() => {
              if (transcriptAutoScrollRef.current) return;
              if (transcriptQueryNormalized) return;
              if (autoFollowTranscript) setAutoFollowTranscript(false);
            }}
            className="flex-1 overflow-y-auto p-4"
          >
            {transcriptPaneContent}
          </div>
        </aside>
      </div>

      {status && (
        <div className={`rounded-xl border px-3 py-2 text-xs ${statusToneClass}`}>
          {status}
        </div>
      )}
    </section>
  );
};

export default ManualClipLab;
