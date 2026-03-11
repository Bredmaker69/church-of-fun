import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { renderLocalClipFiles } from '../lib/localClipper';
import churchOfFunLogo from '../assets/church-of-fun-full-logo.PNG';
import {
  probeLocalMediaAsset,
  extractLocalAudioWaveform,
  estimateScratchAudioSync,
  buildManualMulticamTimeline,
  createDefaultMulticamShotPresets,
} from '../lib/multicamProject';
import {
  buildReflowedCaptionCues,
  normalizeCaptionEditorText,
  normalizeCaptionEditorCues,
  createDefaultPhraseSpans,
  normalizePhraseSpans,
  buildPhraseCuesFromWordCues,
} from '../lib/captionEditor';

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

const formatBytesLabel = (bytesRaw) => {
  const bytes = Number(bytesRaw);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const precision = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
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

const mergeAlignedWordCuesWithFallback = ({
  alignedCues,
  fallbackCues,
  rangeStartSeconds,
  rangeEndSeconds,
  gapToleranceSeconds = 0.08,
  maxCues = 800,
}) => {
  const safeRangeStart = Number(rangeStartSeconds);
  const safeRangeEnd = Number(rangeEndSeconds);
  if (!Number.isFinite(safeRangeStart) || !Number.isFinite(safeRangeEnd) || safeRangeEnd <= safeRangeStart) {
    return [];
  }

  const normalizeCue = (cue, index, prefix) => {
    const text = cleanTitleText(cue?.text || '');
    const startSeconds = Number(cue?.startSeconds);
    const endSeconds = Number(cue?.endSeconds);
    if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }
    if (endSeconds <= safeRangeStart || startSeconds >= safeRangeEnd) return null;
    const clippedStart = Math.max(safeRangeStart, startSeconds);
    const clippedEnd = Math.min(safeRangeEnd, endSeconds);
    if (!(clippedEnd > clippedStart)) return null;
    return {
      id: String(cue?.id || `${prefix}-${index + 1}`),
      text,
      startSeconds: Number(clippedStart.toFixed(3)),
      endSeconds: Number(clippedEnd.toFixed(3)),
    };
  };

  const sortByTime = (left, right) => {
    if (left.startSeconds !== right.startSeconds) return left.startSeconds - right.startSeconds;
    if (left.endSeconds !== right.endSeconds) return left.endSeconds - right.endSeconds;
    return left.text.localeCompare(right.text);
  };

  const normalizedAligned = (Array.isArray(alignedCues) ? alignedCues : [])
    .map((cue, index) => normalizeCue(cue, index, 'aligned'))
    .filter(Boolean)
    .sort(sortByTime);
  const normalizedFallback = (Array.isArray(fallbackCues) ? fallbackCues : [])
    .map((cue, index) => normalizeCue(cue, index, 'fallback'))
    .filter(Boolean)
    .sort(sortByTime);

  if (normalizedAligned.length === 0) {
    return normalizedFallback.slice(0, maxCues);
  }

  const merged = [...normalizedAligned];
  const addFallbackRange = (windowStart, windowEnd) => {
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) return;
    normalizedFallback.forEach((cue) => {
      if (cue.endSeconds <= windowStart || cue.startSeconds >= windowEnd) return;
      merged.push(cue);
    });
  };

  const firstAligned = normalizedAligned[0];
  const lastAligned = normalizedAligned[normalizedAligned.length - 1];
  if (firstAligned.startSeconds - safeRangeStart > gapToleranceSeconds) {
    addFallbackRange(safeRangeStart, firstAligned.startSeconds);
  }

  for (let index = 0; index < normalizedAligned.length - 1; index += 1) {
    const left = normalizedAligned[index];
    const right = normalizedAligned[index + 1];
    const gap = right.startSeconds - left.endSeconds;
    if (gap > Math.max(gapToleranceSeconds * 2, 0.18)) {
      addFallbackRange(left.endSeconds, right.startSeconds);
    }
  }

  if (safeRangeEnd - lastAligned.endSeconds > gapToleranceSeconds) {
    addFallbackRange(lastAligned.endSeconds, safeRangeEnd);
  }

  const dedupeMap = new Map();
  merged
    .sort(sortByTime)
    .forEach((cue) => {
      const key = `${cue.text.toLowerCase()}|${Math.round(cue.startSeconds * 1000)}|${Math.round(cue.endSeconds * 1000)}`;
      if (!dedupeMap.has(key)) {
        dedupeMap.set(key, cue);
      }
    });

  return Array.from(dedupeMap.values())
    .sort(sortByTime)
    .slice(0, maxCues);
};

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

const buildFocusedTrimWindow = ({
  clipStartSeconds,
  clipEndSeconds,
  mediaDurationSeconds,
  edgeRatio: requestedEdgeRatio = 0.2,
}) => {
  const start = Number(clipStartSeconds);
  const end = Number(clipEndSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const clipLength = Math.max(1, end - start);
  const edgeRatio = clampNumber(Number(requestedEdgeRatio) || 0.2, 0.05, 0.35);
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

const extractRenderedClipToken = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const parsed = new URL(text);
    return String(parsed.searchParams.get('token') || '').trim();
  } catch {
    // Not a URL.
  }

  return /^[0-9a-fA-F-]{36}$/.test(text) ? text : '';
};

const createStudioRegionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `studio-region-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const getCallableErrorMessage = (error) => {
  const detailText = (
    error?.details && typeof error.details === 'string'
      ? error.details.trim()
      : ''
  );
  const messageText = String(error?.message || '').trim();
  const jsonText = (!detailText && !messageText && error && typeof error === 'object')
    ? (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return '';
      }
    })()
    : '';
  if (detailText && messageText && !messageText.includes(detailText)) {
    return `${messageText} ${detailText}`.trim();
  }
  return detailText || messageText || jsonText || 'Unknown error';
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
  onRequestFocusEditWorkspace,
  onCreateMulticamProject,
}) => {
  const videoRef = useRef(null);
  const youtubePlayerMountRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubeTimePollRef = useRef(null);
  const playheadAnimationRef = useRef(null);
  const multicamSyncAudioRefs = useRef({});
  const multicamSyncAudioContextRef = useRef(null);
  const multicamSyncAudioNodesRef = useRef({});
  const multicamProgramClockRef = useRef(null);
  const multicamProgramAnimationRef = useRef(null);
  const playheadLastCommitRef = useRef(0);
  const previewOverlayRef = useRef(null);
  const focusEditSurfaceRef = useRef(null);
  const trimTimelineRef = useRef(null);
  const transcriptAvailabilityRequestRef = useRef(0);
  const autoCaptionLoadKeyRef = useRef('');
  const transcriptPaneRef = useRef(null);
  const transcriptRowRefs = useRef({});
  const transcriptAutoScrollRef = useRef(false);
  const timelineScrubPointerIdRef = useRef(null);
  const timelineScrubCaptureElementRef = useRef(null);
  const timelineScrubSessionRef = useRef(null);
  const qaWordDragStateRef = useRef(null);
  const qaWordDragCleanupRef = useRef(null);
  const previewResizePointerIdRef = useRef(null);
  const previewResizeCaptureElementRef = useRef(null);
  const previewResizeSessionRef = useRef(null);
  const scrubAudioPauseTimeoutRef = useRef(null);
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
  const [clipEditRegions, setClipEditRegions] = useState([]);
  const [selectedEditRegionId, setSelectedEditRegionId] = useState('');
  const [isTimelineScrubbing, setIsTimelineScrubbing] = useState(false);
  const [previewMonitorHeight, setPreviewMonitorHeight] = useState(360);
  const [isAuditioningClip, setIsAuditioningClip] = useState(false);
  const [isLoopPlayback, setIsLoopPlayback] = useState(false);
  const [isTrimEditMode, setIsTrimEditMode] = useState(false);
  const [isFocusEditMode, setIsFocusEditMode] = useState(false);
  const [trimZoomLevel, setTrimZoomLevel] = useState(1);
  const [transcriptSegments, setTranscriptSegments] = useState([]);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [transcriptAvailability, setTranscriptAvailability] = useState(null);
  const [isCheckingTranscriptAvailability, setIsCheckingTranscriptAvailability] = useState(false);
  const [isTranscriptPaneCollapsed, setIsTranscriptPaneCollapsed] = useState(false);
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
  const [studioTranscriptEditDraft, setStudioTranscriptEditDraft] = useState('');
  const [studioTranscriptAppliedText, setStudioTranscriptAppliedText] = useState('');
  const [studioTranscriptEditedAt, setStudioTranscriptEditedAt] = useState('');
  const [studioQaWordCues, setStudioQaWordCues] = useState([]);
  const [studioPhraseSpans, setStudioPhraseSpans] = useState([]);
  const [precisionPreviewClip, setPrecisionPreviewClip] = useState(null);
  const [isGeneratingPrecisionPreview, setIsGeneratingPrecisionPreview] = useState(false);
  const [showDevStatus, setShowDevStatus] = useState(true);
  const [devStatusLines, setDevStatusLines] = useState([]);
  const [multicamPrep, setMulticamPrep] = useState(null);
  const [isPreparingMulticam, setIsPreparingMulticam] = useState(false);
  const [multicamMasterAudioAssetId, setMulticamMasterAudioAssetId] = useState('camera1');
  const [multicamManualOffsetSeconds, setMulticamManualOffsetSeconds] = useState(0);
  const [multicamPrepPhase, setMulticamPrepPhase] = useState('idle');
  const [multicamPreparedDraft, setMulticamPreparedDraft] = useState(null);
  const [isPreparingMulticamPackage, setIsPreparingMulticamPackage] = useState(false);
  const [isSendingMulticamToSanctuary, setIsSendingMulticamToSanctuary] = useState(false);
  const [isMulticamSyncPlaying, setIsMulticamSyncPlaying] = useState(false);
  const [multicamListenMode, setMulticamListenMode] = useState('both');
  const [useMulticamStereoMixAsProjectAudio, setUseMulticamStereoMixAsProjectAudio] = useState(true);
  const [multicamCamera1Volume, setMulticamCamera1Volume] = useState(100);
  const [multicamCamera2Volume, setMulticamCamera2Volume] = useState(100);

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
  const renderTimelineEdits = useMemo(
    () => httpsCallable(functions, 'renderTimelineEdits'),
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
      : activeSource?.kind === 'multicam'
        ? 'multicam'
      : 'none';

  useEffect(() => {
    const nextText = normalizeCaptionEditorText(stagedClipDraft?.description || '');
    setStudioTranscriptEditDraft(nextText);
    setStudioTranscriptAppliedText('');
    setStudioTranscriptEditedAt('');
  }, [stagedClipDraft?.title, stagedClipDraft?.description, stagedClipDraft?.origin]);

  const sourceFile = sourceMode === 'file' ? activeSource?.payload : null;
  const sourceUrl = sourceMode === 'url' ? activeSource?.payload || '' : '';
  const multicamSource = sourceMode === 'multicam' ? activeSource?.payload || null : null;
  const multicamCameraFiles = useMemo(
    () => (Array.isArray(multicamSource?.cameraFiles) ? multicamSource.cameraFiles : []),
    [multicamSource]
  );

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

  const appendDevStatusLine = useCallback((label, value) => {
    const timestamp = new Date().toLocaleTimeString();
    const nextLine = `[${timestamp}] ${label}: ${String(value || '').trim()}`;
    setDevStatusLines((previous) => {
      if (previous[0] === nextLine) return previous;
      return [nextLine, ...previous].slice(0, 60);
    });
  }, []);

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
      if (playheadAnimationRef.current) {
        cancelAnimationFrame(playheadAnimationRef.current);
        playheadAnimationRef.current = null;
      }
      if (multicamProgramAnimationRef.current) {
        cancelAnimationFrame(multicamProgramAnimationRef.current);
        multicamProgramAnimationRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    youtubeVideoTitleRef.current = youtubeVideoTitle;
  }, [youtubeVideoTitle]);

  useEffect(() => {
    appendDevStatusLine(
      'flags',
      `checking=${isCheckingTranscriptAvailability ? 'yes' : 'no'} transcribing=${isTranscribing ? 'yes' : 'no'} mode=${transcriptLoadMode}`
    );
  }, [appendDevStatusLine, isCheckingTranscriptAvailability, isTranscribing, transcriptLoadMode]);

  useEffect(() => {
    if (!transcriptAvailability) return;
    appendDevStatusLine(
      'caption-check',
      `${transcriptAvailability.status || 'ready'} | ${transcriptAvailability.message || ''}`
    );
  }, [appendDevStatusLine, transcriptAvailability]);

  useEffect(() => {
    if (!status) return;
    appendDevStatusLine('status', status);
  }, [appendDevStatusLine, status]);

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
    setClipEditRegions([]);
    setSelectedEditRegionId('');
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

    if (sourceMode === 'multicam') {
      setStatus('Two-camera source ready. Preparing multicam conform workspace...');
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

  useEffect(() => {
    let cancelled = false;

    if (sourceMode !== 'multicam') {
      setMulticamPrep(null);
      setMulticamManualOffsetSeconds(0);
      setMulticamMasterAudioAssetId('camera1');
      setMulticamPrepPhase('idle');
      setMulticamPreparedDraft(null);
      setIsPreparingMulticamPackage(false);
      setIsPreparingMulticam(false);
      return () => {
        cancelled = true;
      };
    }

    if (multicamCameraFiles.length < 2) {
      setMulticamPrep(null);
      setMulticamPrepPhase('idle');
      setMulticamPreparedDraft(null);
      setIsPreparingMulticamPackage(false);
      setStatus('Select Camera A and Camera B to begin multicam prep.');
      return () => {
        cancelled = true;
      };
    }

    const [camera1File, camera2File] = multicamCameraFiles;
    setIsPreparingMulticam(true);
    setMulticamPrepPhase('analyzing');
    setMulticamPreparedDraft(null);
    setIsPreparingMulticamPackage(false);
    setStatus('Preparing Camera A and Camera B metadata, waveforms, and sync...');

    void (async () => {
      try {
        const [asset1, asset2] = await Promise.all([
          probeLocalMediaAsset(camera1File, 'camera1', 'Camera A'),
          probeLocalMediaAsset(camera2File, 'camera2', 'Camera B'),
        ]);
        const waveformResults = await Promise.allSettled([
          extractLocalAudioWaveform(camera1File),
          extractLocalAudioWaveform(camera2File),
        ]);

        if (cancelled) return;

        const waveform1 = waveformResults[0].status === 'fulfilled' ? waveformResults[0].value : null;
        const waveform2 = waveformResults[1].status === 'fulfilled' ? waveformResults[1].value : null;
        const waveformFailureMessages = waveformResults
          .map((result) => (result.status === 'rejected' ? getCallableErrorMessage(result.reason) : ''))
          .filter(Boolean);

        const hasWaveformSync = Boolean(waveform1?.bins?.length) && Boolean(waveform2?.bins?.length);

        const syncEstimate = hasWaveformSync
          ? estimateScratchAudioSync({
            waveformA: waveform1,
            waveformB: waveform2,
          })
          : {
            method: 'manual-offset-only',
            offsetSeconds: 0,
            confidence: 0,
          };
        const syncedDurationSeconds = Math.max(
          Number(asset1.durationSeconds || 0),
          Number(asset2.durationSeconds || 0) + Number(syncEstimate.offsetSeconds || 0)
        );
        const timelineSegments = buildManualMulticamTimeline({
          durationSeconds: syncedDurationSeconds,
          initialShotId: '1A',
        });

        const previewUrl1 = URL.createObjectURL(camera1File);
        const previewUrl2 = URL.createObjectURL(camera2File);

        setMulticamPrep((previous) => {
          if (previous?.mediaAssets) {
            previous.mediaAssets.forEach((asset) => {
              const existingPreviewUrl = String(asset?.previewUrl || '');
              if (existingPreviewUrl.startsWith('blob:')) URL.revokeObjectURL(existingPreviewUrl);
            });
          }

          return {
            projectId: String(multicamSource?.projectId || ''),
            projectName: String(multicamSource?.projectName || 'Podcast Session'),
            mediaAssets: [
              { ...asset1, previewUrl: previewUrl1, file: camera1File, clipId: `multicam-${multicamSource?.projectId || 'draft'}-camera1` },
              { ...asset2, previewUrl: previewUrl2, file: camera2File, clipId: `multicam-${multicamSource?.projectId || 'draft'}-camera2` },
            ],
            waveforms: {
              camera1: waveform1,
              camera2: waveform2,
            },
            syncMap: {
              method: syncEstimate.method,
              offsetSeconds: Number(syncEstimate.offsetSeconds || 0),
              confidence: Number(syncEstimate.confidence || 0),
              cameraOffsets: {
                camera1: 0,
                camera2: Number(syncEstimate.offsetSeconds || 0),
              },
            },
            masterAudioAssetId: 'camera1',
            timelineSegments,
            shotPresets: createDefaultMulticamShotPresets(),
            prepWarnings: waveformFailureMessages,
          };
        });
        setMulticamManualOffsetSeconds(Number(syncEstimate.offsetSeconds || 0));
        setMulticamMasterAudioAssetId('camera1');
        setMulticamPrepPhase('ready');
        if (hasWaveformSync) {
          setStatus('Camera A and Camera B loaded. Review the waveform slip sync, then confirm before preparing Sanctuary.');
        } else {
          setStatus(`Camera A and Camera B loaded, but waveform sync is unavailable. Use manual offset sync before preparing Sanctuary. ${waveformFailureMessages.join(' | ')}`.trim());
        }
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to prepare multicam source:', error);
        setMulticamPrep(null);
        setMulticamPrepPhase('idle');
        setMulticamPreparedDraft(null);
        setStatus(`Unable to prepare multicam source. ${getCallableErrorMessage(error)}`);
      } finally {
        if (!cancelled) {
          setIsPreparingMulticam(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [multicamCameraFiles, multicamSource?.projectId, multicamSource?.projectName, sourceMode]);

  useEffect(() => {
    return () => {
      if (!multicamPrep?.mediaAssets) return;
      multicamPrep.mediaAssets.forEach((asset) => {
        const previewUrl = String(asset?.previewUrl || '');
        if (previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(previewUrl);
        }
      });
    };
  }, [multicamPrep]);

  const effectiveMulticamSyncMap = useMemo(() => {
    if (!multicamPrep?.syncMap) return null;
    return {
      ...multicamPrep.syncMap,
      offsetSeconds: Number(multicamManualOffsetSeconds || 0),
      cameraOffsets: {
        camera1: 0,
        camera2: Number(multicamManualOffsetSeconds || 0),
      },
    };
  }, [multicamManualOffsetSeconds, multicamPrep]);

  const effectiveMulticamTimelineSegments = useMemo(() => {
    if (!multicamPrep?.mediaAssets?.length) {
      return [];
    }

    const assetA = multicamPrep.mediaAssets.find((asset) => asset.id === 'camera1') || multicamPrep.mediaAssets[0];
    const assetB = multicamPrep.mediaAssets.find((asset) => asset.id === 'camera2') || multicamPrep.mediaAssets[1];
    const syncedDurationSeconds = Math.max(
      Number(assetA?.durationSeconds || 0),
      Number(assetB?.durationSeconds || 0) + Number(multicamManualOffsetSeconds || 0)
    );

    return buildManualMulticamTimeline({
      durationSeconds: syncedDurationSeconds,
      initialShotId: '1A',
    });
  }, [multicamManualOffsetSeconds, multicamPrep]);

  const buildMulticamWaveformPoints = useCallback((waveform, offsetSeconds = 0, totalWindowSeconds = 1) => {
    const bins = Array.isArray(waveform?.bins) ? waveform.bins : [];
    const binDuration = Number(waveform?.binDurationSeconds || 0);
    if (bins.length < 2 || !binDuration || totalWindowSeconds <= 0) return [];

    const rawPoints = [];
    bins.forEach((value, index) => {
      const xSeconds = offsetSeconds + (index * binDuration);
      const x = (xSeconds / totalWindowSeconds) * 100;
      if (x < 0 || x > 100) return;
      rawPoints.push({
        xPercent: Number(x.toFixed(3)),
        amplitude: clampNumber(Number(value || 0), 0, 1),
      });
    });

    if (rawPoints.length <= 420) return rawPoints;

    const compactPoints = [];
    const groupSize = Math.ceil(rawPoints.length / 420);
    for (let cursor = 0; cursor < rawPoints.length; cursor += groupSize) {
      const chunk = rawPoints.slice(cursor, cursor + groupSize);
      const xPercent = chunk.reduce((sum, point) => sum + point.xPercent, 0) / chunk.length;
      const amplitude = chunk.reduce((peak, point) => Math.max(peak, point.amplitude), 0);
      compactPoints.push({
        xPercent: Number(xPercent.toFixed(3)),
        amplitude: Number(amplitude.toFixed(6)),
      });
    }

    return compactPoints;
  }, []);

  const multicamPreviewWindowSeconds = useMemo(() => {
    if (!multicamPrep?.mediaAssets?.length) return 1;
    const asset1 = multicamPrep.mediaAssets.find((asset) => asset.id === 'camera1') || multicamPrep.mediaAssets[0];
    const asset2 = multicamPrep.mediaAssets.find((asset) => asset.id === 'camera2') || multicamPrep.mediaAssets[1];
    return Math.max(
      Number(asset1?.durationSeconds || 0),
      Number(asset2?.durationSeconds || 0) + Number(multicamManualOffsetSeconds || 0),
      1
    );
  }, [multicamManualOffsetSeconds, multicamPrep]);

  const multicamWaveformPointsCamera1 = useMemo(() => (
    buildMulticamWaveformPoints(multicamPrep?.waveforms?.camera1, 0, multicamPreviewWindowSeconds)
  ), [buildMulticamWaveformPoints, multicamPrep, multicamPreviewWindowSeconds]);

  const multicamWaveformPointsCamera2 = useMemo(() => (
    buildMulticamWaveformPoints(multicamPrep?.waveforms?.camera2, Number(multicamManualOffsetSeconds || 0), multicamPreviewWindowSeconds)
  ), [buildMulticamWaveformPoints, multicamManualOffsetSeconds, multicamPrep, multicamPreviewWindowSeconds]);

  const buildMirroredWaveformFillPath = useCallback((points, amplitudeScale = 42) => {
    if (!Array.isArray(points) || points.length < 2) return '';
    const topPoints = points.map((point) => (
      `${point.xPercent.toFixed(3)},${(50 - (point.amplitude * amplitudeScale)).toFixed(3)}`
    ));
    const bottomPoints = [...points]
      .reverse()
      .map((point) => `${point.xPercent.toFixed(3)},${(50 + (point.amplitude * amplitudeScale)).toFixed(3)}`);
    return `M ${topPoints.join(' L ')} L ${bottomPoints.join(' L ')} Z`;
  }, []);

  const buildMirroredWaveformStrokePoints = useCallback((points, direction = 'top', amplitudeScale = 42) => {
    if (!Array.isArray(points) || points.length < 2) return '';
    return points
      .map((point) => {
        const y = direction === 'bottom'
          ? 50 + (point.amplitude * amplitudeScale)
          : 50 - (point.amplitude * amplitudeScale);
        return `${point.xPercent.toFixed(3)},${y.toFixed(3)}`;
      })
      .join(' ');
  }, []);

  const multicamWaveformFillPathCamera1 = useMemo(() => (
    buildMirroredWaveformFillPath(multicamWaveformPointsCamera1)
  ), [buildMirroredWaveformFillPath, multicamWaveformPointsCamera1]);

  const multicamWaveformTopStrokeCamera1 = useMemo(() => (
    buildMirroredWaveformStrokePoints(multicamWaveformPointsCamera1, 'top')
  ), [buildMirroredWaveformStrokePoints, multicamWaveformPointsCamera1]);

  const multicamWaveformBottomStrokeCamera1 = useMemo(() => (
    buildMirroredWaveformStrokePoints(multicamWaveformPointsCamera1, 'bottom')
  ), [buildMirroredWaveformStrokePoints, multicamWaveformPointsCamera1]);

  const multicamWaveformFillPathCamera2 = useMemo(() => (
    buildMirroredWaveformFillPath(multicamWaveformPointsCamera2)
  ), [buildMirroredWaveformFillPath, multicamWaveformPointsCamera2]);

  const multicamWaveformTopStrokeCamera2 = useMemo(() => (
    buildMirroredWaveformStrokePoints(multicamWaveformPointsCamera2, 'top')
  ), [buildMirroredWaveformStrokePoints, multicamWaveformPointsCamera2]);

  const multicamWaveformBottomStrokeCamera2 = useMemo(() => (
    buildMirroredWaveformStrokePoints(multicamWaveformPointsCamera2, 'bottom')
  ), [buildMirroredWaveformStrokePoints, multicamWaveformPointsCamera2]);

  const getMulticamSyncClockAssetId = useCallback(() => 'camera1', []);

  const ensureMulticamSyncAudioRouting = useCallback(async () => {
    if (sourceMode !== 'multicam') return null;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;

    let audioContext = multicamSyncAudioContextRef.current;
    if (!audioContext) {
      audioContext = new AudioContextCtor();
      multicamSyncAudioContextRef.current = audioContext;
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const mediaAssets = Array.isArray(multicamPrep?.mediaAssets) ? multicamPrep.mediaAssets : [];
    mediaAssets.forEach((asset) => {
      const assetId = String(asset?.id || '');
      const media = multicamSyncAudioRefs.current[assetId];
      if (!media) return;
      media.volume = 1;

      if (multicamSyncAudioNodesRef.current[assetId]) return;

      const sourceNode = audioContext.createMediaElementSource(media);
      const gainNode = audioContext.createGain();
      const delayNode = audioContext.createDelay(12.5);
      let panNode = null;

      if (typeof audioContext.createStereoPanner === 'function') {
        panNode = audioContext.createStereoPanner();
        sourceNode.connect(gainNode);
        gainNode.connect(delayNode);
        delayNode.connect(panNode);
        panNode.connect(audioContext.destination);
      } else {
        sourceNode.connect(gainNode);
        gainNode.connect(delayNode);
        delayNode.connect(audioContext.destination);
      }

      multicamSyncAudioNodesRef.current[assetId] = {
        sourceNode,
        gainNode,
        delayNode,
        panNode,
      };
    });

    return audioContext;
  }, [multicamPrep?.mediaAssets, sourceMode]);

  const pauseMulticamSyncPlayback = useCallback((statusMessage = '') => {
    if (multicamProgramAnimationRef.current) {
      cancelAnimationFrame(multicamProgramAnimationRef.current);
      multicamProgramAnimationRef.current = null;
    }
    multicamProgramClockRef.current = null;
    Object.values(multicamSyncAudioRefs.current).forEach((media) => {
      try {
        media?.pause?.();
      } catch {
        // no-op
      }
    });
    setIsMulticamSyncPlaying(false);
    if (statusMessage) setStatus(statusMessage);
  }, []);

  const applyMulticamListenMode = useCallback(() => {
    const applyTrack = (assetId, volumePercent, panValue, mutedByMode) => {
      const media = multicamSyncAudioRefs.current[assetId];
      if (media) {
        media.volume = 1;
      }
      const nodes = multicamSyncAudioNodesRef.current[assetId];
      if (!nodes?.gainNode) return;
      nodes.gainNode.gain.value = mutedByMode ? 0 : clampNumber(Number(volumePercent || 0) / 100, 0, 1);
      if (nodes.delayNode) {
        const nextDelaySeconds = assetId === 'camera1'
          ? Math.max(0, -Number(multicamManualOffsetSeconds || 0))
          : Math.max(0, Number(multicamManualOffsetSeconds || 0));
        nodes.delayNode.delayTime.value = clampNumber(nextDelaySeconds, 0, 12);
      }
      if (nodes.panNode) {
        nodes.panNode.pan.value = panValue;
      }
    };

    applyTrack('camera1', multicamCamera1Volume, -1, multicamListenMode === 'camera2');
    applyTrack('camera2', multicamCamera2Volume, 1, multicamListenMode === 'camera1');
  }, [multicamCamera1Volume, multicamCamera2Volume, multicamListenMode, multicamManualOffsetSeconds]);

  const syncMulticamProgramFrame = useCallback(() => {
    const clock = multicamProgramClockRef.current;
    if (!clock) return;

    const clockAssetId = getMulticamSyncClockAssetId();
    const clockMedia = multicamSyncAudioRefs.current[clockAssetId];
    const fallbackElapsedSeconds = (performance.now() - clock.startedAtMs) / 1000;
    const fallbackProgramSeconds = Math.max(0, Math.min(multicamPreviewWindowSeconds, clock.baseProgramSeconds + fallbackElapsedSeconds));
    const programSeconds = clockMedia && Number.isFinite(Number(clockMedia.currentTime))
      ? Math.max(0, Math.min(
          multicamPreviewWindowSeconds,
          Number(clockMedia.currentTime || 0)
        ))
      : fallbackProgramSeconds;
    setCurrentTime(programSeconds);

    const mediaAssets = Array.isArray(multicamPrep?.mediaAssets) ? multicamPrep.mediaAssets : [];
    mediaAssets.forEach((asset) => {
      const media = multicamSyncAudioRefs.current[String(asset?.id || '')];
      if (!media) return;

      const desiredSourceTime = Number(programSeconds || 0);
      const assetDuration = Number(asset?.durationSeconds || 0);
      const shouldPlay = desiredSourceTime >= 0 && (!assetDuration || desiredSourceTime < assetDuration);

      if (!shouldPlay) {
        if (!media.paused) media.pause();
        if (desiredSourceTime < 0) {
          if (Math.abs(Number(media.currentTime || 0)) > 0.04) {
            media.currentTime = 0;
          }
        } else if (assetDuration > 0 && Math.abs(Number(media.currentTime || 0) - assetDuration) > 0.04) {
          media.currentTime = assetDuration;
        }
        return;
      }

      const clampedSourceTime = assetDuration > 0
        ? Math.max(0, Math.min(assetDuration, desiredSourceTime))
        : Math.max(0, desiredSourceTime);
      const driftTolerance = asset.id === clockAssetId ? 0.35 : 0.18;
      if (Math.abs(Number(media.currentTime || 0) - clampedSourceTime) > driftTolerance) {
        media.currentTime = clampedSourceTime;
      }
      if (media.paused) {
        media.play().catch(() => {});
      }
    });

    if (programSeconds >= multicamPreviewWindowSeconds - 0.02) {
      pauseMulticamSyncPlayback('Sync-by-ear playback stopped at the end of the multicam window.');
      return;
    }

    multicamProgramAnimationRef.current = requestAnimationFrame(syncMulticamProgramFrame);
  }, [
    getMulticamSyncClockAssetId,
    multicamPrep?.mediaAssets,
    multicamPreviewWindowSeconds,
    pauseMulticamSyncPlayback,
  ]);

  const playMulticamSyncPlayback = useCallback(async (requestedProgramSeconds = null) => {
    if (!multicamPrep?.mediaAssets?.length) return;
    const startProgramSeconds = Number.isFinite(Number(requestedProgramSeconds))
      ? clampNumber(Number(requestedProgramSeconds), 0, multicamPreviewWindowSeconds)
      : clampNumber(Number(currentTime || 0), 0, multicamPreviewWindowSeconds);

    await ensureMulticamSyncAudioRouting();
    applyMulticamListenMode();
    pauseMulticamSyncPlayback();
    const mediaAssets = Array.isArray(multicamPrep?.mediaAssets) ? multicamPrep.mediaAssets : [];
    mediaAssets.forEach((asset) => {
      const media = multicamSyncAudioRefs.current[String(asset?.id || '')];
      if (!media) return;
      const desiredSourceTime = Number(startProgramSeconds || 0);
      const assetDuration = Number(asset?.durationSeconds || 0);
      const shouldPlay = desiredSourceTime >= 0 && (!assetDuration || desiredSourceTime < assetDuration);
      const clampedSourceTime = assetDuration > 0
        ? Math.max(0, Math.min(assetDuration, desiredSourceTime))
        : Math.max(0, desiredSourceTime);
      try {
        media.currentTime = clampedSourceTime;
      } catch {
        // no-op
      }
      if (shouldPlay) {
        media.play().catch(() => {});
      }
    });
    multicamProgramClockRef.current = {
      startedAtMs: performance.now(),
      baseProgramSeconds: startProgramSeconds,
    };
    setCurrentTime(startProgramSeconds);
    setIsMulticamSyncPlaying(true);
    multicamProgramAnimationRef.current = requestAnimationFrame(syncMulticamProgramFrame);
  }, [
    applyMulticamListenMode,
    currentTime,
    ensureMulticamSyncAudioRouting,
    multicamPrep?.mediaAssets,
    multicamPreviewWindowSeconds,
    pauseMulticamSyncPlayback,
    syncMulticamProgramFrame,
  ]);

  const invalidateMulticamPreparedState = useCallback((nextStatus = '') => {
    setMulticamPreparedDraft(null);
    setIsPreparingMulticamPackage(false);
    setMulticamPrepPhase((previous) => {
      if (previous === 'confirmed' || previous === 'packaged') {
        return 'ready';
      }
      return previous;
    });
    if (nextStatus) {
      setStatus(nextStatus);
    }
  }, []);

  const handleSetMulticamManualOffsetSeconds = useCallback((nextOffsetSeconds) => {
    invalidateMulticamPreparedState('Multicam sync changed. Review the waveform slip and confirm sync again before opening Sanctuary.');
    setMulticamManualOffsetSeconds(Number(nextOffsetSeconds || 0));
  }, [invalidateMulticamPreparedState]);

  const handleSetMulticamMasterAudioAssetId = useCallback((assetId) => {
    invalidateMulticamPreparedState('Master audio changed. Confirm sync again so the Sanctuary package reflects the correct program audio.');
    setMulticamMasterAudioAssetId(String(assetId || 'camera1'));
  }, [invalidateMulticamPreparedState]);

  const handleConfirmMulticamSync = useCallback(() => {
    if (!multicamPrep) return;
    setMulticamPreparedDraft(null);
    setMulticamPrepPhase('confirmed');
    setStatus(
      `Sync confirmed. Camera B offset locked at ${formatTimestampPrecise(multicamManualOffsetSeconds, 2)}s. Prepare the Sanctuary package when ready.`
    );
  }, [multicamManualOffsetSeconds, multicamPrep]);

  const handlePrepareMulticamPackage = useCallback(async () => {
    if (!multicamPrep) return;
    setIsPreparingMulticamPackage(true);
    setStatus('Preparing Sanctuary multicam package from the confirmed sync map...');

    try {
      const draft = {
        projectId: multicamPrep.projectId,
        projectName: multicamPrep.projectName,
        mediaAssets: multicamPrep.mediaAssets,
        syncMap: effectiveMulticamSyncMap,
        masterAudioAssetId: multicamMasterAudioAssetId,
        audioMixMode: useMulticamStereoMixAsProjectAudio ? 'stereo_mix' : 'single_master',
        audioMixSettings: {
          camera1Volume: Number(multicamCamera1Volume || 100),
          camera2Volume: Number(multicamCamera2Volume || 100),
          camera1Pan: -1,
          camera2Pan: 1,
        },
        timelineSegments: effectiveMulticamTimelineSegments,
        shotPresets: Array.isArray(multicamPrep.shotPresets) ? multicamPrep.shotPresets : createDefaultMulticamShotPresets(),
        speakerProfiles: [],
        speakerCameraPreferences: {},
      };
      setMulticamPreparedDraft(draft);
      setMulticamPrepPhase('packaged');
      setStatus('Sanctuary package ready. Open Sanctuary to continue with stacked multicam editing.');
    } catch (error) {
      console.error('Failed to prepare multicam Sanctuary package:', error);
      setMulticamPreparedDraft(null);
      setMulticamPrepPhase('confirmed');
      setStatus(`Unable to prepare Sanctuary package. ${String(error?.message || 'Unknown error')}`);
    } finally {
      setIsPreparingMulticamPackage(false);
    }
  }, [
    effectiveMulticamSyncMap,
    effectiveMulticamTimelineSegments,
    multicamCamera1Volume,
    multicamCamera2Volume,
    multicamMasterAudioAssetId,
    multicamPrep,
    useMulticamStereoMixAsProjectAudio,
  ]);

  const handleSendMulticamToSanctuary = useCallback(async () => {
    if (!multicamPreparedDraft || !onCreateMulticamProject) return;
    setIsSendingMulticamToSanctuary(true);
    try {
      pauseMulticamSyncPlayback();
      await onCreateMulticamProject(multicamPreparedDraft);
      setStatus('Multicam project sent to Sanctuary.');
    } catch (error) {
      console.error('Failed to send multicam project to Sanctuary:', error);
      setStatus(`Unable to open multicam project in Sanctuary. ${String(error?.message || 'Unknown error')}`);
    } finally {
      setIsSendingMulticamToSanctuary(false);
    }
  }, [
    multicamPreparedDraft,
    onCreateMulticamProject,
    pauseMulticamSyncPlayback,
  ]);

  useEffect(() => {
    applyMulticamListenMode();
  }, [applyMulticamListenMode]);

  useEffect(() => {
    if (sourceMode === 'multicam') return undefined;
    const audioContext = multicamSyncAudioContextRef.current;
    multicamSyncAudioContextRef.current = null;
    multicamSyncAudioNodesRef.current = {};
    if (audioContext && typeof audioContext.close === 'function') {
      audioContext.close().catch(() => {});
    }
    return undefined;
  }, [sourceMode]);

  useEffect(() => {
    if (sourceMode !== 'multicam') {
      pauseMulticamSyncPlayback();
      return;
    }

    const onKeyDown = (event) => {
      const targetTag = String(event.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(targetTag)) return;
      if (event.code !== 'Space') return;
      event.preventDefault();
      if (isMulticamSyncPlaying) {
        pauseMulticamSyncPlayback('Sync-by-ear playback paused.');
      } else {
        void playMulticamSyncPlayback();
        setStatus('Sync-by-ear playback started. Adjust Camera B offset until both voices line up.');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMulticamSyncPlaying, pauseMulticamSyncPlayback, playMulticamSyncPlayback, sourceMode]);

  async function renderClipFromRange({
    startTimestamp,
    endTimestamp,
    title,
    description,
    selectedText = '',
    selectedFragments = [],
  }) {
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
    const selectionFragmentRows = (Array.isArray(selectedFragments) ? selectedFragments : [])
      .map((fragment) => {
        const text = cleanTitleText(fragment?.text || '');
        const startSeconds = Number(fragment?.startSeconds);
        const endSeconds = Number(fragment?.endSeconds);
        if (!text || !isFiniteNumber(startSeconds) || !isFiniteNumber(endSeconds) || endSeconds <= startSeconds) {
          return null;
        }
        return {
          text,
          startSeconds,
          endSeconds,
        };
      })
      .filter(Boolean);

    const collectTranscriptRowsForRange = (rangeStart, rangeEnd) => {
      const rowSource = selectionFragmentRows.length > 0
        ? selectionFragmentRows
        : transcriptSegments
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
          });
      return rowSource
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
    const transcriptWordFallbackCues = overlappingRows
      .flatMap((row, rowIndex) => {
        if (!row.text) return [];
        const sourceStart = Math.max(finalStartSeconds, row.startSeconds);
        const sourceEnd = Math.min(finalEndSeconds, row.endSeconds);
        if (!isFiniteNumber(sourceStart) || !isFiniteNumber(sourceEnd) || sourceEnd <= sourceStart) return [];

        const words = tokenizeCaptionWords(row.text);
        if (words.length === 0) return [];
        const slotDuration = Math.max(0.02, (sourceEnd - sourceStart) / words.length);

        return words.map((word, wordIndex) => {
          const wordSourceStart = sourceStart + slotDuration * wordIndex;
          const wordSourceEnd = wordIndex === words.length - 1
            ? sourceEnd
            : sourceStart + slotDuration * (wordIndex + 1);
          const cueStart = Math.max(0, wordSourceStart - finalStartSeconds);
          const cueEnd = Math.min(clipDurationSeconds, wordSourceEnd - finalStartSeconds);
          if (!isFiniteNumber(cueStart) || !isFiniteNumber(cueEnd) || cueEnd <= cueStart) return null;

          return {
            id: `fallback-word-${rowIndex + 1}-${wordIndex + 1}`,
            text: word,
            startSeconds: Number(cueStart.toFixed(3)),
            endSeconds: Number(cueEnd.toFixed(3)),
            sourceStartSeconds: Number(wordSourceStart.toFixed(3)),
            sourceEndSeconds: Number(wordSourceEnd.toFixed(3)),
          };
        }).filter(Boolean);
      });

    let captionCues = mergeAlignedWordCuesWithFallback({
      alignedCues: wordLevelCaptionCues,
      fallbackCues: transcriptWordFallbackCues,
      rangeStartSeconds: 0,
      rangeEndSeconds: clipDurationSeconds,
      gapToleranceSeconds: 0.08,
      maxCues: 1000,
    });

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

    const originalPhraseCues = buildPhraseCuesForRange(
      buildPhraseCuesFromWordCues(sourceClipPreviewWordCues, createDefaultPhraseSpans(sourceClipPreviewWordCues, normalizedCaptionWordsPerChunk)),
      finalStartSeconds,
      finalEndSeconds,
      'source-phrase'
    );
    const editedPhraseCues = buildPhraseCuesForRange(
      qaPhraseCuesSourceWindow,
      finalStartSeconds,
      finalEndSeconds,
      'edited-phrase'
    );
    const activeRenderCaptionCues = editedPhraseCues.length > 0 ? editedPhraseCues : originalPhraseCues;
    const activeTranscriptText = hasStudioTranscriptEdit
      ? studioTranscriptAppliedText
      : (normalizedSelectedText || transcriptSourceText);

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
    const transcriptSnippet = (activeTranscriptText || cleanTitleText(description || ''))
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
      transcriptOriginalText: normalizedSelectedText || transcriptSourceText,
      transcriptEditedText: hasStudioTranscriptEdit ? studioTranscriptAppliedText : '',
      transcriptEditedAt: hasStudioCaptionQaEdit ? (studioTranscriptEditedAt || new Date().toISOString()) : '',
      transcriptSelectedText: normalizedSelectedText,
      transcriptProvider,
      transcriptLanguage,
      selectionStartSeconds: Number(finalStartSeconds.toFixed(2)),
      selectionEndSeconds: Number(finalEndSeconds.toFixed(2)),
      captionCues: activeRenderCaptionCues,
      captionCuesOriginal: originalPhraseCues,
      captionCuesEdited: hasStudioCaptionQaEdit ? editedPhraseCues : [],
      captionTextOverride: '',
      captionEditMode: hasStudioCaptionQaEdit
        ? (hasStudioTranscriptEdit ? 'text-edit' : 'cue-edit')
        : 'source',
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
          transcriptOriginalText: segment.transcriptOriginalText,
          transcriptEditedText: segment.transcriptEditedText,
          transcriptEditedAt: segment.transcriptEditedAt,
          transcriptSelectedText: segment.transcriptSelectedText,
          transcriptProvider: segment.transcriptProvider,
          transcriptLanguage: segment.transcriptLanguage,
          selectionStartSeconds: segment.selectionStartSeconds,
          selectionEndSeconds: segment.selectionEndSeconds,
          captionCues: segment.captionCues,
          captionCuesOriginal: segment.captionCuesOriginal,
          captionCuesEdited: segment.captionCuesEdited,
          captionTextOverride: segment.captionTextOverride,
          captionEditMode: segment.captionEditMode,
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
        transcriptOriginalText: segment.transcriptOriginalText,
        transcriptEditedText: segment.transcriptEditedText,
        transcriptEditedAt: segment.transcriptEditedAt,
        transcriptSelectedText: segment.transcriptSelectedText,
        transcriptProvider: segment.transcriptProvider,
        transcriptLanguage: segment.transcriptLanguage,
        selectionStartSeconds: segment.selectionStartSeconds,
        selectionEndSeconds: segment.selectionEndSeconds,
        captionCues: segment.captionCues,
        captionCuesOriginal: segment.captionCuesOriginal,
        captionCuesEdited: segment.captionCuesEdited,
        captionTextOverride: segment.captionTextOverride,
        captionEditMode: segment.captionEditMode,
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
  }

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

  const findTranscriptSnippetForRegions = useCallback((regions) => {
    const normalizedRegions = (Array.isArray(regions) ? regions : [])
      .map((region) => {
        const startSeconds = Number(region?.startSeconds);
        const endSeconds = Number(region?.endSeconds);
        if (!isFiniteNumber(startSeconds) || !isFiniteNumber(endSeconds) || endSeconds <= startSeconds) return null;
        return {
          startSeconds,
          endSeconds,
        };
      })
      .filter(Boolean);
    if (normalizedRegions.length === 0) return '';

    const parts = [];
    transcriptSegments.forEach((segment) => {
      const segmentStart = parseTimestamp(segment.startTimestamp);
      const segmentEnd = parseTimestamp(segment.endTimestamp);
      if (!isFiniteNumber(segmentStart) || !isFiniteNumber(segmentEnd) || segmentEnd <= segmentStart) return;
      const overlaps = normalizedRegions.some((region) => segmentStart < region.endSeconds && segmentEnd > region.startSeconds);
      if (overlaps) {
        const text = cleanTitleText(segment.text || '');
        if (text) parts.push(text);
      }
    });

    return cleanTitleText(parts.join(' ')).slice(0, 400);
  }, [transcriptSegments]);

  async function renderEditedRegionSequence() {
    if (!hasRegionEditSource || !precisionPreviewToken) {
      setStatus('Create a precision preview clip before using split-region render.');
      return false;
    }

    const orderedRegions = clipEditRegionsSorted;
    if (orderedRegions.length === 0) {
      setStatus('No kept regions are available to render.');
      return false;
    }

    const baseStart = isFiniteNumber(precisionPreviewWindowStart) ? precisionPreviewWindowStart : orderedRegions[0].startSeconds;
    const stylePreset = alignedPreviewWordCues.length > 0 ? 'pop-punch' : 'reel-bold';
    const titleSeed = stagedClipDraft?.title || findTranscriptSnippetForRegions(orderedRegions) || `Edited Clip ${clipCounterRef.current + 1}`;
    const descriptionSeed = studioTranscriptAppliedText || stagedClipDraft?.description || findTranscriptSnippetForRegions(orderedRegions) || 'Edited selection';
    const combinedTranscriptText = studioTranscriptAppliedText || findTranscriptSnippetForRegions(orderedRegions);

    const renderItems = orderedRegions.map((region, index) => {
      const captionCues = buildPhraseCuesForRange(
        qaPhraseCuesSourceWindow,
        region.startSeconds,
        region.endSeconds,
        `studio-render-${index + 1}`
      );

      const item = {
        token: precisionPreviewToken,
        title: `${cleanTitleText(titleSeed) || 'Edited Clip'} ${index + 1}`,
        trimStartSeconds: Number((region.startSeconds - baseStart).toFixed(3)),
        trimEndSeconds: Number((region.endSeconds - baseStart).toFixed(3)),
        captionEnabled: true,
        captionStylePreset: stylePreset,
        captionCues,
      };
      return item;
    });

    const outputCaptionCues = [];
    const originalOutputCaptionCues = [];
    let accumulatedOffset = 0;
    orderedRegions.forEach((region, index) => {
      const regionDuration = Math.max(effectiveMinClipSeconds, region.endSeconds - region.startSeconds);
      buildPhraseCuesForRange(qaPhraseCuesSourceWindow, region.startSeconds, region.endSeconds, `studio-output-${index + 1}`)
        .forEach((cue) => {
          outputCaptionCues.push({
            ...cue,
            startSeconds: Number((accumulatedOffset + cue.startSeconds).toFixed(3)),
            endSeconds: Number((accumulatedOffset + cue.endSeconds).toFixed(3)),
            words: Array.isArray(cue.words)
              ? cue.words.map((word) => ({
                ...word,
                startSeconds: Number((accumulatedOffset + word.startSeconds).toFixed(3)),
                endSeconds: Number((accumulatedOffset + word.endSeconds).toFixed(3)),
              }))
              : [],
          });
        });
      buildPhraseCuesForRange(
        buildPhraseCuesFromWordCues(sourceClipPreviewWordCues, createDefaultPhraseSpans(sourceClipPreviewWordCues, normalizedCaptionWordsPerChunk)),
        region.startSeconds,
        region.endSeconds,
        `studio-output-original-${index + 1}`
      ).forEach((cue) => {
        originalOutputCaptionCues.push({
          ...cue,
          startSeconds: Number((accumulatedOffset + cue.startSeconds).toFixed(3)),
          endSeconds: Number((accumulatedOffset + cue.endSeconds).toFixed(3)),
          words: Array.isArray(cue.words)
            ? cue.words.map((word) => ({
              ...word,
              startSeconds: Number((accumulatedOffset + word.startSeconds).toFixed(3)),
              endSeconds: Number((accumulatedOffset + word.endSeconds).toFixed(3)),
            }))
            : [],
        });
      });
      accumulatedOffset += regionDuration;
    });

    setIsRendering(true);
    setStatus(`Rendering edited clip from ${orderedRegions.length} kept region${orderedRegions.length === 1 ? '' : 's'}...`);

    try {
      const mode = orderedRegions.length > 1 ? 'group' : 'individual';
      const result = await withTimeout(
        renderTimelineEdits({
          mode,
          montageTitle: cleanTitleText(titleSeed) || 'Edited Clip',
          items: renderItems,
        }),
        420000,
        'Timed out rendering edited clip.'
      );

      let renderedClip = null;
      if (mode === 'group') {
        const montage = result.data?.montage || null;
        if (!montage?.downloadUrl) {
          throw new Error('Edited render did not return a montage download URL.');
        }
        renderedClip = {
          title: cleanTitleText(titleSeed) || 'Edited Clip',
          fileName: montage.fileName,
          downloadUrl: montage.downloadUrl,
          expiresAt: montage.expiresAt,
          renderSource: 'timeline_edit_group',
        };
      } else {
        const clips = Array.isArray(result.data?.clips) ? result.data.clips : [];
        if (clips.length === 0) {
          throw new Error('Edited render did not return a clip download URL.');
        }
        renderedClip = {
          ...clips[0],
          title: cleanTitleText(titleSeed) || clips[0].title || 'Edited Clip',
        };
      }

      const firstRegion = orderedRegions[0];
      const lastRegion = orderedRegions[orderedRegions.length - 1];
      const enrichedClip = {
        ...renderedClip,
        startTimestamp: formatTimestampPrecise(firstRegion.startSeconds),
        endTimestamp: formatTimestampPrecise(lastRegion.endSeconds),
        transcriptSourceText: combinedTranscriptText,
        transcriptSnippet: combinedTranscriptText.slice(0, 260),
        transcriptOriginalText: findTranscriptSnippetForRegions(orderedRegions),
        transcriptEditedText: hasStudioTranscriptEdit ? studioTranscriptAppliedText : '',
        transcriptEditedAt: hasStudioCaptionQaEdit ? (studioTranscriptEditedAt || new Date().toISOString()) : '',
        transcriptSelectedText: combinedTranscriptText,
        transcriptProvider: String(transcriptAvailability?.providerUsed || '').trim() || 'precision-preview',
        transcriptLanguage: String(transcriptAvailability?.languageUsed || '').trim() || 'unknown',
        selectionStartSeconds: Number(firstRegion.startSeconds.toFixed(3)),
        selectionEndSeconds: Number(lastRegion.endSeconds.toFixed(3)),
        captionCues: outputCaptionCues,
        captionCuesOriginal: originalOutputCaptionCues,
        captionCuesEdited: hasStudioCaptionQaEdit ? outputCaptionCues : [],
        captionTextOverride: '',
        captionEditMode: hasStudioCaptionQaEdit
          ? (hasStudioTranscriptEdit ? 'text-edit' : 'cue-edit')
          : 'source',
        captionStylePreset: stylePreset,
        captionConfirmationStatus: 'pending',
        captionConfirmedText: '',
        captionConfirmedAt: '',
        description: descriptionSeed,
      };

      onClipsRendered?.([enrichedClip], {
        sourceRef: sourceReference,
        sourceTitle,
        sourceType: 'youtube-url',
        contentProfile,
        origin: 'render-studio-region-edit',
        projectNameHint: sourceTitle,
      });
      setStatus('Edited clip rendered and sent to Clip Vault.');
      return true;
    } catch (error) {
      setStatus(`Edited render failed: ${error.message || 'Unknown error'}`);
      return false;
    } finally {
      setIsRendering(false);
    }
  }

  const addSegment = () => {
    if (hasRegionEditSource) {
      void (async () => {
        const success = await renderEditedRegionSequence();
        if (success) {
          setStagedClipDraft(null);
        }
      })();
      return;
    }

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
        selectedFragments: stagedClipDraft?.origin === 'transcript-selection'
          ? stagedClipDraft?.selectionFragments
          : [],
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

  const restoreNormalPlaybackRate = useCallback(() => {
    if (videoRef.current) {
      try {
        videoRef.current.playbackRate = 1;
      } catch {
        // ignore playback rate reset failures
      }
    }
    if (youtubePlayerRef.current && sourceMode === 'url' && isYouTubeSource) {
      try {
        youtubePlayerRef.current.setPlaybackRate?.(1);
      } catch {
        // ignore playback rate reset failures
      }
    }
  }, [isYouTubeSource, sourceMode]);

  const stopScrubAudioPreview = useCallback(() => {
    if (scrubAudioPauseTimeoutRef.current) {
      clearTimeout(scrubAudioPauseTimeoutRef.current);
      scrubAudioPauseTimeoutRef.current = null;
    }
    pausePreview();
    restoreNormalPlaybackRate();
  }, [pausePreview, restoreNormalPlaybackRate]);

  const finishTimelineScrub = useCallback(() => {
    const captureElement = timelineScrubCaptureElementRef.current;
    const pointerId = timelineScrubPointerIdRef.current;
    if (
      captureElement
      && pointerId !== null
      && typeof captureElement.releasePointerCapture === 'function'
    ) {
      try {
        captureElement.releasePointerCapture(pointerId);
      } catch {
        // ignore release failures
      }
    }
    timelineScrubPointerIdRef.current = null;
    timelineScrubCaptureElementRef.current = null;
    timelineScrubSessionRef.current = null;
    setIsTimelineScrubbing(false);
    stopScrubAudioPreview();
  }, [stopScrubAudioPreview]);

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
      const initialRegionId = createStudioRegionId();
      setPrecisionPreviewClip({
        downloadUrl: String(renderedClip.downloadUrl || ''),
        fileName: String(renderedClip.fileName || ''),
        expiresAt: String(renderedClip.expiresAt || ''),
        warning: String(renderedClip.warning || ''),
        windowStartSeconds: Number(nextWindowStart.toFixed(3)),
        windowEndSeconds: Number(nextWindowEnd.toFixed(3)),
      });
      setClipEditRegions([{
        id: initialRegionId,
        startSeconds: Number(nextWindowStart.toFixed(3)),
        endSeconds: Number(nextWindowEnd.toFixed(3)),
      }]);
      setSelectedEditRegionId(initialRegionId);
      seekToSeconds(rangeStart, { allowExternalOpen: false });
      setStatus('Preview clip ready. Ctrl+T splits at the playhead, Ctrl+[ / Ctrl+] trim the selected region, Delete removes a region, and Ctrl+J joins adjacent regions.');
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
  const activeTranscriptCueRows = useMemo(() => {
    if (stagedClipDraft?.origin !== 'transcript-selection') return transcriptRows;
    const fragments = Array.isArray(stagedClipDraft?.selectionFragments)
      ? stagedClipDraft.selectionFragments
      : [];
    if (fragments.length === 0) return transcriptRows;
    return fragments
      .map((fragment) => {
        const text = cleanTitleText(fragment?.text || '');
        const startSeconds = Number(fragment?.startSeconds);
        const endSeconds = Number(fragment?.endSeconds);
        if (!text || !isFiniteNumber(startSeconds) || !isFiniteNumber(endSeconds) || endSeconds <= startSeconds) {
          return null;
        }
        return {
          text,
          startSeconds,
          endSeconds,
          startTimestamp: formatTimestampPrecise(startSeconds, 3),
          endTimestamp: formatTimestampPrecise(endSeconds, 3),
        };
      })
      .filter(Boolean);
  }, [stagedClipDraft, transcriptRows]);

  const buildTranscriptSelectionFromRange = useCallback((range) => {
    if (!range || range.collapsed || !transcriptPaneRef.current) return null;

    const resolveTranscriptIndex = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      const transcriptRow = element?.closest?.('[data-transcript-index]');
      if (!transcriptRow) return null;
      const indexValue = Number(transcriptRow.getAttribute('data-transcript-index'));
      return Number.isInteger(indexValue) ? indexValue : null;
    };

    const getTextOffsetWithinElement = (element, node, offset) => {
      if (!element || !node) return null;
      try {
        const offsetRange = document.createRange();
        offsetRange.selectNodeContents(element);
        offsetRange.setEnd(node, offset);
        return offsetRange.toString().length;
      } catch {
        return null;
      }
    };

    const rangeStartIndex = resolveTranscriptIndex(range.startContainer);
    const rangeEndIndex = resolveTranscriptIndex(range.endContainer);
    if (!isFiniteNumber(rangeStartIndex) || !isFiniteNumber(rangeEndIndex)) return null;

    const startIndex = Math.min(rangeStartIndex, rangeEndIndex);
    const endIndex = Math.max(rangeStartIndex, rangeEndIndex);
    const fragments = [];
    const estimateBoundarySeconds = (row, charOffset) => {
      const rowStartSeconds = Number(row?.startSeconds);
      const rowEndSeconds = Number(row?.endSeconds);
      const rowText = String(row?.text || '');
      if (!isFiniteNumber(rowStartSeconds) || !isFiniteNumber(rowEndSeconds) || rowEndSeconds <= rowStartSeconds) {
        return rowStartSeconds;
      }
      const totalChars = Math.max(1, rowText.length);
      const ratio = clampNumber(charOffset / totalChars, 0, 1);
      return clampNumber(
        rowStartSeconds + ((rowEndSeconds - rowStartSeconds) * ratio),
        rowStartSeconds,
        rowEndSeconds
      );
    };

    for (let index = startIndex; index <= endIndex; index += 1) {
      const row = transcriptRows[index];
      const rowElement = transcriptRowRefs.current[index];
      const rowText = String(row?.text || '');
      if (!row || !rowElement || !rowText) continue;

      const rawStartOffset = index === rangeStartIndex
        ? getTextOffsetWithinElement(rowElement, range.startContainer, range.startOffset)
        : 0;
      const rawEndOffset = index === rangeEndIndex
        ? getTextOffsetWithinElement(rowElement, range.endContainer, range.endOffset)
        : rowText.length;

      const startCharOffset = clampNumber(Number(rawStartOffset) || 0, 0, rowText.length);
      const endCharOffset = clampNumber(
        Number(rawEndOffset) || rowText.length,
        startCharOffset,
        rowText.length
      );
      const text = rowText
        .slice(startCharOffset, endCharOffset)
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) continue;
      const fragmentStartSeconds = estimateBoundarySeconds(row, startCharOffset);
      const fragmentEndSeconds = estimateBoundarySeconds(row, endCharOffset);
      fragments.push({
        index,
        text,
        startCharOffset,
        endCharOffset,
        startSeconds: Number(fragmentStartSeconds.toFixed(3)),
        endSeconds: Number(fragmentEndSeconds.toFixed(3)),
      });
    }

    if (fragments.length === 0) {
      const fallbackText = String(range.toString() || '').replace(/\s+/g, ' ').trim();
      if (!fallbackText) return null;
      return {
        startIndex,
        endIndex,
        text: fallbackText.slice(0, 600),
      };
    }

    const firstFragment = fragments[0];
    const lastFragment = fragments[fragments.length - 1];
    const exactText = fragments
      .map((fragment) => fragment.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    const selectionStartSeconds = firstFragment.startSeconds;
    const selectionEndSeconds = lastFragment.endSeconds;

    return {
      startIndex: firstFragment.index,
      endIndex: lastFragment.index,
      text: exactText,
      selectionStartSeconds: Number(selectionStartSeconds.toFixed(3)),
      selectionEndSeconds: Number(selectionEndSeconds.toFixed(3)),
      fragments,
    };
  }, [transcriptRows]);

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
    if (isTimelineScrubbing) return;
    stableActiveTranscriptIndexRef.current = activeTranscriptIndex;
  }, [activeTranscriptIndex, isTimelineScrubbing]);
  const displayedActiveTranscriptIndex = isTimelineScrubbing
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

    const clipStartSeconds = isFiniteNumber(Number(selectedTranscriptSelection.selectionStartSeconds))
      ? Number(selectedTranscriptSelection.selectionStartSeconds)
      : (
        isFiniteNumber(startRow.startSeconds)
          ? startRow.startSeconds
          : parseTimestamp(startRow.startTimestamp)
      );
    const clipEndSecondsRaw = isFiniteNumber(Number(selectedTranscriptSelection.selectionEndSeconds))
      ? Number(selectedTranscriptSelection.selectionEndSeconds)
      : (
        isFiniteNumber(endRow.endSeconds)
          ? endRow.endSeconds
          : parseTimestamp(endRow.endTimestamp)
      );
    if (!isFiniteNumber(clipStartSeconds) || !isFiniteNumber(clipEndSecondsRaw)) {
      setStatus('Selected transcript range has invalid timing.');
      return;
    }

    const clipEndSeconds = Math.max(clipStartSeconds + 1, clipEndSecondsRaw);
    pausePreview();
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
    setStartTime(formatTimestampPrecise(clipStartSeconds, 2));
    setEndTime(formatTimestampPrecise(clipEndSeconds, 2));

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
      selectionFragments: Array.isArray(selectedTranscriptSelection.fragments)
        ? selectedTranscriptSelection.fragments
        : [],
    });
    setAlignedPreviewWordCues([]);
    seekToSeconds(clipStartSeconds, { allowExternalOpen: false });
    setStatus('Transcript selection loaded and zoomed for trim. Scrub waveform playhead, then set In/Out and render.');

    if (!PRECISION_ALIGNMENT_ENABLED) {
      setAlignmentWaveformData(null);
      return;
    }

    if (sourceMode !== 'url' || !isYouTubeSource || !sourceUrl) {
      setAlignmentWaveformData(null);
      setStatus('Transcript selection ready for trim. Scrub the waveform, use Ctrl+[ / Ctrl+] to place In and Out, then create a preview clip to unlock split editing.');
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
          setStatus(`Precision timing ready${alignmentLabel}. Playback is now limited to your trim range.${comparisonSummary}${providerFallbackMessage ? ` ${providerFallbackMessage}` : ''}`);
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

    const selectionRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const nextSelection = buildTranscriptSelectionFromRange(selectionRange);
    if (!nextSelection?.text) {
      setSelectedTranscriptSelection(null);
      return;
    }

    setSelectedTranscriptSelection(nextSelection);
  }, [buildTranscriptSelectionFromRange]);

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
  const precisionPreviewWindowStart = Number(precisionPreviewClip?.windowStartSeconds);
  const precisionPreviewWindowEnd = Number(precisionPreviewClip?.windowEndSeconds);
  const precisionPreviewToken = useMemo(
    () => extractRenderedClipToken(precisionPreviewClip?.downloadUrl),
    [precisionPreviewClip?.downloadUrl]
  );
  const clipEditRegionsSorted = useMemo(() => (
    (Array.isArray(clipEditRegions) ? clipEditRegions : [])
      .map((region) => {
        const startSeconds = Number(region?.startSeconds);
        const endSeconds = Number(region?.endSeconds);
        if (!isFiniteNumber(startSeconds) || !isFiniteNumber(endSeconds) || endSeconds <= startSeconds) return null;
        return {
          id: String(region?.id || createStudioRegionId()),
          startSeconds: Number(startSeconds.toFixed(3)),
          endSeconds: Number(endSeconds.toFixed(3)),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.startSeconds - right.startSeconds)
  ), [clipEditRegions]);
  const selectedEditRegion = useMemo(() => {
    if (clipEditRegionsSorted.length === 0) return null;
    return clipEditRegionsSorted.find((region) => region.id === selectedEditRegionId) || clipEditRegionsSorted[0];
  }, [clipEditRegionsSorted, selectedEditRegionId]);
  const hasRegionEditSource = (
    isPrecisionPreviewActive
    && Boolean(precisionPreviewToken)
    && clipEditRegionsSorted.length > 0
    && selectedEditRegion
  );
  const rangeStartSeconds = hasRegionEditSource
    ? Number(selectedEditRegion.startSeconds)
    : parseTimestamp(startTime);
  const rangeEndSeconds = hasRegionEditSource
    ? Number(selectedEditRegion.endSeconds)
    : parseTimestamp(endTime);
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
  const sourceClipWindowStart = hasRegionEditSource && isFiniteNumber(precisionPreviewWindowStart)
    ? precisionPreviewWindowStart
    : normalizedRangeStart;
  const sourceClipWindowEnd = hasRegionEditSource && isFiniteNumber(precisionPreviewWindowEnd) && precisionPreviewWindowEnd > sourceClipWindowStart
    ? precisionPreviewWindowEnd
    : normalizedRangeEnd;
  const rangeDurationLabel = hasValidRange
    ? formatTimestamp(normalizedRangeEnd - normalizedRangeStart)
    : '--:--';
  const normalizedCaptionWordsPerChunk = Math.round(
    clampNumber(Number(captionPreviewWordsPerChunk) || 5, 3, 8)
  );
  const alignedPreviewWordCuesInSourceWindow = useMemo(() => (
    (Array.isArray(alignedPreviewWordCues) ? alignedPreviewWordCues : [])
      .map((cue, index) => {
        const text = cleanTitleText(cue?.text || '');
        if (!text) return null;
        const cueStart = Number(cue?.startSeconds);
        const cueEnd = Number(cue?.endSeconds);
        if (!isFiniteNumber(cueStart) || !isFiniteNumber(cueEnd) || cueEnd <= cueStart) return null;
        if (cueEnd <= sourceClipWindowStart || cueStart >= sourceClipWindowEnd) return null;
        return {
          id: String(cue?.id || `aligned-cue-${index + 1}`),
          text,
          startSeconds: Number(Math.max(sourceClipWindowStart, cueStart).toFixed(3)),
          endSeconds: Number(Math.min(sourceClipWindowEnd, cueEnd).toFixed(3)),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.startSeconds - right.startSeconds)
  ), [alignedPreviewWordCues, sourceClipWindowEnd, sourceClipWindowStart]);
  const transcriptDerivedPreviewWordCuesInSourceWindow = useMemo(() => {
    const cues = [];
    activeTranscriptCueRows.forEach((row, rowIndex) => {
      const rowStart = Number(row?.startSeconds);
      const rowEnd = Number(row?.endSeconds);
      if (!isFiniteNumber(rowStart) || !isFiniteNumber(rowEnd) || rowEnd <= rowStart) return;
      const segmentStart = Math.max(sourceClipWindowStart, rowStart);
      const segmentEnd = Math.min(sourceClipWindowEnd, rowEnd);
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
  }, [activeTranscriptCueRows, sourceClipWindowEnd, sourceClipWindowStart]);
  const timingAnchorWordCues = useMemo(() => (
    mergeAlignedWordCuesWithFallback({
      alignedCues: alignedPreviewWordCuesInSourceWindow,
      fallbackCues: transcriptDerivedPreviewWordCuesInSourceWindow,
      rangeStartSeconds: sourceClipWindowStart,
      rangeEndSeconds: sourceClipWindowEnd,
      gapToleranceSeconds: 0.08,
      maxCues: 900,
    })
  ), [
    alignedPreviewWordCuesInSourceWindow,
    sourceClipWindowEnd,
    sourceClipWindowStart,
    transcriptDerivedPreviewWordCuesInSourceWindow,
  ]);
  const normalizedStudioTranscriptSourceText = normalizeCaptionEditorText(stagedClipDraft?.description || '');
  const normalizedStudioTranscriptDraftText = normalizeCaptionEditorText(studioTranscriptEditDraft);
  const sourceClipPreviewWordCues = useMemo(() => {
    if (!normalizedStudioTranscriptSourceText) {
      return timingAnchorWordCues;
    }
    const reflowedSelectionCues = buildReflowedCaptionCues({
      sourceCues: timingAnchorWordCues,
      editedText: normalizedStudioTranscriptSourceText,
      rangeStartSeconds: sourceClipWindowStart,
      rangeEndSeconds: sourceClipWindowEnd,
      idPrefix: 'selection-source',
    });
    return reflowedSelectionCues.length > 0 ? reflowedSelectionCues : timingAnchorWordCues;
  }, [
    normalizedStudioTranscriptSourceText,
    sourceClipWindowEnd,
    sourceClipWindowStart,
    timingAnchorWordCues,
  ]);
  const hasStudioTranscriptEdit = Boolean(
    studioTranscriptAppliedText
    && studioTranscriptAppliedText !== normalizedStudioTranscriptSourceText
  );
  const studioEditedSourceWindowWordCues = useMemo(() => {
    if (!hasStudioTranscriptEdit) return [];
    return buildReflowedCaptionCues({
      sourceCues: sourceClipPreviewWordCues,
      editedText: studioTranscriptAppliedText,
      rangeStartSeconds: sourceClipWindowStart,
      rangeEndSeconds: sourceClipWindowEnd,
      idPrefix: 'studio-edit',
    });
  }, [
    hasStudioTranscriptEdit,
    sourceClipPreviewWordCues,
    sourceClipWindowEnd,
    sourceClipWindowStart,
    studioTranscriptAppliedText,
  ]);
  const activeSourceWindowWordCues = hasStudioTranscriptEdit
    ? studioEditedSourceWindowWordCues
    : sourceClipPreviewWordCues;
  const defaultQaPhraseSpans = useMemo(
    () => createDefaultPhraseSpans(activeSourceWindowWordCues, normalizedCaptionWordsPerChunk),
    [activeSourceWindowWordCues, normalizedCaptionWordsPerChunk]
  );
  useEffect(() => {
    const normalizedWordCues = normalizeCaptionEditorCues(activeSourceWindowWordCues);
    setStudioQaWordCues(normalizedWordCues);
    setStudioPhraseSpans(defaultQaPhraseSpans);
  }, [activeSourceWindowWordCues, defaultQaPhraseSpans]);
  const qaSourceWindowWordCues = useMemo(() => {
    const normalizedWordCues = normalizeCaptionEditorCues(studioQaWordCues);
    if (normalizedWordCues.length === 0) return normalizeCaptionEditorCues(activeSourceWindowWordCues);
    return normalizedWordCues;
  }, [activeSourceWindowWordCues, studioQaWordCues]);
  const qaPhraseSpans = useMemo(
    () => normalizePhraseSpans(studioPhraseSpans, qaSourceWindowWordCues.length),
    [qaSourceWindowWordCues.length, studioPhraseSpans]
  );
  const hasStudioQaTimingEdit = useMemo(() => {
    const baseCues = normalizeCaptionEditorCues(activeSourceWindowWordCues);
    if (baseCues.length !== qaSourceWindowWordCues.length) return qaSourceWindowWordCues.length > 0;
    return baseCues.some((cue, index) => {
      const nextCue = qaSourceWindowWordCues[index];
      return !nextCue
        || cue.text !== nextCue.text
        || !approximatelyEqual(cue.startSeconds, nextCue.startSeconds, 0.001)
        || !approximatelyEqual(cue.endSeconds, nextCue.endSeconds, 0.001);
    });
  }, [activeSourceWindowWordCues, qaSourceWindowWordCues]);
  const hasStudioPhraseEdit = useMemo(() => {
    const normalizedDefault = normalizePhraseSpans(defaultQaPhraseSpans, qaSourceWindowWordCues.length);
    if (normalizedDefault.length !== qaPhraseSpans.length) return qaPhraseSpans.length > 0;
    return normalizedDefault.some((span, index) => {
      const nextSpan = qaPhraseSpans[index];
      return !nextSpan || span.startIndex !== nextSpan.startIndex || span.endIndex !== nextSpan.endIndex;
    });
  }, [defaultQaPhraseSpans, qaPhraseSpans, qaSourceWindowWordCues.length]);
  const hasStudioCaptionQaEdit = hasStudioTranscriptEdit || hasStudioQaTimingEdit || hasStudioPhraseEdit;
  const qaPhraseCuesSourceWindow = useMemo(
    () => buildPhraseCuesFromWordCues(qaSourceWindowWordCues, qaPhraseSpans),
    [qaPhraseSpans, qaSourceWindowWordCues]
  );
  const previewWordCues = useMemo(() => (
    qaSourceWindowWordCues
      .map((cue) => {
        if (cue.endSeconds <= normalizedRangeStart || cue.startSeconds >= normalizedRangeEnd) return null;
        return {
          ...cue,
          startSeconds: Number(Math.max(normalizedRangeStart, cue.startSeconds).toFixed(3)),
          endSeconds: Number(Math.min(normalizedRangeEnd, cue.endSeconds).toFixed(3)),
        };
      })
      .filter(Boolean)
  ), [
    normalizedRangeEnd,
    normalizedRangeStart,
    qaSourceWindowWordCues,
  ]);
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
  const activePreviewPhraseIndex = useMemo(() => {
    if (qaPhraseSpans.length === 0) return -1;
    const safeActiveIndex = activePreviewWordIndex >= 0 ? activePreviewWordIndex : 0;
    const phraseIndex = qaPhraseSpans.findIndex((span) => (
      safeActiveIndex >= span.startIndex && safeActiveIndex <= span.endIndex
    ));
    return phraseIndex >= 0 ? phraseIndex : 0;
  }, [activePreviewWordIndex, qaPhraseSpans]);
  const captionPreviewChunkWords = useMemo(() => {
    if (previewWordCues.length === 0) return [];
    const safeActivePhrase = activePreviewPhraseIndex >= 0 ? qaPhraseSpans[activePreviewPhraseIndex] : null;
    if (!safeActivePhrase) return [];
    return previewWordCues
      .slice(safeActivePhrase.startIndex, safeActivePhrase.endIndex + 1)
      .map((word, index) => {
        const globalIndex = safeActivePhrase.startIndex + index;
        return {
          ...word,
          globalIndex,
          isActive: globalIndex === activePreviewWordIndex,
        };
      });
  }, [activePreviewPhraseIndex, activePreviewWordIndex, previewWordCues, qaPhraseSpans]);
  const captionPreviewLines = useMemo(() => {
    if (captionPreviewChunkWords.length === 0) return [];
    const firstLineCount = Math.max(1, Math.ceil(captionPreviewChunkWords.length / 2));
    return [
      captionPreviewChunkWords.slice(0, firstLineCount),
      captionPreviewChunkWords.slice(firstLineCount),
    ].filter((line) => line.length > 0);
  }, [captionPreviewChunkWords]);
  const captionPreviewSourceLabel = hasStudioCaptionQaEdit
    ? (hasStudioTranscriptEdit ? 'Edited + reflowed' : 'QA-adjusted')
    : alignedPreviewWordCuesInSourceWindow.length > 0
    ? (
      previewWordCues.length !== alignedPreviewWordCuesInSourceWindow.length
        || previewWordCues.some((cue, index) => cue.text !== alignedPreviewWordCuesInSourceWindow[index]?.text)
        ? 'Aligned timing + selection text'
        : 'Aligned words'
    )
    : 'Transcript estimate';
  const activeQaPhraseSpan = activePreviewPhraseIndex >= 0 ? qaPhraseSpans[activePreviewPhraseIndex] || null : null;
  function buildPhraseCuesForRange(phraseCues, rangeStart, rangeEnd, idPrefix) {
    return (Array.isArray(phraseCues) ? phraseCues : [])
      .map((cue, index) => {
        const words = Array.isArray(cue?.words)
          ? cue.words
            .filter((word) => {
              const wordStart = Number(word?.startSeconds);
              const wordEnd = Number(word?.endSeconds);
              return isFiniteNumber(wordStart) && isFiniteNumber(wordEnd) && wordEnd > rangeStart && wordStart < rangeEnd;
            })
            .map((word, wordIndex) => ({
              id: String(word?.id || `${idPrefix}-${index + 1}-word-${wordIndex + 1}`),
              text: cleanTitleText(word?.text || ''),
              startSeconds: Number(Math.max(0, Number(word.startSeconds) - rangeStart).toFixed(3)),
              endSeconds: Number(Math.min(rangeEnd - rangeStart, Number(word.endSeconds) - rangeStart).toFixed(3)),
            }))
            .filter((word) => word.text && word.endSeconds > word.startSeconds)
          : [];
        if (words.length === 0) return null;
        return {
          id: String(cue?.id || `${idPrefix}-${index + 1}`),
          text: words.map((word) => word.text).join(' ').trim(),
          startSeconds: Number(words[0].startSeconds.toFixed(3)),
          endSeconds: Number(words[words.length - 1].endSeconds.toFixed(3)),
          words,
        };
      })
      .filter(Boolean);
  }
  const applyStudioTranscriptEdit = useCallback(() => {
    const normalizedDraft = normalizeCaptionEditorText(studioTranscriptEditDraft);
    if (!normalizedDraft || normalizedDraft === normalizedStudioTranscriptSourceText) {
      setStudioTranscriptAppliedText('');
      setStudioTranscriptEditedAt('');
      setStudioTranscriptEditDraft(normalizedStudioTranscriptSourceText);
      const resetWordCues = normalizeCaptionEditorCues(activeSourceWindowWordCues);
      setStudioQaWordCues(resetWordCues);
      setStudioPhraseSpans(createDefaultPhraseSpans(resetWordCues, normalizedCaptionWordsPerChunk));
      setStatus('Studio transcript edit cleared. Using source caption timing.');
      return;
    }
    const reflowedWordCues = normalizeCaptionEditorCues(buildReflowedCaptionCues({
      sourceCues: sourceClipPreviewWordCues,
      editedText: normalizedDraft,
      rangeStartSeconds: sourceClipWindowStart,
      rangeEndSeconds: sourceClipWindowEnd,
      idPrefix: 'studio-edit',
    }));
    setStudioTranscriptAppliedText(normalizedDraft);
    setStudioTranscriptEditedAt(new Date().toISOString());
    setStudioQaWordCues(reflowedWordCues);
    setStudioPhraseSpans(createDefaultPhraseSpans(reflowedWordCues, normalizedCaptionWordsPerChunk));
    setStatus('Studio transcript edit applied and caption timing reflowed for preview/render.');
  }, [
    activeSourceWindowWordCues,
    normalizedCaptionWordsPerChunk,
    normalizedStudioTranscriptSourceText,
    sourceClipPreviewWordCues,
    sourceClipWindowEnd,
    sourceClipWindowStart,
    studioTranscriptEditDraft,
  ]);
  const resetStudioTranscriptEdit = useCallback(() => {
    setStudioTranscriptEditDraft(normalizedStudioTranscriptSourceText);
    setStudioTranscriptAppliedText('');
    setStudioTranscriptEditedAt('');
    setStatus('Studio transcript restored to source selection.');
  }, [normalizedStudioTranscriptSourceText]);

  const toggleTranscriptPaneCollapsed = useCallback((nextCollapsed) => {
    setIsTranscriptPaneCollapsed((previous) => {
      const resolved = typeof nextCollapsed === 'boolean' ? nextCollapsed : !previous;
      if (!resolved) setIsFocusEditMode(false);
      return resolved;
    });
  }, []);

  const focusTimelineEditWorkspace = useCallback(() => {
    if (!hasValidRange) return;
    const focusedWindow = buildFocusedTrimWindow({
      clipStartSeconds: normalizedRangeStart,
      clipEndSeconds: normalizedRangeEnd,
      mediaDurationSeconds: effectiveDurationSeconds,
      edgeRatio: 0.1,
    });
    if (focusedWindow) {
      setTrimViewportRange(focusedWindow);
      setManualViewportStartSeconds(focusedWindow.start);
    }
    setTrimZoomLevel(1);
    setIsTrimEditMode(true);
    setIsFocusEditMode(true);
    setIsTranscriptPaneCollapsed(true);
    onRequestFocusEditWorkspace?.();
    try {
      trimTimelineRef.current?.focus?.({ preventScroll: true });
    } catch {
      trimTimelineRef.current?.focus?.();
    }
    setStatus('Focused edit mode: side panes hidden and timeline fit to clip with trim buffer.');
  }, [
    effectiveDurationSeconds,
    hasValidRange,
    normalizedRangeEnd,
    normalizedRangeStart,
    onRequestFocusEditWorkspace,
  ]);

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
  const visibleQaWordBlocks = useMemo(() => {
    return previewWordCues
      .map((cue, index) => {
        const visibleStart = Math.max(viewportStartSeconds, cue.startSeconds);
        const visibleEnd = Math.min(viewportEndSeconds, cue.endSeconds);
        if (!(visibleEnd > visibleStart)) return null;
        const leftPercent = clampNumber(((visibleStart - viewportStartSeconds) / viewportDurationSeconds) * 100, 0, 100);
        const rightPercent = clampNumber(((visibleEnd - viewportStartSeconds) / viewportDurationSeconds) * 100, 0, 100);
        return {
          ...cue,
          index,
          leftPercent,
          widthPercent: Math.max(0.6, rightPercent - leftPercent),
          isActive: index === activePreviewWordIndex,
          isInActivePhrase: Boolean(activeQaPhraseSpan && index >= activeQaPhraseSpan.startIndex && index <= activeQaPhraseSpan.endIndex),
        };
      })
      .filter(Boolean);
  }, [
    activePreviewWordIndex,
    activeQaPhraseSpan,
    previewWordCues,
    viewportDurationSeconds,
    viewportEndSeconds,
    viewportStartSeconds,
  ]);
  const visibleClipEditRegions = useMemo(() => {
    if (!hasRegionEditSource) return [];
    return clipEditRegionsSorted
      .map((region, index) => {
        const visibleStart = Math.max(viewportStartSeconds, region.startSeconds);
        const visibleEnd = Math.min(viewportEndSeconds, region.endSeconds);
        if (!(visibleEnd > visibleStart)) return null;
        const leftPercent = clampNumber(((visibleStart - viewportStartSeconds) / viewportDurationSeconds) * 100, 0, 100);
        const rightPercent = clampNumber(((visibleEnd - viewportStartSeconds) / viewportDurationSeconds) * 100, 0, 100);
        return {
          ...region,
          index,
          leftPercent,
          widthPercent: Math.max(0.9, rightPercent - leftPercent),
          isSelected: selectedEditRegion?.id === region.id,
        };
      })
      .filter(Boolean);
  }, [
    clipEditRegionsSorted,
    hasRegionEditSource,
    selectedEditRegion?.id,
    viewportDurationSeconds,
    viewportEndSeconds,
    viewportStartSeconds,
  ]);
  const canDeleteSelectedEditRegion = hasRegionEditSource && clipEditRegionsSorted.length > 1;
  const canSplitSelectedEditRegion = (
    hasRegionEditSource
    && selectedEditRegion
    && isFiniteNumber(currentTime)
    && currentTime > selectedEditRegion.startSeconds + effectiveMinClipSeconds
    && currentTime < selectedEditRegion.endSeconds - effectiveMinClipSeconds
  );
  const editModeStatusMessage = hasRegionEditSource
    ? 'Edit mode armed: Ctrl+T splits the selected region, Ctrl+[ / Ctrl+] trim that region, Delete removes it, Ctrl+J joins adjacent regions, trackpad swipe pans, and wheel zooms.'
    : 'Edit mode armed: Ctrl+T trims the nearest boundary, Ctrl+[ sets In, Ctrl+] sets Out, trackpad swipe pans, and wheel zooms.';
  const trimShortcutInLabel = hasRegionEditSource ? 'Ctrl+[ -> Region In' : 'Ctrl+[ -> In';
  const trimShortcutOutLabel = hasRegionEditSource ? 'Ctrl+] -> Region Out' : 'Ctrl+] -> Out';
  const trimInstructionCopy = hasRegionEditSource
    ? 'Drag the waveform to scrub the playhead. In Edit mode, two-finger swipe pans the timeline, wheel zooms around the playhead, Ctrl+T splits the selected region, Ctrl+[ / Ctrl+] trim that region, Delete removes it, Ctrl+J joins adjacent splits, and Space plays/stops.'
    : 'Drag the waveform to scrub the playhead. In Edit mode, two-finger swipe pans the timeline, wheel zooms around the playhead, Ctrl+T trims the nearest boundary, Ctrl+[ sets In, Ctrl+] sets Out, and Space plays/stops.';
  const formatTrimTimeLabel = useCallback((seconds) => (
    zoomLevel >= 3
      ? formatTimestampPrecise(seconds, 2)
      : formatTimestamp(seconds)
  ), [zoomLevel]);
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
    restoreNormalPlaybackRate();
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
    restoreNormalPlaybackRate,
    seekToSeconds,
  ]);

  const playClipLoop = useCallback(() => {
    if (!hasValidRange || isPrecisionAligning) return;

    restoreNormalPlaybackRate();
    seekToSeconds(normalizedRangeStart, { allowExternalOpen: false });
    const started = playPreview();
    setIsAuditioningClip(Boolean(started));
    setIsLoopPlayback(Boolean(started));
  }, [hasValidRange, isPrecisionAligning, normalizedRangeStart, playPreview, restoreNormalPlaybackRate, seekToSeconds]);

  const stopClipPlayback = useCallback(() => {
    pausePreview();
    restoreNormalPlaybackRate();
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
  }, [pausePreview, restoreNormalPlaybackRate]);

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

  const panViewportBy = useCallback((deltaSeconds) => {
    setManualViewportStartSeconds((previousStart) => {
      const currentStart = isFiniteNumber(previousStart) ? previousStart : viewportStartSeconds;
      const maxStart = Math.max(0, effectiveDurationSeconds - viewportDurationSeconds);
      return clampNumber(currentStart + deltaSeconds, 0, maxStart);
    });
  }, [effectiveDurationSeconds, viewportDurationSeconds, viewportStartSeconds]);

  const selectedEditRegionIndex = useMemo(() => (
    selectedEditRegion
      ? clipEditRegionsSorted.findIndex((region) => region.id === selectedEditRegion.id)
      : -1
  ), [clipEditRegionsSorted, selectedEditRegion]);

  const selectEditRegion = useCallback((regionId) => {
    const target = clipEditRegionsSorted.find((region) => region.id === regionId);
    if (!target) return;
    setSelectedEditRegionId(target.id);
    seekToSeconds(target.startSeconds, { allowExternalOpen: false });
    const focusedWindow = buildFocusedTrimWindow({
      clipStartSeconds: target.startSeconds,
      clipEndSeconds: target.endSeconds,
      mediaDurationSeconds: sourceClipWindowEnd,
    });
    if (focusedWindow) {
      setTrimViewportRange(focusedWindow);
      setManualViewportStartSeconds(focusedWindow.start);
    }
    const regionIndex = clipEditRegionsSorted.findIndex((region) => region.id === target.id);
    setStatus(`Selected region ${Math.max(1, regionIndex + 1)} of ${clipEditRegionsSorted.length}.`);
  }, [clipEditRegionsSorted, seekToSeconds, sourceClipWindowEnd]);

  const updateSelectedEditRegionBoundary = useCallback((targetBoundary, seconds) => {
    if (!hasRegionEditSource || !selectedEditRegion || !isFiniteNumber(seconds)) return null;
    const previousRegion = selectedEditRegionIndex > 0 ? clipEditRegionsSorted[selectedEditRegionIndex - 1] : null;
    const nextRegion = selectedEditRegionIndex >= 0 && selectedEditRegionIndex < clipEditRegionsSorted.length - 1
      ? clipEditRegionsSorted[selectedEditRegionIndex + 1]
      : null;

    const clampedInput = clampNumber(seconds, sourceClipWindowStart, sourceClipWindowEnd);
    let nextStart = selectedEditRegion.startSeconds;
    let nextEnd = selectedEditRegion.endSeconds;

    if (targetBoundary === 'start') {
      const minStart = previousRegion ? previousRegion.endSeconds : sourceClipWindowStart;
      const maxStart = nextEnd - effectiveMinClipSeconds;
      nextStart = clampNumber(clampedInput, minStart, Math.max(minStart, maxStart));
    } else if (targetBoundary === 'end') {
      const minEnd = nextStart + effectiveMinClipSeconds;
      const maxEnd = nextRegion ? nextRegion.startSeconds : sourceClipWindowEnd;
      nextEnd = clampNumber(clampedInput, Math.min(minEnd, maxEnd), maxEnd);
    } else {
      return null;
    }

    if (!(nextEnd > nextStart)) return null;

    setClipEditRegions((previous) => previous.map((region) => {
      if (region.id !== selectedEditRegion.id) return region;
      return {
        ...region,
        startSeconds: Number(nextStart.toFixed(3)),
        endSeconds: Number(nextEnd.toFixed(3)),
      };
    }));
    return targetBoundary === 'start' ? nextStart : nextEnd;
  }, [
    clipEditRegionsSorted,
    effectiveMinClipSeconds,
    hasRegionEditSource,
    selectedEditRegion,
    selectedEditRegionIndex,
    sourceClipWindowEnd,
    sourceClipWindowStart,
  ]);

  const splitSelectedEditRegionAtPlayhead = useCallback((seconds) => {
    if (!hasRegionEditSource || !selectedEditRegion || !isFiniteNumber(seconds)) return false;
    const splitPoint = clampNumber(seconds, selectedEditRegion.startSeconds, selectedEditRegion.endSeconds);
    if (
      splitPoint <= selectedEditRegion.startSeconds + effectiveMinClipSeconds
      || splitPoint >= selectedEditRegion.endSeconds - effectiveMinClipSeconds
    ) {
      setStatus('Move the playhead farther inside the selected region before splitting.');
      return false;
    }

    const boundedSplit = Number(splitPoint.toFixed(3));
    const rightRegionId = createStudioRegionId();
    setClipEditRegions((previous) => {
      const ordered = [...previous].sort((left, right) => left.startSeconds - right.startSeconds);
      const sourceIndex = ordered.findIndex((region) => region.id === selectedEditRegion.id);
      if (sourceIndex < 0) return previous;
      const sourceRegion = ordered[sourceIndex];
      const leftRegion = {
        ...sourceRegion,
        startSeconds: Number(sourceRegion.startSeconds.toFixed(3)),
        endSeconds: boundedSplit,
      };
      const rightRegion = {
        ...sourceRegion,
        id: rightRegionId,
        startSeconds: boundedSplit,
        endSeconds: Number(sourceRegion.endSeconds.toFixed(3)),
      };
      ordered.splice(sourceIndex, 1, leftRegion, rightRegion);
      return ordered;
    });
    setSelectedEditRegionId(rightRegionId);
    setStatus(`Region split at ${formatTrimTimeLabel(boundedSplit)}.`);
    return true;
  }, [
    effectiveMinClipSeconds,
    formatTrimTimeLabel,
    hasRegionEditSource,
    selectedEditRegion,
  ]);

  const deleteSelectedEditRegion = useCallback(() => {
    if (!hasRegionEditSource || !selectedEditRegion) return;
    if (clipEditRegionsSorted.length <= 1) {
      setStatus('At least one region must remain.');
      return;
    }

    const nextSelection = clipEditRegionsSorted[selectedEditRegionIndex + 1] || clipEditRegionsSorted[selectedEditRegionIndex - 1] || null;
    setClipEditRegions((previous) => previous.filter((region) => region.id !== selectedEditRegion.id));
    if (nextSelection) {
      setSelectedEditRegionId(nextSelection.id);
      seekToSeconds(nextSelection.startSeconds, { allowExternalOpen: false });
    } else {
      setSelectedEditRegionId('');
    }
    setStatus('Selected region removed. Remaining regions will join seamlessly in the final render.');
  }, [
    clipEditRegionsSorted,
    hasRegionEditSource,
    selectedEditRegion,
    selectedEditRegionIndex,
    seekToSeconds,
  ]);

  const joinSelectedEditRegion = useCallback(() => {
    if (!hasRegionEditSource || !selectedEditRegion) return false;
    const previousRegion = selectedEditRegionIndex > 0 ? clipEditRegionsSorted[selectedEditRegionIndex - 1] : null;
    const nextRegion = selectedEditRegionIndex >= 0 && selectedEditRegionIndex < clipEditRegionsSorted.length - 1
      ? clipEditRegionsSorted[selectedEditRegionIndex + 1]
      : null;
    const contiguousTolerance = 0.02;
    const joinLeft = previousRegion && Math.abs(previousRegion.endSeconds - selectedEditRegion.startSeconds) <= contiguousTolerance;
    const joinRight = nextRegion && Math.abs(selectedEditRegion.endSeconds - nextRegion.startSeconds) <= contiguousTolerance;

    if (!joinLeft && !joinRight) {
      setStatus('Join works on directly adjacent split regions. Deleted gaps already close automatically in the final render.');
      return false;
    }

    if (joinLeft) {
      const mergedRegionId = previousRegion.id;
      setClipEditRegions((previous) => previous
        .filter((region) => region.id !== selectedEditRegion.id)
        .map((region) => {
          if (region.id !== previousRegion.id) return region;
          return {
            ...region,
            startSeconds: Number(previousRegion.startSeconds.toFixed(3)),
            endSeconds: Number(selectedEditRegion.endSeconds.toFixed(3)),
          };
        }));
      setSelectedEditRegionId(mergedRegionId);
      setStatus('Joined selected region with the previous contiguous region.');
      return true;
    }

    const mergedRegionId = selectedEditRegion.id;
    setClipEditRegions((previous) => previous
      .filter((region) => region.id !== nextRegion.id)
      .map((region) => {
        if (region.id !== selectedEditRegion.id) return region;
        return {
          ...region,
          startSeconds: Number(selectedEditRegion.startSeconds.toFixed(3)),
          endSeconds: Number(nextRegion.endSeconds.toFixed(3)),
        };
      }));
    setSelectedEditRegionId(mergedRegionId);
    setStatus('Joined selected region with the next contiguous region.');
    return true;
  }, [
    clipEditRegionsSorted,
    hasRegionEditSource,
    selectedEditRegion,
    selectedEditRegionIndex,
  ]);

  const setTrimZoomAroundAnchor = useCallback((nextZoomValue, anchorSeconds = null, anchorRatio = 0.5) => {
    const clampedZoom = clampNumber(Number(nextZoomValue) || 1, 1, 8);
    const safeAnchorRatio = clampNumber(anchorRatio, 0, 1);
    const fallbackAnchor = viewportStartSeconds + (viewportDurationSeconds * safeAnchorRatio);
    const safeAnchorSeconds = clampNumber(
      isFiniteNumber(anchorSeconds) ? anchorSeconds : fallbackAnchor,
      0,
      effectiveDurationSeconds
    );
    const nextViewportDuration = Math.min(
      baseViewportDuration,
      Math.max(effectiveMinClipSeconds + 0.5, baseViewportDuration / clampedZoom)
    );
    const nextStart = clampNumber(
      safeAnchorSeconds - (safeAnchorRatio * nextViewportDuration),
      0,
      Math.max(0, effectiveDurationSeconds - nextViewportDuration)
    );

    setTrimZoomLevel(clampedZoom);
    setManualViewportStartSeconds(nextStart);
  }, [
    baseViewportDuration,
    effectiveDurationSeconds,
    effectiveMinClipSeconds,
    viewportDurationSeconds,
    viewportStartSeconds,
  ]);

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

  const getSecondsFromClientX = useCallback((clientX, element) => {
    if (!element) return null;

    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const ratio = clampNumber((clientX - bounds.left) / bounds.width, 0, 1);
    return viewportStartSeconds + ratio * viewportDurationSeconds;
  }, [viewportDurationSeconds, viewportStartSeconds]);

  const getSecondsFromTimelinePointer = useCallback((clientX) => (
    getSecondsFromClientX(clientX, trimTimelineRef.current)
  ), [getSecondsFromClientX]);

  const finishQaWordDrag = useCallback(() => {
    if (typeof qaWordDragCleanupRef.current === 'function') {
      try {
        qaWordDragCleanupRef.current();
      } catch {
        // ignore listener cleanup failures
      }
    }
    qaWordDragCleanupRef.current = null;
    const dragState = qaWordDragStateRef.current;
    if (
      dragState?.captureElement
      && dragState.pointerId !== null
      && typeof dragState.captureElement.releasePointerCapture === 'function'
    ) {
      try {
        dragState.captureElement.releasePointerCapture(dragState.pointerId);
      } catch {
        // ignore capture release failures
      }
    }
    qaWordDragStateRef.current = null;
  }, []);

  const startQaWordDrag = useCallback((event, wordIndex) => {
    if (isPrecisionAligning) return;
    const normalizedCues = normalizeCaptionEditorCues(studioQaWordCues.length > 0 ? studioQaWordCues : activeSourceWindowWordCues);
    const targetCue = normalizedCues[wordIndex];
    if (!targetCue) return;

    event.preventDefault();
    event.stopPropagation();
    stopClipPlayback();

    qaWordDragStateRef.current = {
      pointerId: event.pointerId,
      wordIndex,
      startClientX: event.clientX,
      initialCues: normalizedCues,
      captureElement: event.currentTarget,
    };

    const handleWindowPointerMove = (moveEvent) => {
      const dragState = qaWordDragStateRef.current;
      if (!dragState || dragState.pointerId !== moveEvent.pointerId) return;

      const timelineBounds = trimTimelineRef.current?.getBoundingClientRect?.();
      if (!timelineBounds || !(timelineBounds.width > 0)) return;

      moveEvent.preventDefault();

      const deltaSeconds = ((moveEvent.clientX - dragState.startClientX) / timelineBounds.width) * viewportDurationSeconds;
      const cues = normalizeCaptionEditorCues(dragState.initialCues);
      const safeIndex = Math.max(0, Math.min(cues.length - 1, dragState.wordIndex));
      const cue = cues[safeIndex];
      if (!cue) return;

      const minimumWordDuration = 0.02;
      const boundaryGap = 0.01;
      const previousCue = safeIndex > 0 ? cues[safeIndex - 1] : null;
      const nextCue = safeIndex < cues.length - 1 ? cues[safeIndex + 1] : null;
      const cueDuration = Math.max(minimumWordDuration, cue.endSeconds - cue.startSeconds);
      const nextStartLimit = nextCue
        ? nextCue.startSeconds - boundaryGap
        : sourceClipWindowEnd;
      let desiredStart = cue.startSeconds + deltaSeconds;
      desiredStart = clampNumber(
        desiredStart,
        sourceClipWindowStart,
        Math.max(sourceClipWindowStart, nextStartLimit - minimumWordDuration)
      );

      let updatedPreviousEnd = previousCue ? previousCue.endSeconds : null;
      if (previousCue) {
        updatedPreviousEnd = Math.min(previousCue.endSeconds, desiredStart - boundaryGap);
        const previousMinimumEnd = previousCue.startSeconds + minimumWordDuration;
        if (updatedPreviousEnd < previousMinimumEnd) {
          updatedPreviousEnd = previousMinimumEnd;
          desiredStart = Math.max(desiredStart, updatedPreviousEnd + boundaryGap);
        }
      }

      const updatedCueEnd = Math.min(
        desiredStart + cueDuration,
        nextStartLimit
      );
      const safeCueEnd = Math.max(desiredStart + minimumWordDuration, updatedCueEnd);

      setStudioQaWordCues(cues.map((entry, index) => {
        if (index === safeIndex - 1 && previousCue) {
          return {
            ...entry,
            endSeconds: Number(updatedPreviousEnd.toFixed(3)),
          };
        }
        if (index !== safeIndex) return entry;
        return {
          ...entry,
          startSeconds: Number(desiredStart.toFixed(3)),
          endSeconds: Number(Math.min(safeCueEnd, nextStartLimit).toFixed(3)),
        };
      }));
    };

    const handleWindowPointerEnd = (endEvent) => {
      const dragState = qaWordDragStateRef.current;
      if (!dragState || dragState.pointerId !== endEvent.pointerId) return;
      endEvent.preventDefault();
      finishQaWordDrag();
      setStatus('Word timing updated.');
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', handleWindowPointerEnd, { passive: false });
    window.addEventListener('pointercancel', handleWindowPointerEnd, { passive: false });
    qaWordDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerEnd);
      window.removeEventListener('pointercancel', handleWindowPointerEnd);
    };

    if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore pointer capture failures
      }
    }
    setStatus(`Dragging word "${targetCue.text}" to align with waveform.`);
  }, [
    activeSourceWindowWordCues,
    finishQaWordDrag,
    isPrecisionAligning,
    setStatus,
    sourceClipWindowEnd,
    sourceClipWindowStart,
    stopClipPlayback,
    studioQaWordCues,
    viewportDurationSeconds,
  ]);

  const handleTrimTimelineWheel = useCallback((event) => {
    if (!isTrimEditMode || isPrecisionAligning) return;

    const timelineElement = trimTimelineRef.current || event.currentTarget;
    const bounds = timelineElement?.getBoundingClientRect?.();
    const anchorRatio = bounds?.width
      ? clampNumber((event.clientX - bounds.left) / bounds.width, 0, 1)
      : 0.5;
    const anchorSeconds = getSecondsFromClientX(event.clientX, timelineElement)
      ?? (viewportStartSeconds + (viewportDurationSeconds * anchorRatio));
    const horizontalDominant = Math.abs(event.deltaX) > Math.abs(event.deltaY);

    if (horizontalDominant && Math.abs(event.deltaX) > 0.5) {
      event.preventDefault();
      const panScale = bounds?.width ? (event.deltaX / bounds.width) : 0;
      panViewportBy(panScale * viewportDurationSeconds * 1.35);
      return;
    }

    if (Math.abs(event.deltaY) > 0.5) {
      event.preventDefault();
      const zoomDelta = clampNumber(event.deltaY / 180, -2.5, 2.5);
      setTrimZoomAroundAnchor(trimZoomLevel - (zoomDelta * 0.75), anchorSeconds, anchorRatio);
    }
  }, [
    getSecondsFromClientX,
    isPrecisionAligning,
    isTrimEditMode,
    panViewportBy,
    setTrimZoomAroundAnchor,
    trimZoomLevel,
    viewportDurationSeconds,
    viewportStartSeconds,
  ]);

  useEffect(() => {
    if (!isTrimEditMode || isPrecisionAligning) return undefined;

    const timelineElement = trimTimelineRef.current;
    const rootElement = document.documentElement;
    const bodyElement = document.body;
    if (!timelineElement || !rootElement || !bodyElement) return undefined;

    const previousRootOverscroll = rootElement.style.overscrollBehavior;
    const previousRootOverscrollX = rootElement.style.overscrollBehaviorX;
    const previousBodyOverscroll = bodyElement.style.overscrollBehavior;
    const previousBodyOverscrollX = bodyElement.style.overscrollBehaviorX;
    const previousTimelineOverscroll = timelineElement.style.overscrollBehavior;
    const previousTimelineOverscrollX = timelineElement.style.overscrollBehaviorX;

    rootElement.style.overscrollBehavior = 'none';
    rootElement.style.overscrollBehaviorX = 'none';
    bodyElement.style.overscrollBehavior = 'none';
    bodyElement.style.overscrollBehaviorX = 'none';
    timelineElement.style.overscrollBehavior = 'none';
    timelineElement.style.overscrollBehaviorX = 'none';

    const onWheel = (event) => {
      handleTrimTimelineWheel(event);
    };

    timelineElement.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      timelineElement.removeEventListener('wheel', onWheel);
      rootElement.style.overscrollBehavior = previousRootOverscroll;
      rootElement.style.overscrollBehaviorX = previousRootOverscrollX;
      bodyElement.style.overscrollBehavior = previousBodyOverscroll;
      bodyElement.style.overscrollBehaviorX = previousBodyOverscrollX;
      timelineElement.style.overscrollBehavior = previousTimelineOverscroll;
      timelineElement.style.overscrollBehaviorX = previousTimelineOverscrollX;
    };
  }, [handleTrimTimelineWheel, isPrecisionAligning, isTrimEditMode]);

  useEffect(() => {
    if (!isFocusEditMode || !isTrimEditMode || isPrecisionAligning) return undefined;

    const focusSurfaceElement = focusEditSurfaceRef.current;
    const timelineElement = trimTimelineRef.current;
    const rootElement = document.documentElement;
    const bodyElement = document.body;
    if (!focusSurfaceElement || !timelineElement || !rootElement || !bodyElement) return undefined;

    const previousRootOverscroll = rootElement.style.overscrollBehavior;
    const previousRootOverscrollX = rootElement.style.overscrollBehaviorX;
    const previousBodyOverscroll = bodyElement.style.overscrollBehavior;
    const previousBodyOverscrollX = bodyElement.style.overscrollBehaviorX;

    rootElement.style.overscrollBehavior = 'none';
    rootElement.style.overscrollBehaviorX = 'none';
    bodyElement.style.overscrollBehavior = 'none';
    bodyElement.style.overscrollBehaviorX = 'none';

    const onWindowWheel = (event) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node)) return;
      if (!focusSurfaceElement.contains(eventTarget)) return;
      handleTrimTimelineWheel({
        ...event,
        currentTarget: timelineElement,
      });
    };

    window.addEventListener('wheel', onWindowWheel, { passive: false, capture: true });

    return () => {
      window.removeEventListener('wheel', onWindowWheel, { capture: true });
      rootElement.style.overscrollBehavior = previousRootOverscroll;
      rootElement.style.overscrollBehaviorX = previousRootOverscrollX;
      bodyElement.style.overscrollBehavior = previousBodyOverscroll;
      bodyElement.style.overscrollBehaviorX = previousBodyOverscrollX;
    };
  }, [handleTrimTimelineWheel, isFocusEditMode, isPrecisionAligning, isTrimEditMode]);

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
        media.playbackRate = 1;
        media.play().catch(() => {});
        scrubAudioPauseTimeoutRef.current = window.setTimeout(() => {
          media.pause();
          media.playbackRate = 1;
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
        youtubePlayerRef.current.setPlaybackRate?.(1);
        youtubePlayerRef.current.playVideo?.();
        scrubAudioPauseTimeoutRef.current = window.setTimeout(() => {
          try {
            youtubePlayerRef.current?.pauseVideo?.();
            youtubePlayerRef.current?.setPlaybackRate?.(1);
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

  const applyRangeBoundaryAtSeconds = useCallback((targetBoundary, seconds) => {
    if (!hasValidRange || !isFiniteNumber(seconds)) return null;
    if (hasRegionEditSource) {
      return updateSelectedEditRegionBoundary(targetBoundary, seconds);
    }
    const cutSeconds = clampNumber(seconds, 0, effectiveDurationSeconds);

    if (targetBoundary === 'start') {
      const maxStart = Math.max(0, normalizedRangeEnd - effectiveMinClipSeconds);
      const nextStart = clampNumber(cutSeconds, 0, maxStart);
      setStartTime(formatTimestampPrecise(nextStart, dragFractionDigits));
      return nextStart;
    }

    if (targetBoundary === 'end') {
      const minEnd = normalizedRangeStart + effectiveMinClipSeconds;
      const nextEnd = clampNumber(cutSeconds, minEnd, effectiveDurationSeconds);
      setEndTime(formatTimestampPrecise(nextEnd, dragFractionDigits));
      return nextEnd;
    }

    return null;
  }, [
    dragFractionDigits,
    effectiveDurationSeconds,
    effectiveMinClipSeconds,
    hasValidRange,
    hasRegionEditSource,
    normalizedRangeEnd,
    normalizedRangeStart,
    updateSelectedEditRegionBoundary,
  ]);

  const applyScrubCutAtPlayhead = useCallback((seconds, explicitTarget = null) => {
    if (!hasValidRange || !isFiniteNumber(seconds)) return;
    const boundary = (() => {
      if (explicitTarget === 'start' || explicitTarget === 'end') {
        return explicitTarget;
      }
      if (seconds <= normalizedRangeStart) return 'start';
      if (seconds >= normalizedRangeEnd) return 'end';

      const distanceToStart = Math.abs(seconds - normalizedRangeStart);
      const distanceToEnd = Math.abs(normalizedRangeEnd - seconds);
      return distanceToStart <= distanceToEnd ? 'start' : 'end';
    })();
    const formatCutTime = (value) => (
      zoomLevel >= 3
        ? formatTimestampPrecise(value, 2)
        : formatTimestamp(value)
    );
    const appliedSeconds = applyRangeBoundaryAtSeconds(boundary, seconds);
    if (!isFiniteNumber(appliedSeconds)) return;

    seekToSeconds(appliedSeconds, { allowExternalOpen: false });
    if (boundary === 'start') {
      setStatus(`In point set at ${formatCutTime(appliedSeconds)}.`);
      return;
    }

    setStatus(`Out point set at ${formatCutTime(appliedSeconds)}.`);
  }, [
    applyRangeBoundaryAtSeconds,
    hasValidRange,
    normalizedRangeEnd,
    normalizedRangeStart,
    seekToSeconds,
    zoomLevel,
  ]);

  const cutAtCurrentPlayhead = useCallback((explicitTarget = null) => {
    if (sourceMode === 'none' || !hasValidRange || isPrecisionAligning) return;
    const playheadSeconds = isFiniteNumber(currentTime)
      ? Number(currentTime)
      : normalizedRangeStart;
    applyScrubCutAtPlayhead(playheadSeconds, explicitTarget);
  }, [
    applyScrubCutAtPlayhead,
    currentTime,
    hasValidRange,
    isPrecisionAligning,
    normalizedRangeStart,
    sourceMode,
  ]);

  const smartCutTarget = useMemo(() => {
    const playheadSeconds = isFiniteNumber(currentTime)
      ? Number(currentTime)
      : normalizedRangeStart;
    if (!hasValidRange) return 'start';
    if (playheadSeconds <= normalizedRangeStart) return 'start';
    if (playheadSeconds >= normalizedRangeEnd) return 'end';

    const distanceToStart = Math.abs(playheadSeconds - normalizedRangeStart);
    const distanceToEnd = Math.abs(normalizedRangeEnd - playheadSeconds);
    return distanceToStart <= distanceToEnd ? 'start' : 'end';
  }, [currentTime, hasValidRange, normalizedRangeEnd, normalizedRangeStart]);
  const canJoinSelectedEditRegion = useMemo(() => {
    if (!hasRegionEditSource || !selectedEditRegion) return false;
    const previousRegion = selectedEditRegionIndex > 0 ? clipEditRegionsSorted[selectedEditRegionIndex - 1] : null;
    const nextRegion = selectedEditRegionIndex >= 0 && selectedEditRegionIndex < clipEditRegionsSorted.length - 1
      ? clipEditRegionsSorted[selectedEditRegionIndex + 1]
      : null;
    const contiguousTolerance = 0.02;
    return Boolean(
      (previousRegion && Math.abs(previousRegion.endSeconds - selectedEditRegion.startSeconds) <= contiguousTolerance)
      || (nextRegion && Math.abs(selectedEditRegion.endSeconds - nextRegion.startSeconds) <= contiguousTolerance)
    );
  }, [clipEditRegionsSorted, hasRegionEditSource, selectedEditRegion, selectedEditRegionIndex]);
  const trimShortcutPrimaryLabel = hasRegionEditSource
    ? 'Ctrl+T -> Split'
    : `Ctrl+T -> ${smartCutTarget === 'start' ? 'nearest In' : 'nearest Out'}`;
  const trimRangeSummaryLabel = hasRegionEditSource
    ? `Kept ${clipEditRegionsSorted.length} • Selected R${Math.max(1, selectedEditRegionIndex + 1)} • In ${formatTrimTimeLabel(normalizedRangeStart)} / Out ${formatTrimTimeLabel(normalizedRangeEnd)}`
    : `In ${formatTrimTimeLabel(normalizedRangeStart)} / Out ${formatTrimTimeLabel(normalizedRangeEnd)}`;

  const handleTimelinePointerDown = useCallback((event) => {
    if (isPrecisionAligning) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const pointerSeconds = getSecondsFromTimelinePointer(event.clientX);
    if (!isFiniteNumber(pointerSeconds)) return;

    event.preventDefault();
    event.stopPropagation();
    stopClipPlayback();
    setManualViewportStartSeconds(viewportStartSeconds);
    setIsTimelineScrubbing(true);

    timelineScrubPointerIdRef.current = event.pointerId;
    timelineScrubSessionRef.current = {
      lastClientX: event.clientX,
      lastSeconds: pointerSeconds,
      lastTimestampMs: Date.now(),
    };
    const captureElement = trimTimelineRef.current || event.currentTarget;
    timelineScrubCaptureElementRef.current = captureElement;
    if (captureElement && typeof captureElement.focus === 'function') {
      try {
        captureElement.focus({ preventScroll: true });
      } catch {
        try {
          captureElement.focus();
        } catch {
          // ignore focus failures
        }
      }
    }

    if (captureElement && typeof captureElement.setPointerCapture === 'function') {
      try {
        captureElement.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    }

    seekToSeconds(pointerSeconds, { allowExternalOpen: false });
    playScrubAudioPreview(pointerSeconds, 0, 0.25);
  }, [
    getSecondsFromTimelinePointer,
    isPrecisionAligning,
    playScrubAudioPreview,
    seekToSeconds,
    stopClipPlayback,
    viewportStartSeconds,
  ]);

  const finishPreviewResize = useCallback(() => {
    const captureElement = previewResizeCaptureElementRef.current;
    const pointerId = previewResizePointerIdRef.current;
    if (
      captureElement
      && pointerId !== null
      && typeof captureElement.releasePointerCapture === 'function'
    ) {
      try {
        captureElement.releasePointerCapture(pointerId);
      } catch {
        // ignore capture release failures
      }
    }
    previewResizePointerIdRef.current = null;
    previewResizeCaptureElementRef.current = null;
    previewResizeSessionRef.current = null;
  }, []);

  const handlePreviewResizeMove = useCallback((event) => {
    if (previewResizePointerIdRef.current !== event.pointerId) return;
    const resizeState = previewResizeSessionRef.current;
    if (!resizeState) return;
    event.preventDefault();
    event.stopPropagation();
    const nextHeight = clampNumber(
      resizeState.startHeight + (event.clientY - resizeState.startClientY),
      220,
      680
    );
    setPreviewMonitorHeight(Math.round(nextHeight));
  }, []);

  const handlePreviewResizeEnd = useCallback((event) => {
    if (previewResizePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishPreviewResize();
  }, [finishPreviewResize]);

  const startPreviewResize = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    previewResizePointerIdRef.current = event.pointerId;
    previewResizeSessionRef.current = {
      startClientY: event.clientY,
      startHeight: previewMonitorHeight,
    };
    const captureElement = event.currentTarget;
    previewResizeCaptureElementRef.current = captureElement;
    if (captureElement && typeof captureElement.setPointerCapture === 'function') {
      try {
        captureElement.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    }
  }, [previewMonitorHeight]);

  useEffect(() => {
    if (isTimelineScrubbing) return;
    if (
      approximatelyEqual(rangeStartSeconds, normalizedRangeStart) &&
      approximatelyEqual(rangeEndSeconds, normalizedRangeEnd)
    ) {
      return;
    }
    setStartTime(formatTimestampPrecise(normalizedRangeStart, dragFractionDigits));
    setEndTime(formatTimestampPrecise(normalizedRangeEnd, dragFractionDigits));
  }, [dragFractionDigits, isTimelineScrubbing, normalizedRangeEnd, normalizedRangeStart, rangeEndSeconds, rangeStartSeconds]);

  useEffect(() => {
    if (!isPrecisionAligning) return;
    stopClipPlayback();
  }, [isPrecisionAligning, stopClipPlayback]);

  const handleTimelinePointerMove = useCallback((event) => {
    const pointerId = timelineScrubPointerIdRef.current;
    if (pointerId === null || event.pointerId !== pointerId) return;

    const pointerSeconds = getSecondsFromTimelinePointer(event.clientX);
    if (!isFiniteNumber(pointerSeconds)) return;

    const session = timelineScrubSessionRef.current || {
      lastClientX: event.clientX,
      lastSeconds: pointerSeconds,
      lastTimestampMs: Date.now(),
    };
    const nowMs = Date.now();
    const dtMs = Math.max(1, nowMs - Number(session.lastTimestampMs || nowMs));
    const deltaSeconds = pointerSeconds - Number(session.lastSeconds || pointerSeconds);
    const speed = Math.abs(deltaSeconds) / (dtMs / 1000);

    session.lastClientX = event.clientX;
    session.lastSeconds = pointerSeconds;
    session.lastTimestampMs = nowMs;
    timelineScrubSessionRef.current = session;

    event.preventDefault();
    seekToSeconds(pointerSeconds, { allowExternalOpen: false });
    playScrubAudioPreview(pointerSeconds, deltaSeconds, speed);
  }, [getSecondsFromTimelinePointer, playScrubAudioPreview, seekToSeconds]);

  const handleTimelinePointerUp = useCallback((event) => {
    const pointerId = timelineScrubPointerIdRef.current;
    if (pointerId === null || event.pointerId !== pointerId) return;
    finishTimelineScrub();
  }, [finishTimelineScrub]);

  const handleTimelinePointerCancel = useCallback((event) => {
    const pointerId = timelineScrubPointerIdRef.current;
    if (pointerId === null || event.pointerId !== pointerId) return;
    finishTimelineScrub();
  }, [finishTimelineScrub]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = String(target.tagName || '').toUpperCase();
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') {
          return;
        }
        if (target.isContentEditable) return;
      }

      if (sourceMode === 'none' || !hasValidRange || isPrecisionAligning) return;

      const lowerKey = String(event.key || '').toLowerCase();
      const isBracketLeft = event.code === 'BracketLeft' || event.key === '[';
      const isBracketRight = event.code === 'BracketRight' || event.key === ']';

      if (isTrimEditMode) {
        const isControlCut = event.ctrlKey && !event.metaKey && !event.altKey && lowerKey === 't';
        if (isControlCut) {
          event.preventDefault();
          if (hasRegionEditSource) {
            splitSelectedEditRegionAtPlayhead(
              isFiniteNumber(currentTime) ? Number(currentTime) : normalizedRangeStart
            );
          } else {
            cutAtCurrentPlayhead();
          }
          return;
        }

        const isControlSetIn = event.ctrlKey && !event.metaKey && !event.altKey && isBracketLeft;
        if (isControlSetIn) {
          event.preventDefault();
          cutAtCurrentPlayhead('start');
          return;
        }

        const isControlSetOut = event.ctrlKey && !event.metaKey && !event.altKey && isBracketRight;
        if (isControlSetOut) {
          event.preventDefault();
          cutAtCurrentPlayhead('end');
          return;
        }

        if (event.ctrlKey && !event.metaKey && !event.altKey && lowerKey === 'j') {
          event.preventDefault();
          if (hasRegionEditSource) {
            joinSelectedEditRegion();
          } else {
            setStatus('Join becomes active after you create a precision preview clip and split regions.');
          }
          return;
        }

        if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault();
          if (hasRegionEditSource) {
            deleteSelectedEditRegion();
          }
          return;
        }
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && lowerKey === 'i') {
        event.preventDefault();
        cutAtCurrentPlayhead('start');
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && lowerKey === 'o') {
        event.preventDefault();
        cutAtCurrentPlayhead('end');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    currentTime,
    cutAtCurrentPlayhead,
    deleteSelectedEditRegion,
    hasRegionEditSource,
    hasValidRange,
    isPrecisionAligning,
    isTrimEditMode,
    joinSelectedEditRegion,
    normalizedRangeStart,
    sourceMode,
    splitSelectedEditRegionAtPlayhead,
  ]);

  useEffect(() => {
    const onWindowBlur = () => {
      if (timelineScrubPointerIdRef.current === null) return;
      finishTimelineScrub();
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [finishTimelineScrub]);

  useEffect(() => {
    finishTimelineScrub();
    setIsAuditioningClip(false);
    setIsLoopPlayback(false);
  }, [sourceMode, sourceUrl, sourceFile, finishTimelineScrub]);

  useEffect(() => {
    let disposed = false;
    playheadLastCommitRef.current = 0;

    const tickPlayhead = (nowMs) => {
      if (disposed) return;

      let sampledSeconds = null;
      if ((sourceMode === 'file' || isPrecisionPreviewActive) && videoRef.current) {
        const media = videoRef.current;
        const isActive = !media.paused || isTimelineScrubbing || isAuditioningClip;
        if (isActive) {
          const rawSeconds = Number(media.currentTime || 0);
          if (isFiniteNumber(rawSeconds)) {
            if (isPrecisionPreviewActive) {
              const baseStart = isFiniteNumber(precisionPreviewWindowStart) ? precisionPreviewWindowStart : 0;
              sampledSeconds = baseStart + rawSeconds;
            } else {
              sampledSeconds = rawSeconds;
            }
          }
        }
      } else if (sourceMode === 'url' && isYouTubeSource && !isPrecisionPreviewActive && youtubePlayerRef.current) {
        try {
          const playerState = Number(youtubePlayerRef.current.getPlayerState?.() ?? -1);
          const isActive = playerState === 1 || playerState === 3 || isTimelineScrubbing || isAuditioningClip;
          if (isActive) {
            const rawSeconds = Number(youtubePlayerRef.current.getCurrentTime?.() || 0);
            if (isFiniteNumber(rawSeconds)) {
              sampledSeconds = rawSeconds;
            }
          }
        } catch {
          // keep last currentTime on polling errors
        }
      }

      if (isFiniteNumber(sampledSeconds) && nowMs - playheadLastCommitRef.current >= 20) {
        setCurrentTime((previous) => (
          Math.abs(previous - sampledSeconds) >= 0.008 ? sampledSeconds : previous
        ));
        playheadLastCommitRef.current = nowMs;
      }

      playheadAnimationRef.current = requestAnimationFrame(tickPlayhead);
    };

    playheadAnimationRef.current = requestAnimationFrame(tickPlayhead);
    return () => {
      disposed = true;
      if (playheadAnimationRef.current) {
        cancelAnimationFrame(playheadAnimationRef.current);
        playheadAnimationRef.current = null;
      }
    };
  }, [
    isAuditioningClip,
    isPrecisionPreviewActive,
    isTimelineScrubbing,
    isYouTubeSource,
    precisionPreviewWindowStart,
    sourceMode,
  ]);

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
    if (isTimelineScrubbing) return;
    if (displayedActiveTranscriptIndex < 0) return;

    const rowElement = transcriptRowRefs.current[displayedActiveTranscriptIndex];
    if (!rowElement) return;

    transcriptAutoScrollRef.current = true;
    rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timeoutId = window.setTimeout(() => {
      transcriptAutoScrollRef.current = false;
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [autoFollowTranscript, displayedActiveTranscriptIndex, isTimelineScrubbing, transcriptQueryNormalized]);

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
      <div className={`relative grid grid-cols-1 gap-4 items-start ${isTranscriptPaneCollapsed ? '' : 'xl:grid-cols-[minmax(0,1fr)_420px]'}`}>
        <div className="space-y-4">
          {sourceMode === 'none' ? (
            <div className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Preview and Trim</div>
                <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  Awaiting source
                </span>
              </div>

              <div
                className="relative w-full rounded-xl overflow-hidden bg-black/85 border border-slate-200/20 dark:border-slate-700/40"
                style={{ height: `${previewMonitorHeight}px` }}
              >
                <img
                  src={churchOfFunLogo}
                  alt="Church of Fun"
                  className="h-full w-full object-contain"
                />
                <div className="absolute inset-x-4 bottom-4 z-10 flex justify-center">
                  <div className="rounded-xl border border-white/15 bg-black/60 px-4 py-2 text-center text-xs font-semibold text-slate-100 backdrop-blur-[1px]">
                    Load a source to begin transcript prep, sync, and edit.
                  </div>
                </div>
              </div>

              <div className="text-xs text-slate-500 dark:text-slate-400">
                {status}
              </div>
            </div>
          ) : null}

          {sourceMode === 'multicam' ? (
            <div className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 p-4 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Two-Camera Podcast Prep</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Load Camera A and Camera B, sync scratch audio, confirm the sync map, then prepare a Sanctuary package.
                  </div>
                </div>
                <div className="inline-flex items-center gap-2">
                  <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {multicamPrep?.projectName || multicamSource?.projectName || 'Podcast Session'}
                  </span>
                  {isPreparingMulticam ? (
                    <span className="text-xs font-semibold px-2 py-1 rounded-full bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
                      Preparing
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                {[
                  {
                    key: 'camera1',
                    label: 'Camera A Loaded',
                    active: Boolean(multicamPrep?.mediaAssets?.some((asset) => asset.id === 'camera1')),
                  },
                  {
                    key: 'camera2',
                    label: 'Camera B Loaded',
                    active: Boolean(multicamPrep?.mediaAssets?.some((asset) => asset.id === 'camera2')),
                  },
                  {
                    key: 'sync',
                    label: 'Sync Ready',
                    active: multicamPrepPhase === 'ready' || multicamPrepPhase === 'confirmed' || multicamPrepPhase === 'packaged',
                  },
                  {
                    key: 'confirmed',
                    label: 'Sync Confirmed',
                    active: multicamPrepPhase === 'confirmed' || multicamPrepPhase === 'packaged',
                  },
                  {
                    key: 'packaged',
                    label: 'Sanctuary Ready',
                    active: multicamPrepPhase === 'packaged',
                  },
                ].map((item) => (
                  <div
                    key={item.key}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                      item.active
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/80 dark:bg-emerald-900/25 dark:text-emerald-200'
                        : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900/20 dark:text-slate-400'
                    }`}
                  >
                    {item.label}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {(multicamPrep?.mediaAssets || []).map((asset) => (
                  <div key={asset.id} className="rounded-xl border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/60 dark:bg-slate-900/25 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{asset.label}</div>
                      <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                        <input
                          type="radio"
                          name="multicam-master-audio"
                          checked={multicamMasterAudioAssetId === asset.id}
                          onChange={() => handleSetMulticamMasterAudioAssetId(asset.id)}
                        />
                        Master Audio
                      </label>
                    </div>
                    <div className="relative w-full overflow-hidden rounded-xl bg-black/85 border border-slate-200/20 dark:border-slate-700/40" style={{ height: '240px' }}>
                      {asset.previewUrl ? (
                        <video
                          src={asset.previewUrl}
                          controls
                          muted
                          className="h-full w-full object-contain bg-black"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-slate-400">
                          Preview unavailable
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-slate-300">
                      <div>File: <span className="font-semibold text-slate-800 dark:text-slate-100">{asset.fileName}</span></div>
                      <div>Size: <span className="font-semibold text-slate-800 dark:text-slate-100">{formatBytesLabel(asset.sizeBytes)}</span></div>
                      <div>Duration: <span className="font-semibold text-slate-800 dark:text-slate-100">{formatTimestampPrecise(asset.durationSeconds, 2)}</span></div>
                      <div>Frame: <span className="font-semibold text-slate-800 dark:text-slate-100">{asset.width}x{asset.height}</span></div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/30 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Waveform Slip Sync</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Adjust Camera B against Camera A using scratch audio when available. Positive offset means Camera B starts later.
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-3 text-xs">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">
                      Offset {formatTimestampPrecise(multicamManualOffsetSeconds, 2)}s
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">
                      Sync confidence {Math.round((effectiveMulticamSyncMap?.confidence || 0) * 100)}%
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-300/80 dark:border-slate-600/70 bg-white/90 dark:bg-slate-900/30 px-3 py-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Sync By Ear</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Play both camera audio tracks at the same time, then nudge Camera B until the voices line up. Spacebar toggles play and stop.
                      </div>
                    </div>
                    <div className="inline-flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setMulticamListenMode('both')}
                        className={`rounded-md px-3 py-2 text-xs font-semibold ${
                          multicamListenMode === 'both'
                            ? 'bg-primary text-white'
                            : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        Both
                      </button>
                      <button
                        type="button"
                        onClick={() => setMulticamListenMode('camera1')}
                        className={`rounded-md px-3 py-2 text-xs font-semibold ${
                          multicamListenMode === 'camera1'
                            ? 'bg-primary text-white'
                            : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                        }`}
                        >
                        Solo Camera A
                      </button>
                      <button
                        type="button"
                        onClick={() => setMulticamListenMode('camera2')}
                        className={`rounded-md px-3 py-2 text-xs font-semibold ${
                          multicamListenMode === 'camera2'
                            ? 'bg-primary text-white'
                            : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                        }`}
                        >
                        Solo Camera B
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (isMulticamSyncPlaying) {
                          pauseMulticamSyncPlayback('Sync-by-ear playback paused.');
                        } else {
                          void playMulticamSyncPlayback();
                          setStatus('Sync-by-ear playback started. Adjust Camera B offset until both voices line up.');
                        }
                      }}
                      className="inline-flex items-center gap-2 rounded-full bg-slate-900 text-white px-4 py-2 text-sm font-semibold"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        {isMulticamSyncPlaying ? 'pause' : 'play_arrow'}
                      </span>
                      {isMulticamSyncPlaying ? 'Pause Sync' : 'Play Sync'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        pauseMulticamSyncPlayback();
                        setCurrentTime(0);
                        setStatus('Sync-by-ear playback reset to the start of the multicam window.');
                      }}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-300/80 dark:border-slate-600/80 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/40"
                    >
                      <span className="material-symbols-outlined text-[18px]">replay</span>
                      Reset To Start
                    </button>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Program playhead {formatTimestampPrecise(currentTime, 2)}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="space-y-2 md:col-span-2">
                      <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          checked={useMulticamStereoMixAsProjectAudio}
                          onChange={(event) => setUseMulticamStereoMixAsProjectAudio(event.target.checked)}
                        />
                        Use this synced stereo mix as the project audio
                      </span>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        Keeps the current left/right stereo image and the volume balance you set here when this project opens in Sanctuary.
                      </div>
                    </label>

                    <label className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                        <span>Camera A Volume</span>
                        <span>{Math.round(multicamCamera1Volume)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={multicamCamera1Volume}
                        onChange={(event) => setMulticamCamera1Volume(Number(event.target.value || 0))}
                        className="w-full"
                      />
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">Output: left speaker</div>
                    </label>

                    <label className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                        <span>Camera B Volume</span>
                        <span>{Math.round(multicamCamera2Volume)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={multicamCamera2Volume}
                        onChange={(event) => setMulticamCamera2Volume(Number(event.target.value || 0))}
                        className="w-full"
                      />
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">Output: right speaker</div>
                    </label>
                  </div>

                  {(multicamPrep?.mediaAssets || []).map((asset) => (
                    <audio
                      key={`multicam-sync-audio-${asset.id}`}
                      ref={(node) => {
                        multicamSyncAudioRefs.current[asset.id] = node;
                      }}
                      src={asset.previewUrl}
                      preload="auto"
                      className="hidden"
                    />
                  ))}
                </div>

                <div className="rounded-lg border border-slate-300/80 dark:border-slate-600/70 bg-white/90 dark:bg-slate-800/80 p-3 space-y-3">
                  <div className="rounded-lg border border-slate-200/70 dark:border-slate-700/70 bg-slate-50/80 dark:bg-slate-950/40 px-3 py-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Camera A</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Reference waveform</div>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-24 w-full">
                      <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(148,163,184,0.24)" strokeWidth="0.35" />
                      {multicamWaveformFillPathCamera1 ? (
                        <>
                          <path d={multicamWaveformFillPathCamera1} className="fill-[#10228A]/85 dark:fill-cyan-300/65" />
                          <polyline
                            points={multicamWaveformTopStrokeCamera1}
                            fill="none"
                            stroke="rgba(255,255,255,0.42)"
                            strokeWidth="0.28"
                          />
                          <polyline
                            points={multicamWaveformBottomStrokeCamera1}
                            fill="none"
                            stroke="rgba(255,255,255,0.24)"
                            strokeWidth="0.22"
                          />
                        </>
                      ) : (
                        <text x="50" y="54" textAnchor="middle" className="fill-slate-400 text-[7px]">Waveform unavailable</text>
                      )}
                    </svg>
                  </div>

                  <div className="rounded-lg border border-slate-200/70 dark:border-slate-700/70 bg-slate-50/80 dark:bg-slate-950/40 px-3 py-2">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Camera B</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">Shifted by current offset</div>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-24 w-full">
                      <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(148,163,184,0.24)" strokeWidth="0.35" />
                      {multicamWaveformFillPathCamera2 ? (
                        <>
                          <path d={multicamWaveformFillPathCamera2} className="fill-[#A14A00]/80 dark:fill-orange-300/60" />
                          <polyline
                            points={multicamWaveformTopStrokeCamera2}
                            fill="none"
                            stroke="rgba(255,255,255,0.42)"
                            strokeWidth="0.28"
                          />
                          <polyline
                            points={multicamWaveformBottomStrokeCamera2}
                            fill="none"
                            stroke="rgba(255,255,255,0.24)"
                            strokeWidth="0.22"
                          />
                        </>
                      ) : (
                        <text x="50" y="54" textAnchor="middle" className="fill-slate-400 text-[7px]">Waveform unavailable</text>
                      )}
                    </svg>
                  </div>

                  {!multicamWaveformFillPathCamera1 || !multicamWaveformFillPathCamera2 ? (
                    <div className="mt-2 rounded-lg border border-amber-200/80 dark:border-amber-700/70 bg-amber-50/80 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                      Waveform extraction failed for one or both cameras. Manual offset mode is active; review the camera previews and set the sync by eye.
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <input
                    type="range"
                    min="-12"
                    max="12"
                    step="0.02"
                    value={multicamManualOffsetSeconds}
                    onChange={(event) => handleSetMulticamManualOffsetSeconds(Number(event.target.value))}
                    className="flex-1 min-w-[220px] accent-primary"
                  />
                  <button
                    type="button"
                    onClick={() => handleSetMulticamManualOffsetSeconds(Number(multicamPrep?.syncMap?.offsetSeconds || 0))}
                    className="px-3 py-2 rounded-lg border border-slate-300/80 dark:border-slate-600/80 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/40"
                  >
                    Reset To Auto Sync
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/30 p-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">First-Pass Multicam Timeline</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Manual director timeline. Sanctuary will open with one full-length segment and reusable shot presets for Camera A and Camera B.
                    </div>
                  </div>
                  <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {effectiveMulticamTimelineSegments.length} segments
                  </span>
                </div>

                <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-300/80 dark:border-slate-600/70 bg-white/80 dark:bg-slate-900/35 divide-y divide-slate-200/70 dark:divide-slate-700/70">
                  {effectiveMulticamTimelineSegments.length > 0 ? (
                    effectiveMulticamTimelineSegments.map((segment) => (
                      <div key={segment.id} className="flex items-center justify-between gap-4 px-3 py-2 text-xs">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 dark:text-slate-100">
                            {String(segment.shotId || '1A')}
                          </div>
                          <div className="text-slate-500 dark:text-slate-400">
                            {formatTimestampPrecise(segment.startSeconds, 2)} - {formatTimestampPrecise(segment.endSeconds, 2)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="px-2 py-1 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                            manual
                          </span>
                          {segment.silenceCandidate ? (
                            <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                              Silence trim
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
                      Timeline segments will appear after multicam prep finishes.
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Review the waveforms first. Confirm sync to lock the current offset and master audio, then prepare the Sanctuary package.
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={handleConfirmMulticamSync}
                    disabled={!multicamPrep || isPreparingMulticam}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-300/80 dark:border-slate-600/80 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/40 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">task_alt</span>
                    Confirm Sync
                  </button>
                  <button
                    type="button"
                    onClick={handlePrepareMulticamPackage}
                    disabled={!multicamPrep || multicamPrepPhase !== 'confirmed' || isPreparingMulticamPackage}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-300/80 dark:border-slate-600/80 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/40 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {isPreparingMulticamPackage ? 'progress_activity' : 'inventory_2'}
                    </span>
                    {isPreparingMulticamPackage ? 'Preparing Package...' : 'Prepare Sanctuary Package'}
                  </button>
                  <button
                    type="button"
                    onClick={handleSendMulticamToSanctuary}
                    disabled={!multicamPreparedDraft || isPreparingMulticam || isPreparingMulticamPackage || isSendingMulticamToSanctuary}
                    className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-primary to-accent-neon px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-primary/30 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {isSendingMulticamToSanctuary ? 'progress_activity' : 'movie_edit'}
                    </span>
                    {isSendingMulticamToSanctuary ? 'Opening Sanctuary...' : 'Open In Sanctuary'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {(sourceMode === 'file' && localVideoUrl)
            || isPrecisionPreviewActive
            || (sourceMode === 'url' && isYouTubeSource && youtubeVideoId) ? (
            <div
              ref={focusEditSurfaceRef}
              className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 p-4 space-y-3"
            >
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
                  <button
                    type="button"
                    onClick={() => toggleTranscriptPaneCollapsed()}
                    className="text-xs font-semibold px-2.5 py-1 rounded-full border border-slate-300/80 dark:border-slate-600/80 text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/40"
                    title={isTranscriptPaneCollapsed ? 'Show transcript pane' : 'Hide transcript pane'}
                  >
                    {isTranscriptPaneCollapsed ? 'Show Transcript' : 'Hide Transcript'}
                  </button>
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

              <div className="space-y-2">
                <div
                  ref={previewOverlayRef}
                  className="relative w-full rounded-xl overflow-hidden bg-black/80 select-none"
                  style={{ height: `${previewMonitorHeight}px` }}
                >
                  {previewVideoUrl && (
                    <video
                      ref={videoRef}
                      src={previewVideoUrl}
                      controls={!isPrecisionAligning}
                      className="w-full h-full rounded-xl bg-black/70 object-contain"
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

                <div className="flex items-center justify-between gap-3 px-1">
                  <div className="text-[11px] text-slate-600 dark:text-slate-300">
                    Preview Height {Math.round(previewMonitorHeight)}px
                  </div>
                  <div
                    role="slider"
                    tabIndex={0}
                    aria-label="Resize preview monitor"
                    aria-valuemin={220}
                    aria-valuemax={680}
                    aria-valuenow={Math.round(previewMonitorHeight)}
                    className="flex-1 max-w-44 h-3 rounded-full border border-slate-300/80 dark:border-slate-600/70 bg-slate-200/70 dark:bg-slate-800/80 cursor-ns-resize flex items-center px-1 touch-none"
                    onPointerDown={startPreviewResize}
                    onPointerMove={handlePreviewResizeMove}
                    onPointerUp={handlePreviewResizeEnd}
                    onPointerCancel={handlePreviewResizeEnd}
                    onLostPointerCapture={finishPreviewResize}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        setPreviewMonitorHeight((current) => Math.min(680, current + 20));
                      }
                      if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
                        event.preventDefault();
                        setPreviewMonitorHeight((current) => Math.max(220, current - 20));
                      }
                    }}
                  >
                    <div className="w-full h-1 rounded-full bg-slate-400/70 dark:bg-slate-500/70 relative">
                      <div
                        className="absolute top-1/2 -translate-y-1/2 h-3.5 w-8 rounded-full bg-primary shadow"
                        style={{ left: `${((previewMonitorHeight - 220) / (680 - 220)) * 100}%`, transform: 'translate(-50%, -50%)' }}
                      />
                    </div>
                  </div>
                </div>
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
                    <span>{trimRangeSummaryLabel}</span>
                  </div>
                </div>

                <div
                  ref={trimTimelineRef}
                  data-trim-track
                  tabIndex={0}
                  aria-label="Trim timeline"
                  className={`relative h-28 rounded-lg border border-slate-300/80 dark:border-slate-600/70 bg-white/90 dark:bg-slate-800/80 overflow-hidden select-none cursor-ew-resize ${isPrecisionAligning ? 'opacity-70 pointer-events-none' : ''}`}
                  onPointerDown={handleTimelinePointerDown}
                  onPointerMove={handleTimelinePointerMove}
                  onPointerUp={handleTimelinePointerUp}
                  onPointerCancel={handleTimelinePointerCancel}
                  onLostPointerCapture={finishTimelineScrub}
                  onDoubleClick={focusTimelineEditWorkspace}
                  >
                    <div className="absolute inset-x-1 top-1 z-20 h-9 border-b border-slate-200/80 dark:border-slate-700/70 bg-white/75 dark:bg-slate-950/35">
                      {visibleQaWordBlocks.map((word) => (
                        <button
                          key={word.id}
                          type="button"
                          onPointerDown={(event) => startQaWordDrag(event, word.index)}
                          onLostPointerCapture={finishQaWordDrag}
                          className={`absolute top-0 h-7 rounded-md border px-1 font-semibold truncate shadow-sm transition-colors ${
                            word.isActive
                              ? 'border-amber-300 text-slate-950'
                              : word.isInActivePhrase
                                ? 'border-sky-300/70 text-sky-900 dark:text-sky-100'
                                : 'border-slate-300/70 text-slate-700 dark:border-slate-600 dark:text-slate-200'
                          }`}
                          style={{
                            left: `${word.leftPercent}%`,
                            width: `${word.widthPercent}%`,
                            minWidth: '22px',
                            borderLeftWidth: '3px',
                            borderRightWidth: '1px',
                            background: word.isActive
                              ? 'linear-gradient(90deg, rgba(251,191,36,0.92) 0%, rgba(251,191,36,0.55) 48%, rgba(251,191,36,0.08) 100%)'
                              : word.isInActivePhrase
                                ? 'linear-gradient(90deg, rgba(56,189,248,0.55) 0%, rgba(56,189,248,0.24) 52%, rgba(56,189,248,0.04) 100%)'
                                : 'linear-gradient(90deg, rgba(203,213,225,0.92) 0%, rgba(203,213,225,0.46) 54%, rgba(203,213,225,0.05) 100%)',
                            fontSize: word.widthPercent < 2
                              ? '8px'
                              : word.widthPercent < 3.2
                                ? '9px'
                                : word.widthPercent < 5
                                  ? '10px'
                                  : '11px',
                            lineHeight: 1.05,
                          }}
                          title={`${word.text} • ${formatTrimTimeLabel(word.startSeconds)} - ${formatTrimTimeLabel(word.endSeconds)}`}
                        >
                          {word.text}
                        </button>
                      ))}
                    </div>
                    <div className="absolute inset-x-0 bottom-0 top-[40px] z-0 pointer-events-none">
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
                  {hasRegionEditSource && visibleClipEditRegions.length > 0 && (
                    <div className="absolute inset-x-1 bottom-1 z-10 h-5">
                      {visibleClipEditRegions.map((region) => (
                        <button
                          key={region.id}
                          type="button"
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            selectEditRegion(region.id);
                          }}
                          className={`absolute bottom-0 h-5 rounded-md border text-[9px] font-bold tracking-wide px-1 text-white shadow-sm transition-colors ${
                            region.isSelected
                              ? 'border-amber-200 bg-amber-500/90'
                              : 'border-sky-300/60 bg-sky-700/70 hover:bg-sky-600/80'
                          }`}
                          style={{
                            left: `${region.leftPercent}%`,
                            width: `${region.widthPercent}%`,
                            minWidth: '18px',
                          }}
                          title={`Region ${region.index + 1}: ${formatTrimTimeLabel(region.startSeconds)} - ${formatTrimTimeLabel(region.endSeconds)}`}
                        >
                          <span className="block truncate">R{region.index + 1}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div
                    className="absolute top-0 bottom-0 z-20 w-[2px] bg-primary/95 pointer-events-none"
                    style={{ left: `${trimStartPercent}%` }}
                    title="In point"
                  />

                  <div
                    className="absolute top-0 bottom-0 z-20 w-[2px] bg-primary/95 pointer-events-none"
                    style={{ left: `${trimEndPercent}%` }}
                    title="Out point"
                  />

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
                      onClick={() => setTrimZoomAroundAnchor(trimZoomLevel - 0.5, clampedCurrentSeconds, 0.5)}
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
                      onChange={(event) => setTrimZoomAroundAnchor(Number(event.target.value), clampedCurrentSeconds, 0.5)}
                      className="w-28 accent-primary"
                      aria-label="Trim timeline zoom"
                      disabled={isPrecisionAligning}
                    />
                    <button
                      type="button"
                      onClick={() => setTrimZoomAroundAnchor(trimZoomLevel + 0.5, clampedCurrentSeconds, 0.5)}
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
                    <button
                      type="button"
                      onClick={() => {
                        const nextValue = !isTrimEditMode;
                        setIsTrimEditMode(nextValue);
                        if (nextValue) {
                          try {
                            trimTimelineRef.current?.focus?.({ preventScroll: true });
                          } catch {
                            trimTimelineRef.current?.focus?.();
                          }
                          setStatus(editModeStatusMessage);
                        } else {
                          setIsFocusEditMode(false);
                          setStatus('Edit mode off. Timeline wheel/shortcut capture is disabled.');
                        }
                      }}
                      className={`px-2.5 h-7 rounded-md border font-semibold transition-colors ${
                        isTrimEditMode
                          ? 'border-emerald-400 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                      title="Toggle trim edit mode"
                      disabled={isPrecisionAligning}
                    >
                      {isTrimEditMode ? 'Edit On' : 'Edit Off'}
                    </button>
                  </div>

                </div>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap rounded-lg bg-black/65 border border-white/20 px-3 py-2 text-[11px] text-slate-100">
                <span>Current {formatTrimTimeLabel(clampedCurrentSeconds)}</span>
                <div className="inline-flex items-center gap-2">
                  <button
                    onClick={() => cutAtCurrentPlayhead('start')}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                    title={hasRegionEditSource ? 'Set selected region In point at current playhead' : 'Set In point at current playhead'}
                  >
                    {hasRegionEditSource ? 'Set Region In' : 'Set In'}
                  </button>
                  <button
                    onClick={() => cutAtCurrentPlayhead('end')}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                    title={hasRegionEditSource ? 'Set selected region Out point at current playhead' : 'Set Out point at current playhead'}
                  >
                    {hasRegionEditSource ? 'Set Region Out' : 'Set Out'}
                  </button>
                  <span className="px-2 py-1 rounded-md bg-white/10 text-[10px] font-semibold tracking-wide">
                    {trimShortcutPrimaryLabel}
                  </span>
                  <span className="px-2 py-1 rounded-md bg-white/10 text-[10px] font-semibold tracking-wide">
                    {trimShortcutInLabel}
                  </span>
                  <span className="px-2 py-1 rounded-md bg-white/10 text-[10px] font-semibold tracking-wide">
                    {trimShortcutOutLabel}
                  </span>
                  {hasRegionEditSource && (
                    <>
                      <span className="px-2 py-1 rounded-md bg-white/10 text-[10px] font-semibold tracking-wide">
                        {'Delete -> Remove'}
                      </span>
                      <span className="px-2 py-1 rounded-md bg-white/10 text-[10px] font-semibold tracking-wide">
                        {'Ctrl+J -> Join'}
                      </span>
                    </>
                  )}
                  {hasRegionEditSource && (
                    <>
                      <button
                        onClick={() => splitSelectedEditRegionAtPlayhead(
                          isFiniteNumber(currentTime) ? Number(currentTime) : normalizedRangeStart
                        )}
                        disabled={!canSplitSelectedEditRegion || isPrecisionAligning}
                        className="bg-amber-500/90 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                        title="Split selected region at playhead"
                      >
                        Split
                      </button>
                      <button
                        onClick={deleteSelectedEditRegion}
                        disabled={!canDeleteSelectedEditRegion || isPrecisionAligning}
                        className="bg-rose-500/90 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                        title="Remove selected region"
                      >
                        Delete Region
                      </button>
                      <button
                        onClick={joinSelectedEditRegion}
                        disabled={!canJoinSelectedEditRegion || isPrecisionAligning}
                        className="bg-emerald-500/90 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                        title="Join selected region with an adjacent split"
                      >
                        Join
                      </button>
                    </>
                  )}
                  <button
                    onClick={seekClipInPoint}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                    title={hasRegionEditSource ? 'Move playhead to selected region start' : 'Move playhead to trim start'}
                  >
                    {hasRegionEditSource ? 'Go To Region In' : 'Go To In'}
                  </button>
                  <button
                    onClick={seekClipOutPoint}
                    disabled={sourceMode === 'none' || !hasValidRange || isPrecisionAligning}
                    className="bg-white/15 text-white px-2.5 py-1.5 rounded-md text-[11px] font-semibold disabled:opacity-50"
                    title={hasRegionEditSource ? 'Move playhead to selected region end' : 'Move playhead to trim end'}
                  >
                    {hasRegionEditSource ? 'Go To Region Out' : 'Go To Out'}
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
                            setClipEditRegions([]);
                            setSelectedEditRegionId('');
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
                      : hasRegionEditSource
                        ? 'Render Edited Clip'
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

              <div className="rounded-lg border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 px-3 py-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Studio Transcript Edit</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      Edit clip text before render. Apply Text + Reflow rebuilds timed caption cues for preview and output.
                    </div>
                  </div>
                  <span className={`text-[11px] font-semibold px-2 py-1 rounded-md ${
                    hasStudioCaptionQaEdit
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                  }`}>
                    {hasStudioCaptionQaEdit ? 'Studio edits active' : 'Using source text'}
                  </span>
                </div>
                <textarea
                  value={studioTranscriptEditDraft}
                  onChange={(event) => setStudioTranscriptEditDraft(event.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  placeholder="Edit the selected clip transcript here"
                />
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Source: {normalizedStudioTranscriptSourceText || normalizedStudioTranscriptDraftText ? 'selection text loaded' : 'no transcript text loaded yet'}
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={resetStudioTranscriptEdit}
                      disabled={!normalizedStudioTranscriptSourceText}
                      className="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                    >
                      Reset to Source
                    </button>
                    <button
                      type="button"
                      onClick={applyStudioTranscriptEdit}
                      disabled={!normalizedStudioTranscriptDraftText}
                      className="rounded-md bg-primary text-white px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
                    >
                      Apply Text + Reflow
                    </button>
                  </div>
                </div>
              </div>

              <div className="text-xs text-slate-500 dark:text-slate-400">
                {trimInstructionCopy}
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

        {sourceMode !== 'multicam' && !isTranscriptPaneCollapsed ? (
        <aside className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 flex flex-col min-h-[480px] max-h-[72vh]">
          <div className="p-4 border-b border-slate-200/70 dark:border-slate-700/70 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Transcript Pane</div>
              <div className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    toggleTranscriptPaneCollapsed(true);
                    setIsFocusEditMode(true);
                  }}
                  className="px-2.5 py-2 rounded-lg border border-slate-300/80 dark:border-slate-600/80 text-xs font-bold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/40"
                  title="Collapse transcript pane"
                  aria-label="Collapse transcript pane"
                >
                  <span className="material-symbols-outlined text-[16px] align-middle">right_panel_close</span>
                </button>
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
        ) : null}
      </div>

      {sourceMode !== 'multicam' && isTranscriptPaneCollapsed ? (
        <button
          type="button"
          onClick={() => toggleTranscriptPaneCollapsed(false)}
          className="hidden xl:flex fixed right-0 top-1/2 z-50 h-16 w-11 -translate-y-1/2 items-center justify-center rounded-l-2xl border border-r-0 border-slate-300/80 dark:border-slate-600/80 bg-white/95 dark:bg-slate-900/95 text-slate-700 dark:text-slate-200 shadow-xl backdrop-blur-sm"
          title="Show transcript pane"
          aria-label="Show transcript pane"
        >
          <span className="material-symbols-outlined text-[18px]">right_panel_open</span>
        </button>
      ) : null}

      {status && (
        <div className={`rounded-xl border px-3 py-2 text-xs ${statusToneClass}`}>
          {status}
        </div>
      )}

      <div className="rounded-xl border border-slate-300/80 dark:border-slate-600/70 bg-slate-50/80 dark:bg-slate-950/30 px-3 py-2 text-[11px] text-slate-700 dark:text-slate-200 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">Dev Status</div>
          <button
            type="button"
            onClick={() => setShowDevStatus((value) => !value)}
            className="text-[11px] font-semibold text-primary hover:underline"
          >
            {showDevStatus ? 'Hide' : 'Show'}
          </button>
        </div>
        <div>rows {transcriptSegments.length} • source {sourceMode}</div>
        <div>
          check={isCheckingTranscriptAvailability ? 'yes' : 'no'} • transcribing={isTranscribing ? 'yes' : 'no'} • mode={transcriptLoadMode} • availability={transcriptAvailability?.status || 'idle'}
        </div>
        {showDevStatus && (
          <div className="max-h-28 overflow-y-auto border border-slate-300/70 dark:border-slate-700/70 rounded-md bg-white/70 dark:bg-slate-900/50 px-2 py-1.5 space-y-1">
            {devStatusLines.length > 0 ? (
              devStatusLines.map((line, index) => (
                <div key={`dev-status-${index}`} className="text-[11px] break-words">{line}</div>
              ))
            ) : (
              <div className="text-slate-500 dark:text-slate-400">No debug entries yet.</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

export default ManualClipLab;
