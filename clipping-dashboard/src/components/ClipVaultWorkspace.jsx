import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import {
  buildReflowedCaptionCues,
  normalizeCaptionEditorText,
  normalizeCaptionEditorCues,
} from '../lib/captionEditor';
import { createDefaultMulticamShotPresets, getMulticamCameraIdForShotId } from '../lib/multicamProject';
import {
  DEFAULT_SPEECH_CLEANUP_PRESET,
  SPEECH_CLEANUP_PRESET_OPTIONS,
  createDefaultDialogueTrackDefaults,
  normalizeDialogueTrackDefaults,
  normalizeSpeechCleanupMode,
  normalizeSpeechCleanupPreset,
  resolveEffectiveSpeechCleanup,
} from '../lib/speechCleanup';

const DND_PAYLOAD_KEY = 'application/x-clip-vault';
const MEDIA_BIN_MIN_WIDTH = 240;
const MEDIA_BIN_MAX_WIDTH = 520;
const MONITOR_MIN_HEIGHT = 240;
const MONITOR_MAX_HEIGHT = 760;
const TRIM_MIN_GAP_SECONDS = 0.1;
const TRIM_HANDLE_WIDTH_PX = 10;
const MAX_TIMELINE_RENDER_ITEMS = 100;
const TIMELINE_BASE_PX_PER_SECOND = 24;
const TIMELINE_MIN_PX_PER_SECOND = 8;
const TIMELINE_MAX_PX_PER_SECOND = 260;
const TIMELINE_ROW_HEIGHT_PX = 94;
const TIMELINE_RULER_HEIGHT_PX = 28;
const PROGRAM_PREVIEW_DEFAULT_RECT = {
  x: 96,
  y: 96,
  width: 720,
  height: 405,
};
const PROGRAM_RENDER_WIDTH = 1280;
const PROGRAM_RENDER_HEIGHT = 720;
const PROGRAM_RENDER_FPS = 30;
const CAPTION_STYLE_OPTIONS = [
  { value: 'reel-bold', label: 'Reel Bold' },
  { value: 'pop-punch', label: 'Pop Punch' },
  { value: 'paint-reveal', label: 'Paint Reveal' },
  { value: 'clean-lower', label: 'Clean Lower' },
  { value: 'minimal', label: 'Minimal' },
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeCaptionText = (value) => {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const splitCaptionWords = (value) => {
  return normalizeCaptionText(value)
    .split(' ')
    .filter(Boolean)
    .slice(0, 24);
};

const getCaptionOverlayClassName = (stylePreset) => {
  const value = String(stylePreset || '').trim();
  if (value === 'pop-punch') {
    return 'max-w-[78%] rounded-xl border border-white/20 bg-fuchsia-950/70 px-3 py-2 shadow-lg shadow-fuchsia-950/40 backdrop-blur-[1px]';
  }
  if (value === 'paint-reveal') {
    return 'max-w-[78%] rounded-xl border border-cyan-300/35 bg-slate-950/78 px-3 py-2 shadow-lg shadow-cyan-950/30 backdrop-blur-[1px]';
  }
  if (value === 'clean-lower') {
    return 'max-w-[82%] rounded-lg border border-white/12 bg-black/58 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur-[1px]';
  }
  if (value === 'minimal') {
    return 'max-w-[82%] rounded-md bg-black/42 px-3 py-2 shadow-lg shadow-black/30 backdrop-blur-[1px]';
  }
  return 'max-w-[78%] rounded-xl border border-white/20 bg-black/70 px-3 py-2 shadow-lg shadow-black/50 backdrop-blur-[1px]';
};

const getCaptionWordClassName = ({ stylePreset, isActive }) => {
  const value = String(stylePreset || '').trim();
  if (value === 'paint-reveal') {
    return isActive
      ? 'text-cyan-200 scale-110 font-extrabold drop-shadow-[0_0_7px_rgba(103,232,249,0.65)]'
      : 'text-cyan-50/92 font-semibold';
  }
  if (value === 'minimal') {
    return isActive
      ? 'text-white scale-105 font-bold'
      : 'text-white/80 font-medium';
  }
  if (value === 'clean-lower') {
    return isActive
      ? 'text-amber-200 scale-105 font-bold drop-shadow-[0_0_5px_rgba(253,230,138,0.45)]'
      : 'text-white/92 font-semibold';
  }
  return isActive
    ? 'text-amber-300 scale-110 font-extrabold drop-shadow-[0_0_6px_rgba(251,191,36,0.75)]'
    : 'text-white/95 font-semibold';
};

const parseTimestampToSeconds = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (!raw.includes(':')) {
    const direct = Number(raw.replace(',', '.'));
    return Number.isFinite(direct) ? Math.max(0, direct) : null;
  }

  const parts = raw.split(':').map((part) => Number(String(part).trim().replace(',', '.')));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
};

const formatDurationLabel = (startTimestamp, endTimestamp) => {
  const start = parseTimestampToSeconds(startTimestamp);
  const end = parseTimestampToSeconds(endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '--';

  const total = Math.floor(end - start);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatSecondsLabel = (secondsRaw) => {
  const seconds = Number(secondsRaw);
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
};

const formatTimelineTickLabel = (secondsRaw) => {
  const seconds = Number(secondsRaw);
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
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

const parseDragPayload = (event) => {
  try {
    const raw = event.dataTransfer?.getData(DND_PAYLOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
};

const sanitizeFileNamePart = (value, fallback = 'item') => {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
  return normalized || fallback;
};

const getClipDurationSeconds = (clip) => {
  const directDuration = Number(clip?.durationSeconds);
  if (Number.isFinite(directDuration) && directDuration > 0) return directDuration;

  const selectionStart = Number(clip?.selectionStartSeconds);
  const selectionEnd = Number(clip?.selectionEndSeconds);
  if (
    Number.isFinite(selectionStart)
    && Number.isFinite(selectionEnd)
    && selectionEnd > selectionStart
  ) {
    return selectionEnd - selectionStart;
  }

  if (Array.isArray(clip?.captionCues) && clip.captionCues.length > 0) {
    const starts = clip.captionCues
      .map((cue) => Number(cue?.startSeconds))
      .filter(Number.isFinite);
    const ends = clip.captionCues
      .map((cue) => Number(cue?.endSeconds))
      .filter(Number.isFinite);
    if (starts.length > 0 && ends.length > 0) {
      const cueStart = Math.max(0, Math.min(...starts));
      const cueEnd = Math.max(...ends);
      if (cueEnd > cueStart) return cueEnd - cueStart;
    }
  }

  const startSeconds = parseTimestampToSeconds(clip?.startTimestamp);
  const endSeconds = parseTimestampToSeconds(clip?.endTimestamp);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return null;
  return endSeconds - startSeconds;
};

const getTimelineEntryTrimRange = (entry) => {
  const clipDuration = getClipDurationSeconds(entry?.clip);
  const rawStart = Number(entry?.item?.trimStartSeconds);
  const start = Number.isFinite(rawStart) && rawStart >= 0 ? rawStart : 0;

  const rawEnd = Number(entry?.item?.trimEndSeconds);
  let end = Number.isFinite(rawEnd) ? rawEnd : clipDuration;

  if (Number.isFinite(clipDuration)) {
    end = Number.isFinite(end) ? Math.min(end, clipDuration) : clipDuration;
  }

  if (!Number.isFinite(end) || end <= start) {
    end = start + TRIM_MIN_GAP_SECONDS;
  }

  return {
    start,
    end,
    clipDuration,
  };
};

const getTimelineEntryTrimmedDuration = (entry) => {
  const range = getTimelineEntryTrimRange(entry);
  return Math.max(0, range.end - range.start);
};

const normalizeClipCaptionCues = (clip) => {
  if (!Array.isArray(clip?.captionCues)) return [];
  return clip.captionCues
    .map((cue, index) => {
      const text = normalizeCaptionText(cue?.text || '');
      const startSeconds = Number(cue?.startSeconds);
      const endSeconds = Number(cue?.endSeconds);
      if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }
      return {
        id: String(cue?.id || `cue-${index + 1}`),
        text,
        startSeconds,
        endSeconds,
        words: Array.isArray(cue?.words)
          ? cue.words
            .map((word, wordIndex) => {
              const wordText = normalizeCaptionText(word?.text || '');
              const wordStart = Number(word?.startSeconds);
              const wordEnd = Number(word?.endSeconds);
              if (!wordText || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart) {
                return null;
              }
              return {
                id: String(word?.id || `${cue?.id || `cue-${index + 1}`}-word-${wordIndex + 1}`),
                text: wordText,
                startSeconds: wordStart,
                endSeconds: wordEnd,
              };
            })
            .filter(Boolean)
          : [],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .slice(0, 500);
};

const getClipActiveCaptionCues = (clip) => {
  const editedCues = normalizeClipCaptionCues({ captionCues: clip?.captionCuesEdited });
  if (editedCues.length > 0) return editedCues;
  const originalCues = normalizeClipCaptionCues({ captionCues: clip?.captionCuesOriginal || clip?.captionCues });
  return originalCues;
};

const getClipOriginalCaptionCues = (clip) => {
  return normalizeCaptionEditorCues(clip?.captionCuesOriginal || clip?.captionCues);
};

const buildCaptionPayloadForEntry = (entry, { preferOverride = true } = {}) => {
  const range = getTimelineEntryTrimRange(entry);
  const clipDuration = Math.max(0.1, range.end - range.start);
  const item = entry?.item || {};
  const clip = entry?.clip || {};

  if (item.captionEnabled === false) {
    return {
      enabled: false,
      stylePreset: String(item.captionStylePreset || clip.captionStylePreset || 'reel-bold'),
      cues: [],
    };
  }

  const stylePreset = String(item.captionStylePreset || clip.captionStylePreset || 'reel-bold');
  const overrideText = normalizeCaptionText(item.captionTextOverride || '');
  if (preferOverride && overrideText) {
    return {
      enabled: true,
      stylePreset,
      cues: [{
        id: 'override',
        text: overrideText,
        startSeconds: 0,
        endSeconds: Number(clipDuration.toFixed(2)),
      }],
    };
  }

  const sourceCues = getClipActiveCaptionCues(clip);
  const cues = sourceCues
    .map((cue, index) => {
      const overlapStart = Math.max(range.start, cue.startSeconds);
      const overlapEnd = Math.min(range.end, cue.endSeconds);
      if (!Number.isFinite(overlapStart) || !Number.isFinite(overlapEnd) || overlapEnd <= overlapStart) return null;
      const words = Array.isArray(cue.words)
        ? cue.words
          .map((word, wordIndex) => {
            const wordStart = Math.max(range.start, Number(word?.startSeconds));
            const wordEnd = Math.min(range.end, Number(word?.endSeconds));
            const wordText = normalizeCaptionText(word?.text || '');
            if (!wordText || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart) return null;
            return {
              id: String(word?.id || `${cue.id || `cue-${index + 1}`}-word-${wordIndex + 1}`),
              text: wordText,
              startSeconds: Number((wordStart - range.start).toFixed(2)),
              endSeconds: Number((wordEnd - range.start).toFixed(2)),
            };
          })
          .filter(Boolean)
        : [];
      return {
        id: `${cue.id || `cue-${index + 1}`}`,
        text: cue.text,
        startSeconds: Number((overlapStart - range.start).toFixed(2)),
        endSeconds: Number((overlapEnd - range.start).toFixed(2)),
        words,
      };
    })
    .filter(Boolean);

  if (cues.length > 0) {
    return {
      enabled: true,
      stylePreset,
      cues,
    };
  }

  const fallbackText = normalizeCaptionText(
    item.captionConfirmedText
    || clip.transcriptEditedText
    || clip.transcriptSelectedText
    || clip.transcriptOriginalText
    || clip.transcriptSnippet
    || clip.description
    || clip.title
  );
  if (!fallbackText) {
    return {
      enabled: true,
      stylePreset,
      cues: [],
    };
  }

  return {
    enabled: true,
    stylePreset,
    cues: [{
      id: 'fallback',
      text: fallbackText,
      startSeconds: 0,
      endSeconds: Number(clipDuration.toFixed(2)),
    }],
  };
};

const getClipPlaybackUrl = (clip) => String(clip?.playbackUrl || clip?.downloadUrl || '').trim();
const getClipRenderUrl = (clip) => String(clip?.renderDownloadUrl || clip?.downloadUrl || '').trim();
const getProjectAssetOffsetSeconds = (project, assetId) => {
  if (!project?.syncMap?.cameraOffsets || typeof project.syncMap.cameraOffsets !== 'object') return 0;
  return Number(project.syncMap.cameraOffsets[String(assetId || '')] || 0);
};

const getMulticamSegmentShotId = (segment) => {
  return String(segment?.manualShotId || segment?.shotId || '').trim().toUpperCase() || '1A';
};

const getMulticamActiveCameraId = (segment) => {
  return String(segment?.manualCameraId || segment?.cameraId || getMulticamCameraIdForShotId(getMulticamSegmentShotId(segment)) || 'camera1');
};

const getShotPanLimit = (zoomRaw) => {
  const zoom = clamp(Number(zoomRaw || 1), 1, 3);
  return clamp((zoom - 1) * 90, 0, 120);
};

const getShotTransformStyle = (preset) => {
  const zoom = clamp(Number(preset?.zoom || 1), 1, 3);
  const panLimit = getShotPanLimit(zoom);
  const panX = clamp(Number(preset?.panX || 0), -panLimit, panLimit);
  const panY = clamp(Number(preset?.panY || 0), -panLimit, panLimit);
  return {
    transform: `translate(${panX}%, ${panY}%) scale(${zoom})`,
    transformOrigin: 'center center',
  };
};

const drawProgramShotFrame = ({ canvas, video, preset }) => {
  const context = canvas?.getContext?.('2d');
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#020617';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!video) return;

  const sourceWidth = Number(video?.videoWidth || 0);
  const sourceHeight = Number(video?.videoHeight || 0);
  const outputWidth = Math.max(1, Number(canvas.width || 0));
  const outputHeight = Math.max(1, Number(canvas.height || 0));
  if (!sourceWidth || !sourceHeight || !outputWidth || !outputHeight) return;

  const containScale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const baseWidth = sourceWidth * containScale;
  const baseHeight = sourceHeight * containScale;
  const zoom = clamp(Number(preset?.zoom || 1), 1, 3);
  const panLimit = getShotPanLimit(zoom);
  const panX = clamp(Number(preset?.panX || 0), -panLimit, panLimit);
  const panY = clamp(Number(preset?.panY || 0), -panLimit, panLimit);
  const panPixelsX = (panX / 100) * baseWidth;
  const panPixelsY = (panY / 100) * baseHeight;

  context.save();
  context.translate((outputWidth / 2) + panPixelsX, (outputHeight / 2) + panPixelsY);
  context.scale(zoom, zoom);
  context.drawImage(
    video,
    -baseWidth / 2,
    -baseHeight / 2,
    baseWidth,
    baseHeight,
  );
  context.restore();
};

const getSupportedProgramRecorderMimeType = () => {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) || '';
};

const clampPan = (value) => clamp(Number(value), -1, 1);

const buildSpeechCleanupPreviewKey = ({ token, preset }) => {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return '';
  return `${normalizedToken}|${normalizeSpeechCleanupPreset(preset)}`;
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

const formatShotPresetLabel = (shotId) => {
  const normalized = String(shotId || '').trim().toUpperCase();
  const match = normalized.match(/^(\d+)([A-Z])$/);
  if (!match) return normalized || '--';
  return `${match[2]}${match[1]}`;
};

const InlineHelpTooltip = ({ label = 'Help', text = '', align = 'center' }) => {
  const alignmentClassName = align === 'left'
    ? 'left-0 translate-x-0'
    : align === 'right'
      ? 'right-0 translate-x-0'
      : 'left-1/2 -translate-x-1/2';

  return (
    <span className="relative inline-flex items-center group">
      <button
        type="button"
        tabIndex={0}
        aria-label={label}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300/80 dark:border-slate-600/80 bg-white/85 dark:bg-slate-900/85 text-[11px] font-bold text-slate-600 dark:text-slate-300 transition-colors hover:border-primary/70 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        ?
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-30 ${alignmentClassName} top-full mt-2 hidden w-64 rounded-lg border border-slate-300/80 dark:border-slate-700/80 bg-white/95 dark:bg-slate-950/95 px-3 py-2 text-[11px] font-medium leading-relaxed text-slate-700 dark:text-slate-200 shadow-xl shadow-black/15 group-hover:block group-focus-within:block`}
      >
        {text}
      </span>
    </span>
  );
};

const ClipVaultWorkspace = ({
  clips = [],
  montageProjects = [],
  selectedProjectId = '',
  onSelectedProjectChange,
  onCreateProject,
  onRenameProject,
  onExportProject,
  onDeleteProject,
  onFlushProjectMedia,
  onAddClipToProject,
  onMoveTimelineItem,
  onUpdateClip,
  onUpdateProject,
  onUpdateTimelineItem,
  mediaStats = { totalBytes: 0, clipCount: 0 },
}) => {
  const previewRef = useRef(null);
  const multicamPreviewRefs = useRef({});
  const multicamPreviewAnimationRef = useRef(null);
  const multicamAudioRefs = useRef({});
  const multicamAudioContextRef = useRef(null);
  const multicamAudioNodesRef = useRef({});
  const multicamProgramSecondsRef = useRef(0);
  const programPreviewCanvasRef = useRef(null);
  const programPreviewAnimationRef = useRef(null);
  const programPreviewWindowDragRef = useRef(null);
  const programPreviewWindowResizeRef = useRef(null);
  const directorShotDragRef = useRef(null);
  const directorSuiteSurfaceRef = useRef(null);
  const directorPaneRefs = useRef({});
  const timelineTrackRef = useRef(null);
  const timelineScrollerRef = useRef(null);
  const paneResizeStateRef = useRef(null);
  const trimDragStateRef = useRef(null);
  const timelinePlayheadDragRef = useRef(null);
  const timelineAutoPlayRef = useRef(false);
  const timelineAdvanceThrottleRef = useRef(0);
  const selectedPreviewAutoPlayRef = useRef(false);

  const [sidebarPortalNode, setSidebarPortalNode] = useState(null);
  const [sidebarBottomPortalNode, setSidebarBottomPortalNode] = useState(null);
  useEffect(() => {
    setSidebarPortalNode(document.getElementById('vault-sidebar-portal-target'));
    setSidebarBottomPortalNode(document.getElementById('vault-sidebar-portal-bottom-target'));
  }, []);

  const [newProjectName, setNewProjectName] = useState('');
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [localStatus, setLocalStatus] = useState('');
  const [mediaSearchQuery, setMediaSearchQuery] = useState('');
  const [selectedTimelineItemId, setSelectedTimelineItemId] = useState('');
  const [currentPreviewTime, setCurrentPreviewTime] = useState(0);
  const [mediaBinWidth, setMediaBinWidth] = useState(300);
  const [monitorHeight, setMonitorHeight] = useState(360);
  const [isMediaBinCollapsed, setIsMediaBinCollapsed] = useState(false);
  const [previewMode, setPreviewMode] = useState('selected');
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);
  const [playbackTimelineItemId, setPlaybackTimelineItemId] = useState('');
  const [isRenderingEditedGroup, setIsRenderingEditedGroup] = useState(false);
  const [renderedEditDownloads, setRenderedEditDownloads] = useState([]);
  const [timelineZoom, setTimelineZoom] = useState(1.25);
  const [timelinePlayheadSeconds, setTimelinePlayheadSeconds] = useState(0);
  const [clipTranscriptDraft, setClipTranscriptDraft] = useState('');
  const [isClipToolsOpen, setIsClipToolsOpen] = useState(false);
  const [speechCleanupPreviewByKey, setSpeechCleanupPreviewByKey] = useState({});
  const [selectedMulticamSegmentId, setSelectedMulticamSegmentId] = useState('');
  const [selectedDirectorShotId, setSelectedDirectorShotId] = useState('1A');
  const [isDirectorShotSetupActive, setIsDirectorShotSetupActive] = useState(false);
  const [isMulticamPlaying, setIsMulticamPlaying] = useState(false);
  const [isProgramPreviewOpen, setIsProgramPreviewOpen] = useState(false);
  const [programPreviewRect, setProgramPreviewRect] = useState(PROGRAM_PREVIEW_DEFAULT_RECT);
  const [isRenderingMulticamProgram, setIsRenderingMulticamProgram] = useState(false);
  const [renderedProgramDownload, setRenderedProgramDownload] = useState(null);

  const renderTimelineEdits = useMemo(
    () => httpsCallable(functions, 'renderTimelineEdits'),
    []
  );
  const prepareSpeechCleanupProxy = useMemo(
    () => httpsCallable(functions, 'prepareSpeechCleanupProxy'),
    []
  );

  const clipsById = useMemo(() => {
    return new Map(clips.map((clip) => [clip.id, clip]));
  }, [clips]);

  const selectedProject = useMemo(() => {
    return montageProjects.find((project) => project.id === selectedProjectId) || null;
  }, [montageProjects, selectedProjectId]);
  const isMulticamProject = selectedProject?.workflowType === 'multicam';
  const dialogueTrackDefaults = useMemo(
    () => normalizeDialogueTrackDefaults(selectedProject?.dialogueTrackDefaults || createDefaultDialogueTrackDefaults()),
    [selectedProject?.dialogueTrackDefaults]
  );

  const multicamAssets = useMemo(() => {
    if (!isMulticamProject || !Array.isArray(selectedProject?.mediaAssets)) return [];
    return selectedProject.mediaAssets.map((asset) => ({
      ...asset,
      clip: clipsById.get(String(asset?.clipId || '')) || null,
      playbackUrl: getClipPlaybackUrl(clipsById.get(String(asset?.clipId || ''))),
    }));
  }, [clipsById, isMulticamProject, selectedProject?.mediaAssets]);

  const multicamShotPresets = useMemo(() => {
    if (!isMulticamProject) return [];
    const presets = Array.isArray(selectedProject?.multicamShotPresets) && selectedProject.multicamShotPresets.length > 0
      ? selectedProject.multicamShotPresets
      : createDefaultMulticamShotPresets();
    return presets.map((preset, index) => ({
      zoom: clamp(Number(preset?.zoom || 1), 1, 3),
      panLimit: getShotPanLimit(Number(preset?.zoom || 1)),
      id: String(preset?.id || `preset-${index + 1}`),
      cameraId: String(preset?.cameraId || getMulticamCameraIdForShotId(preset?.id || '1A')),
      label: String(preset?.label || `Shot ${index + 1}`),
      panX: clamp(Number(preset?.panX || 0), -getShotPanLimit(Number(preset?.zoom || 1)), getShotPanLimit(Number(preset?.zoom || 1))),
      panY: clamp(Number(preset?.panY || 0), -getShotPanLimit(Number(preset?.zoom || 1)), getShotPanLimit(Number(preset?.zoom || 1))),
      enabled: preset?.enabled !== false,
      locked: preset?.locked !== false,
    }));
  }, [isMulticamProject, selectedProject?.multicamShotPresets]);

  const multicamSegments = useMemo(() => {
    if (!isMulticamProject || !Array.isArray(selectedProject?.multicamTimelineSegments)) return [];
    return [...selectedProject.multicamTimelineSegments]
      .map((segment, index) => ({
        ...segment,
        id: String(segment?.id || `segment-${index + 1}`),
        shotId: getMulticamSegmentShotId(segment),
        cameraId: String(segment?.cameraId || getMulticamCameraIdForShotId(getMulticamSegmentShotId(segment))),
        manualCameraId: String(segment?.manualCameraId || ''),
        manualShotId: String(segment?.manualShotId || ''),
        isLocked: Boolean(segment?.isLocked),
        isManual: segment?.isManual !== false,
      }))
      .sort((left, right) => Number(left.startSeconds || 0) - Number(right.startSeconds || 0));
  }, [isMulticamProject, selectedProject?.multicamTimelineSegments]);

  const effectiveSelectedMulticamSegmentId = useMemo(() => {
    if (!selectedMulticamSegmentId) return multicamSegments[0]?.id || '';
    const exists = multicamSegments.some((segment) => segment.id === selectedMulticamSegmentId);
    return exists ? selectedMulticamSegmentId : (multicamSegments[0]?.id || '');
  }, [multicamSegments, selectedMulticamSegmentId]);

  const selectedMulticamSegment = useMemo(() => {
    if (!effectiveSelectedMulticamSegmentId) return null;
    return multicamSegments.find((segment) => segment.id === effectiveSelectedMulticamSegmentId) || null;
  }, [effectiveSelectedMulticamSegmentId, multicamSegments]);

  const selectedMulticamSegmentShotId = useMemo(() => (
    selectedMulticamSegment ? getMulticamSegmentShotId(selectedMulticamSegment) : ''
  ), [selectedMulticamSegment]);
  const hasSelectedMulticamSegment = Boolean(selectedMulticamSegment?.id);

  useEffect(() => {
    if (!isMulticamProject) return;
    if (hasSelectedMulticamSegment) {
      setSelectedDirectorShotId(selectedMulticamSegmentShotId || '1A');
      setIsDirectorShotSetupActive(false);
      return;
    }
    setSelectedDirectorShotId('1A');
    setIsDirectorShotSetupActive(false);
  }, [
    hasSelectedMulticamSegment,
    isMulticamProject,
    selectedMulticamSegmentShotId,
  ]);

  const multicamDurationSeconds = useMemo(() => {
    if (multicamSegments.length === 0) return 0;
    return Math.max(...multicamSegments.map((segment) => Number(segment.endSeconds || 0)));
  }, [multicamSegments]);

  const multicamTrackDurationSeconds = useMemo(() => Math.max(15, multicamDurationSeconds + 2), [multicamDurationSeconds]);

  const multicamPreviewSegment = useMemo(() => {
    if (multicamSegments.length === 0) return null;
    const byPlayhead = multicamSegments.find((segment) => (
      timelinePlayheadSeconds >= Number(segment.startSeconds || 0)
      && timelinePlayheadSeconds < Number(segment.endSeconds || 0)
    ));
    return byPlayhead || selectedMulticamSegment || multicamSegments[0];
  }, [multicamSegments, selectedMulticamSegment, timelinePlayheadSeconds]);

  const selectedDirectorShotPreset = useMemo(() => {
    return multicamShotPresets.find((preset) => preset.id === selectedDirectorShotId) || multicamShotPresets[0] || null;
  }, [multicamShotPresets, selectedDirectorShotId]);

  const unlockedDirectorShotPreset = useMemo(() => (
    multicamShotPresets.find((preset) => preset.locked === false) || null
  ), [multicamShotPresets]);

  const getMulticamShotPresetById = useCallback((shotId) => {
    return multicamShotPresets.find((preset) => preset.id === String(shotId || '').trim().toUpperCase()) || null;
  }, [multicamShotPresets]);

  const multicamPreviewPresets = useMemo(() => {
    const activeShotId = getMulticamSegmentShotId(multicamPreviewSegment);
    const activePreset = getMulticamShotPresetById(activeShotId);
    const defaultA = getMulticamShotPresetById('1A') || multicamShotPresets.find((preset) => preset.cameraId === 'camera1') || null;
    const defaultB = getMulticamShotPresetById('1B') || multicamShotPresets.find((preset) => preset.cameraId === 'camera2') || null;
    const editingPreset = selectedDirectorShotPreset;
    return {
      camera1: editingPreset?.cameraId === 'camera1'
        ? editingPreset
        : (activePreset?.cameraId === 'camera1' ? activePreset : defaultA),
      camera2: editingPreset?.cameraId === 'camera2'
        ? editingPreset
        : (activePreset?.cameraId === 'camera2' ? activePreset : defaultB),
    };
  }, [getMulticamShotPresetById, multicamPreviewSegment, multicamShotPresets, selectedDirectorShotPreset]);

  const multicamPreviewUrls = useMemo(() => ({
    camera1: String(multicamAssets.find((asset) => String(asset.id || '') === 'camera1')?.playbackUrl || '').trim(),
    camera2: String(multicamAssets.find((asset) => String(asset.id || '') === 'camera2')?.playbackUrl || '').trim(),
  }), [multicamAssets]);

  const getMulticamSegmentForSeconds = useCallback((programSecondsRaw) => {
    const programSeconds = Number(programSecondsRaw || 0);
    if (!multicamSegments.length) return null;
    return multicamSegments.find((segment) => (
      programSeconds >= Number(segment.startSeconds || 0)
      && programSeconds < Number(segment.endSeconds || 0)
    )) || multicamSegments[multicamSegments.length - 1] || multicamSegments[0] || null;
  }, [multicamSegments]);

  const drawProgramPreviewFrame = useCallback((programSecondsRaw = timelinePlayheadSeconds) => {
    const canvas = programPreviewCanvasRef.current;
    if (!canvas) return;
    const pixelRatio = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;
    const displayWidth = Math.max(320, Math.floor(programPreviewRect.width));
    const displayHeight = Math.max(180, Math.floor(programPreviewRect.height - 34));
    const desiredWidth = Math.floor(displayWidth * pixelRatio);
    const desiredHeight = Math.floor(displayHeight * pixelRatio);
    if (canvas.width !== desiredWidth || canvas.height !== desiredHeight) {
      canvas.width = desiredWidth;
      canvas.height = desiredHeight;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
    }

    const activeSegment = getMulticamSegmentForSeconds(programSecondsRaw);
    const activeShotId = getMulticamSegmentShotId(activeSegment);
    const activePreset = getMulticamShotPresetById(activeShotId) || selectedDirectorShotPreset || multicamShotPresets[0] || null;
    const activeCameraId = activePreset?.cameraId || getMulticamCameraIdForShotId(activeShotId);
    const activeVideo = multicamPreviewRefs.current[activeCameraId];
    drawProgramShotFrame({
      canvas,
      video: activeVideo,
      preset: activePreset,
    });
  }, [
    getMulticamSegmentForSeconds,
    getMulticamShotPresetById,
    multicamShotPresets,
    programPreviewRect.height,
    programPreviewRect.width,
    selectedDirectorShotPreset,
    timelinePlayheadSeconds,
  ]);
  const multicamAudioMixMode = String(selectedProject?.audioMixMode || 'single_master');
  const multicamAudioMixSettings = useMemo(() => ({
    camera1Volume: Number(selectedProject?.audioMixSettings?.camera1Volume || 100),
    camera2Volume: Number(selectedProject?.audioMixSettings?.camera2Volume || 100),
    camera1Pan: Number.isFinite(Number(selectedProject?.audioMixSettings?.camera1Pan)) ? Number(selectedProject.audioMixSettings.camera1Pan) : -1,
    camera2Pan: Number.isFinite(Number(selectedProject?.audioMixSettings?.camera2Pan)) ? Number(selectedProject.audioMixSettings.camera2Pan) : 1,
  }), [
    selectedProject?.audioMixSettings?.camera1Pan,
    selectedProject?.audioMixSettings?.camera1Volume,
    selectedProject?.audioMixSettings?.camera2Pan,
    selectedProject?.audioMixSettings?.camera2Volume,
  ]);
  const multicamClockAssetId = useMemo(() => {
    const preferred = String(selectedProject?.masterAudioAssetId || 'camera1');
    if (preferred === 'camera2' && multicamPreviewUrls.camera2) return 'camera2';
    return multicamPreviewUrls.camera1 ? 'camera1' : (multicamPreviewUrls.camera2 ? 'camera2' : 'camera1');
  }, [multicamPreviewUrls.camera1, multicamPreviewUrls.camera2, selectedProject?.masterAudioAssetId]);

  useEffect(() => {
    setProjectNameDraft(String(selectedProject?.name || ''));
  }, [selectedProject?.id, selectedProject?.name]);

  const timelineItems = useMemo(() => {
    if (!selectedProject) return [];
    if (Array.isArray(selectedProject.timelineItems)) {
      return selectedProject.timelineItems;
    }
    const fallbackIds = Array.isArray(selectedProject.clipIds) ? selectedProject.clipIds : [];
    return fallbackIds.map((clipId, index) => ({
      id: `${selectedProject.id}-legacy-${index}`,
      clipId,
      trimStartSeconds: 0,
      trimEndSeconds: null,
      effectsPreset: 'none',
      effectsIntensity: 100,
      captionEnabled: true,
      captionStylePreset: 'reel-bold',
      captionTextOverride: '',
      captionConfirmationStatus: 'pending',
      captionConfirmedText: '',
      captionConfirmedAt: '',
    }));
  }, [selectedProject]);

  const timelineEntries = useMemo(() => {
    return timelineItems
      .map((item) => ({ item, clip: clipsById.get(item.clipId) }))
      .filter((entry) => Boolean(entry.clip));
  }, [timelineItems, clipsById]);

  const effectiveSelectedTimelineItemId = useMemo(() => {
    if (!selectedTimelineItemId) return timelineEntries[0]?.item.id || '';
    const exists = timelineEntries.some((entry) => entry.item.id === selectedTimelineItemId);
    return exists ? selectedTimelineItemId : (timelineEntries[0]?.item.id || '');
  }, [timelineEntries, selectedTimelineItemId]);

  const selectedTimelineEntry = useMemo(() => {
    if (!effectiveSelectedTimelineItemId) return null;
    return timelineEntries.find((entry) => entry.item.id === effectiveSelectedTimelineItemId) || null;
  }, [timelineEntries, effectiveSelectedTimelineItemId]);

  const effectivePlaybackTimelineItemId = useMemo(() => {
    if (!playbackTimelineItemId) {
      return effectiveSelectedTimelineItemId || timelineEntries[0]?.item.id || '';
    }
    const exists = timelineEntries.some((entry) => entry.item.id === playbackTimelineItemId);
    if (exists) return playbackTimelineItemId;
    return effectiveSelectedTimelineItemId || timelineEntries[0]?.item.id || '';
  }, [effectiveSelectedTimelineItemId, playbackTimelineItemId, timelineEntries]);

  const playbackTimelineEntry = useMemo(() => {
    if (!effectivePlaybackTimelineItemId) return null;
    return timelineEntries.find((entry) => entry.item.id === effectivePlaybackTimelineItemId) || null;
  }, [effectivePlaybackTimelineItemId, timelineEntries]);

  const previewTimelineEntry = useMemo(() => {
    if (previewMode !== 'timeline') return selectedTimelineEntry;
    return playbackTimelineEntry || selectedTimelineEntry;
  }, [previewMode, playbackTimelineEntry, selectedTimelineEntry]);
  const selectedEditableClip = selectedTimelineEntry?.clip || null;

  useEffect(() => {
    const nextText = normalizeCaptionEditorText(
      selectedEditableClip?.transcriptEditedText
      || selectedEditableClip?.transcriptSelectedText
      || selectedEditableClip?.transcriptOriginalText
      || selectedEditableClip?.transcriptSnippet
      || ''
    );
    setClipTranscriptDraft(nextText);
  }, [selectedEditableClip?.id, selectedEditableClip?.transcriptEditedText, selectedEditableClip?.transcriptSelectedText, selectedEditableClip?.transcriptOriginalText, selectedEditableClip?.transcriptSnippet]);

  const selectedClipSourceTranscriptText = normalizeCaptionEditorText(
    selectedEditableClip?.transcriptSelectedText
    || selectedEditableClip?.transcriptOriginalText
    || selectedEditableClip?.transcriptSnippet
    || ''
  );
  const selectedClipHasTranscriptEdit = Boolean(
    normalizeCaptionEditorText(selectedEditableClip?.transcriptEditedText || '')
  );
  const selectedCaptionStylePreset = String(
    selectedTimelineEntry?.item?.captionStylePreset
    || selectedEditableClip?.captionStylePreset
    || 'reel-bold'
  );

  useEffect(() => {
    setIsClipToolsOpen(false);
  }, [selectedEditableClip?.id]);

  useEffect(() => {
    if (!isMulticamProject) {
      setSelectedMulticamSegmentId('');
      setIsMulticamPlaying(false);
      return;
    }
    if (!selectedMulticamSegmentId && multicamSegments[0]?.id) {
      setSelectedMulticamSegmentId(multicamSegments[0].id);
    }
  }, [isMulticamProject, multicamSegments, selectedMulticamSegmentId]);

  const updateSelectedTimelineItem = useCallback((patch) => {
    if (!selectedProjectId || !selectedTimelineEntry?.item?.id || !onUpdateTimelineItem) return;
    onUpdateTimelineItem(selectedProjectId, selectedTimelineEntry.item.id, patch);
  }, [onUpdateTimelineItem, selectedProjectId, selectedTimelineEntry?.item?.id]);

  const updateSelectedProject = useCallback((patchOrUpdater) => {
    if (!selectedProjectId || !onUpdateProject) return false;
    return onUpdateProject(selectedProjectId, patchOrUpdater);
  }, [onUpdateProject, selectedProjectId]);

  const handleSelectMulticamSegment = useCallback((segmentId) => {
    setSelectedMulticamSegmentId(segmentId);
    const segment = multicamSegments.find((entry) => entry.id === segmentId);
    if (!segment) return;
    const startSeconds = Number(segment.startSeconds || 0);
    setTimelinePlayheadSeconds(startSeconds);
    setCurrentPreviewTime(startSeconds);
  }, [multicamSegments]);

  const applyMulticamSegments = useCallback((nextSegments, statusMessage = '') => {
    updateSelectedProject(() => ({
      multicamTimelineSegments: nextSegments.map((segment) => ({
        ...segment,
        cameraClipId: String(segment?.cameraClipId || ''),
      })),
      updatedAt: new Date().toISOString(),
    }));
    if (statusMessage) setLocalStatus(statusMessage);
  }, [updateSelectedProject]);

  const splitSelectedMulticamSegment = useCallback(() => {
    if (!selectedMulticamSegment) return;
    const splitSeconds = Number(timelinePlayheadSeconds || 0);
    const segmentStart = Number(selectedMulticamSegment.startSeconds || 0);
    const segmentEnd = Number(selectedMulticamSegment.endSeconds || 0);
    if (!(splitSeconds > segmentStart + TRIM_MIN_GAP_SECONDS && splitSeconds < segmentEnd - TRIM_MIN_GAP_SECONDS)) {
      setLocalStatus('Move the playhead inside the selected segment before splitting.');
      return;
    }

    const nextSegments = multicamSegments.flatMap((segment) => {
      if (segment.id !== selectedMulticamSegment.id) return [segment];
      const left = {
        ...segment,
        id: `${segment.id}-a-${Date.now()}`,
        endSeconds: Number(splitSeconds.toFixed(3)),
      };
      const right = {
        ...segment,
        id: `${segment.id}-b-${Date.now()}`,
        startSeconds: Number(splitSeconds.toFixed(3)),
      };
      return [left, right];
    });

    applyMulticamSegments(nextSegments, 'Inserted a new multicam cut at the playhead.');
    const nextSelectedSegment = nextSegments.find((segment) => (
      Number(segment.startSeconds || 0) >= Number(splitSeconds.toFixed(3)) - 0.0005
      && segment.id.includes('-b-')
    )) || nextSegments.find((segment) => Number(segment.startSeconds || 0) >= Number(splitSeconds.toFixed(3)) - 0.0005)
      || null;
    if (nextSelectedSegment?.id) {
      setSelectedMulticamSegmentId(nextSelectedSegment.id);
      setSelectedDirectorShotId(getMulticamSegmentShotId(nextSelectedSegment));
    }
  }, [applyMulticamSegments, multicamSegments, selectedMulticamSegment, timelinePlayheadSeconds]);

  const joinSelectedMulticamSegment = useCallback(() => {
    if (!selectedMulticamSegment) return;
    const selectedIndex = multicamSegments.findIndex((segment) => segment.id === selectedMulticamSegment.id);
    if (selectedIndex < 0 || selectedIndex >= multicamSegments.length - 1) {
      setLocalStatus('Select a segment that has a following segment to join.');
      return;
    }
    const nextSegment = multicamSegments[selectedIndex + 1];
    const mergedSegment = {
      ...selectedMulticamSegment,
      id: `${selectedMulticamSegment.id}-join-${Date.now()}`,
      endSeconds: Number(nextSegment.endSeconds || selectedMulticamSegment.endSeconds || 0),
      manualCameraId: String(selectedMulticamSegment.manualCameraId || selectedMulticamSegment.cameraId || 'camera1'),
      manualShotId: String(selectedMulticamSegment.manualShotId || selectedMulticamSegment.shotId || '1A'),
      isLocked: Boolean(selectedMulticamSegment.isLocked || nextSegment.isLocked),
    };
    const nextSegments = [
      ...multicamSegments.slice(0, selectedIndex),
      mergedSegment,
      ...multicamSegments.slice(selectedIndex + 2),
    ];
    applyMulticamSegments(nextSegments, 'Joined the selected multicam segment with the next segment.');
    setSelectedMulticamSegmentId(mergedSegment.id);
  }, [applyMulticamSegments, multicamSegments, selectedMulticamSegment]);

  const setSelectedMulticamShot = useCallback((shotId) => {
    if (!selectedMulticamSegment) return;
    const normalizedShotId = String(shotId || '').trim().toUpperCase() || '1A';
    const normalizedCameraId = getMulticamCameraIdForShotId(normalizedShotId);
    const nextSegments = multicamSegments.map((segment) => {
      if (segment.id !== selectedMulticamSegment.id) return segment;
      return {
        ...segment,
        shotId: normalizedShotId,
        cameraId: normalizedCameraId,
        manualCameraId: normalizedCameraId,
        manualShotId: normalizedShotId,
        isLocked: true,
      };
    });
    applyMulticamSegments(nextSegments, `Locked ${normalizedShotId} on the selected segment.`);
  }, [applyMulticamSegments, multicamSegments, selectedMulticamSegment]);

  const clearSelectedMulticamOverride = useCallback(() => {
    if (!selectedMulticamSegment) return;
    const nextSegments = multicamSegments.map((segment) => {
      if (segment.id !== selectedMulticamSegment.id) return segment;
      return {
        ...segment,
        manualCameraId: '',
        manualShotId: '',
        isLocked: false,
      };
    });
    applyMulticamSegments(nextSegments, 'Removed manual override from the selected segment.');
  }, [applyMulticamSegments, multicamSegments, selectedMulticamSegment]);

  const updateMulticamShotPreset = useCallback((shotId, patch = {}) => {
    if (!selectedProject) return;
    const normalizedShotId = String(shotId || '').trim().toUpperCase();
    if (!normalizedShotId) return;
    const nextPresets = multicamShotPresets.map((preset) => {
      if (preset.id !== normalizedShotId) return preset;
      return {
        ...preset,
        ...patch,
        id: preset.id,
        cameraId: preset.cameraId,
      };
    });
    onUpdateProject?.(selectedProject.id, {
      multicamShotPresets: nextPresets,
      updatedAt: new Date().toISOString(),
    });
  }, [multicamShotPresets, onUpdateProject, selectedProject]);

  const armDirectorShotSetup = useCallback(() => {
    if (!selectedProject || !selectedDirectorShotPreset) return;
    const nextPresets = multicamShotPresets.map((preset) => (
      preset.id === selectedDirectorShotPreset.id
        ? { ...preset, locked: false }
        : { ...preset, locked: true }
    ));
    onUpdateProject?.(selectedProject.id, {
      multicamShotPresets: nextPresets,
      updatedAt: new Date().toISOString(),
    });
    setSelectedDirectorShotId(selectedDirectorShotPreset.id);
    setIsDirectorShotSetupActive(true);
  }, [multicamShotPresets, onUpdateProject, selectedDirectorShotPreset, selectedProject]);

  const lockDirectorShotSetup = useCallback(() => {
    if (!selectedProject || !selectedDirectorShotPreset) return;
    const nextPresets = multicamShotPresets.map((preset) => (
      preset.id === selectedDirectorShotPreset.id
        ? { ...preset, locked: true }
        : preset
    ));
    onUpdateProject?.(selectedProject.id, {
      multicamShotPresets: nextPresets,
      updatedAt: new Date().toISOString(),
    });
    setIsDirectorShotSetupActive(false);
  }, [multicamShotPresets, onUpdateProject, selectedDirectorShotPreset, selectedProject]);

  const handleSelectDirectorShotPreset = useCallback((shotId) => {
    const normalizedShotId = String(shotId || '').trim().toUpperCase();
    if (!normalizedShotId) return;
    if (isDirectorShotSetupActive && unlockedDirectorShotPreset?.id && unlockedDirectorShotPreset.id !== normalizedShotId) {
      setLocalStatus(`Lock ${unlockedDirectorShotPreset.id} before selecting another shot preset.`);
      return;
    }
    setSelectedDirectorShotId(normalizedShotId);
    if (!isDirectorShotSetupActive) {
      setIsDirectorShotSetupActive(false);
    }
  }, [isDirectorShotSetupActive, unlockedDirectorShotPreset]);

  const handleDirectorShotPointerDown = useCallback((event, cameraId) => {
    if (!isDirectorShotSetupActive || !selectedDirectorShotPreset || selectedDirectorShotPreset.locked) return;
    if (selectedDirectorShotPreset.cameraId !== cameraId) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    directorShotDragRef.current = {
      pointerId: event.pointerId,
      shotId: selectedDirectorShotPreset.id,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: Number(selectedDirectorShotPreset.panX || 0),
      startPanY: Number(selectedDirectorShotPreset.panY || 0),
    };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, [isDirectorShotSetupActive, selectedDirectorShotPreset]);

  const handleDirectorShotWheel = useCallback((event, cameraId) => {
    if (!isDirectorShotSetupActive || !selectedDirectorShotPreset || selectedDirectorShotPreset.locked) return;
    if (selectedDirectorShotPreset.cameraId !== cameraId) return;
    event.preventDefault();
    event.stopPropagation?.();

    const deltaX = Number(event.deltaX || 0);
    const deltaY = Number(event.deltaY || 0);
    const dominantHorizontal = Math.abs(deltaX) > Math.abs(deltaY);

    if (event.ctrlKey || !dominantHorizontal) {
      const nextZoom = clamp(
        Number(selectedDirectorShotPreset.zoom || 1) - (deltaY * 0.0015),
        1,
        3,
      );
      const nextPanLimit = getShotPanLimit(nextZoom);
      updateMulticamShotPreset(selectedDirectorShotPreset.id, {
        zoom: Number(nextZoom.toFixed(3)),
        panX: Number(clamp(Number(selectedDirectorShotPreset.panX || 0), -nextPanLimit, nextPanLimit).toFixed(2)),
        panY: Number(clamp(Number(selectedDirectorShotPreset.panY || 0), -nextPanLimit, nextPanLimit).toFixed(2)),
      });
      return;
    }

    const panLimit = getShotPanLimit(selectedDirectorShotPreset.zoom);
    const nextPanX = clamp(Number(selectedDirectorShotPreset.panX || 0) - (deltaX * 0.08), -panLimit, panLimit);
    const nextPanY = clamp(Number(selectedDirectorShotPreset.panY || 0) - (deltaY * 0.08), -panLimit, panLimit);
    updateMulticamShotPreset(selectedDirectorShotPreset.id, {
      panX: Number(nextPanX.toFixed(2)),
      panY: Number(nextPanY.toFixed(2)),
    });
  }, [isDirectorShotSetupActive, selectedDirectorShotPreset, updateMulticamShotPreset]);

  const getMulticamSourceTimeForAsset = useCallback((programSeconds, assetId, fallbackDuration = 0) => {
    const offset = getProjectAssetOffsetSeconds(selectedProject, assetId);
    return clamp(
      Number(programSeconds || 0) - offset,
      0,
      Math.max(0, Number(fallbackDuration || 0))
    );
  }, [selectedProject]);

  const ensureMulticamAudioRouting = useCallback(async () => {
    if (!isMulticamProject) return null;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;

    let audioContext = multicamAudioContextRef.current;
    if (!audioContext) {
      audioContext = new AudioContextCtor();
      multicamAudioContextRef.current = audioContext;
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    multicamAssets.forEach((asset) => {
      const assetId = String(asset?.id || '');
      const media = multicamAudioRefs.current[assetId];
      if (!media || multicamAudioNodesRef.current[assetId]) return;

      const sourceNode = audioContext.createMediaElementSource(media);
      const gainNode = audioContext.createGain();
      let panNode = null;

      if (typeof audioContext.createStereoPanner === 'function') {
        panNode = audioContext.createStereoPanner();
        sourceNode.connect(gainNode);
        gainNode.connect(panNode);
        panNode.connect(audioContext.destination);
      } else {
        sourceNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
      }

      multicamAudioNodesRef.current[assetId] = {
        sourceNode,
        gainNode,
        panNode,
      };
    });

    return audioContext;
  }, [isMulticamProject, multicamAssets]);

  const applyMulticamAudioMix = useCallback(() => {
    const applyTrack = (assetId, volumePercent, panValue, enabled) => {
      const media = multicamAudioRefs.current[assetId];
      if (media) {
        media.volume = 1;
      }
      const nodes = multicamAudioNodesRef.current[assetId];
      if (!nodes?.gainNode) return;
      nodes.gainNode.gain.value = enabled ? clamp(Number(volumePercent || 0) / 100, 0, 1) : 0;
      if (nodes.panNode) {
        nodes.panNode.pan.value = clampPan(panValue);
      }
    };

    if (multicamAudioMixMode === 'stereo_mix') {
      applyTrack('camera1', multicamAudioMixSettings.camera1Volume, multicamAudioMixSettings.camera1Pan, Boolean(multicamPreviewUrls.camera1));
      applyTrack('camera2', multicamAudioMixSettings.camera2Volume, multicamAudioMixSettings.camera2Pan, Boolean(multicamPreviewUrls.camera2));
      return;
    }

    applyTrack('camera1', 100, 0, multicamClockAssetId === 'camera1' && Boolean(multicamPreviewUrls.camera1));
    applyTrack('camera2', 100, 0, multicamClockAssetId === 'camera2' && Boolean(multicamPreviewUrls.camera2));
  }, [
    multicamAudioMixMode,
    multicamAudioMixSettings.camera1Pan,
    multicamAudioMixSettings.camera1Volume,
    multicamAudioMixSettings.camera2Pan,
    multicamAudioMixSettings.camera2Volume,
    multicamClockAssetId,
    multicamPreviewUrls.camera1,
    multicamPreviewUrls.camera2,
  ]);

  const syncMulticamPreviewFrame = useCallback(() => {
    const clockVideo = multicamPreviewRefs.current[multicamClockAssetId];
    if (!clockVideo) return;

    const clockDuration = Number(
      multicamAssets.find((asset) => String(asset.id || '') === multicamClockAssetId)?.durationSeconds || 0
    );
    const nextProgramSeconds = clamp(
      Number(clockVideo.currentTime || 0) + getProjectAssetOffsetSeconds(selectedProject, multicamClockAssetId),
      0,
      Math.max(multicamTrackDurationSeconds, clockDuration)
    );

    setCurrentPreviewTime(nextProgramSeconds);
    setTimelinePlayheadSeconds(nextProgramSeconds);

    const activeSegment = multicamSegments.find((segment) => (
      nextProgramSeconds >= Number(segment.startSeconds || 0)
      && nextProgramSeconds < Number(segment.endSeconds || 0)
    ));
    if (activeSegment && activeSegment.id !== effectiveSelectedMulticamSegmentId) {
      setSelectedMulticamSegmentId(activeSegment.id);
    }

    if (nextProgramSeconds >= multicamTrackDurationSeconds - 0.02) {
      setIsMulticamPlaying(false);
      setLocalStatus('Reached end of multicam timeline.');
      return;
    }

    multicamPreviewAnimationRef.current = window.requestAnimationFrame(syncMulticamPreviewFrame);
  }, [
    effectiveSelectedMulticamSegmentId,
    multicamAssets,
    multicamClockAssetId,
    multicamSegments,
    multicamTrackDurationSeconds,
    selectedProject,
  ]);

  const playSelectedMulticamProgram = useCallback(() => {
    if (!multicamPreviewUrls.camera1 && !multicamPreviewUrls.camera2) {
      setLocalStatus('No synced camera media is available for multicam preview.');
      return;
    }
    setIsMulticamPlaying(true);
    setLocalStatus('Playing multicam program from the current playhead.');
  }, [multicamPreviewUrls.camera1, multicamPreviewUrls.camera2]);

  const pauseSelectedMulticamProgram = useCallback(() => {
    if (multicamPreviewAnimationRef.current) {
      cancelAnimationFrame(multicamPreviewAnimationRef.current);
      multicamPreviewAnimationRef.current = null;
    }
    setIsMulticamPlaying(false);
    Object.values(multicamPreviewRefs.current).forEach((video) => {
      try {
        video?.pause?.();
      } catch {
        // no-op
      }
    });
    Object.values(multicamAudioRefs.current).forEach((audio) => {
      try {
        audio?.pause?.();
      } catch {
        // no-op
      }
    });
    setLocalStatus('Paused multicam program playback.');
  }, []);

  const handleOpenProgramPreview = useCallback(() => {
    setIsProgramPreviewOpen(true);
    setLocalStatus('Program preview opened. Drag the window and resize it from the lower-right corner.');
  }, []);

  const handleCloseProgramPreview = useCallback(() => {
    setIsProgramPreviewOpen(false);
  }, []);

  const handleProgramPreviewWindowPointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    programPreviewWindowDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: { ...programPreviewRect },
    };
  }, [programPreviewRect]);

  const handleProgramPreviewResizePointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    programPreviewWindowResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: { ...programPreviewRect },
    };
  }, [programPreviewRect]);

  const seekMulticamMediaToProgramSeconds = useCallback((programSecondsRaw, { play = false } = {}) => {
    const programSeconds = clamp(Number(programSecondsRaw) || 0, 0, multicamTrackDurationSeconds);
    Object.entries(multicamPreviewRefs.current).forEach(([assetId, video]) => {
      if (!video) return;
      const assetDuration = Number(
        multicamAssets.find((asset) => String(asset.id || '') === String(assetId || ''))?.durationSeconds || 0
      );
      try {
        video.currentTime = getMulticamSourceTimeForAsset(programSeconds, assetId, assetDuration);
      } catch {
        // ignore seek edge cases
      }
      if (play) {
        video.play().catch(() => { });
      } else {
        video.pause();
      }
    });
    Object.entries(multicamAudioRefs.current).forEach(([assetId, audio]) => {
      if (!audio) return;
      const assetDuration = Number(
        multicamAssets.find((asset) => String(asset.id || '') === String(assetId || ''))?.durationSeconds || 0
      );
      try {
        audio.currentTime = getMulticamSourceTimeForAsset(programSeconds, assetId, assetDuration);
      } catch {
        // ignore seek edge cases
      }
      if (play) {
        audio.play().catch(() => { });
      } else {
        audio.pause();
      }
    });
  }, [getMulticamSourceTimeForAsset, multicamAssets, multicamTrackDurationSeconds]);

  const renderFinishedMulticamProgram = useCallback(async () => {
    if (!isMulticamProject) return;
    if (!multicamPreviewUrls.camera1 && !multicamPreviewUrls.camera2) {
      setLocalStatus('No synced camera media is available to render.');
      return;
    }
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
      setLocalStatus('This browser does not support local program recording.');
      return;
    }

    const recorderMimeType = getSupportedProgramRecorderMimeType();
    if (!recorderMimeType) {
      setLocalStatus('No supported browser recording codec is available for program render.');
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      setLocalStatus('This browser does not support Web Audio output capture.');
      return;
    }

    pauseSelectedMulticamProgram();
    setIsRenderingMulticamProgram(true);
    setLocalStatus('Rendering finished program locally. This runs in real time.');

    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = PROGRAM_RENDER_WIDTH;
    renderCanvas.height = PROGRAM_RENDER_HEIGHT;
    const videoStream = renderCanvas.captureStream(PROGRAM_RENDER_FPS);
    const audioContext = new AudioContextCtor();
    const audioDestination = audioContext.createMediaStreamDestination();
    const renderHost = document.createElement('div');
    renderHost.style.position = 'fixed';
    renderHost.style.left = '-99999px';
    renderHost.style.top = '-99999px';
    renderHost.style.width = '1px';
    renderHost.style.height = '1px';
    renderHost.style.opacity = '0';
    renderHost.style.pointerEvents = 'none';
    renderHost.style.overflow = 'hidden';
    document.body.appendChild(renderHost);
    const renderVideos = {};
    const renderAudios = {};
    const renderNodes = {};
    const cleanupTasks = [];
    let recorder = null;
    let animationFrameId = null;

    try {
      await audioContext.resume();

      const createMediaElement = (tagName, src, muted = false) => {
        const element = document.createElement(tagName);
        element.src = src;
        element.crossOrigin = 'anonymous';
        element.preload = 'auto';
        element.playsInline = true;
        element.muted = muted;
        element.volume = muted ? 0 : 1;
        return element;
      };

      const waitForMetadata = (media) => new Promise((resolve, reject) => {
        if (media.readyState >= 1) {
          resolve();
          return;
        }
        const handleReady = () => {
          media.removeEventListener('loadedmetadata', handleReady);
          media.removeEventListener('error', handleError);
          resolve();
        };
        const handleError = () => {
          media.removeEventListener('loadedmetadata', handleReady);
          media.removeEventListener('error', handleError);
          reject(new Error(`Unable to load media: ${media.currentSrc || media.src || 'unknown source'}`));
        };
        media.addEventListener('loadedmetadata', handleReady);
        media.addEventListener('error', handleError);
      });

      const assetIds = ['camera1', 'camera2'];
      for (const assetId of assetIds) {
        const src = multicamPreviewUrls[assetId];
        if (!src) continue;
        const video = createMediaElement('video', src, true);
        const audio = createMediaElement('audio', src, false);
        renderVideos[assetId] = video;
        renderAudios[assetId] = audio;
        renderHost.appendChild(video);
        renderHost.appendChild(audio);
        cleanupTasks.push(() => {
          try { video.pause(); } catch { /* no-op */ }
          try { audio.pause(); } catch { /* no-op */ }
          video.removeAttribute('src');
          audio.removeAttribute('src');
          video.load?.();
          audio.load?.();
        });
        video.load?.();
        audio.load?.();
        await Promise.all([waitForMetadata(video), waitForMetadata(audio)]);
        const sourceNode = audioContext.createMediaElementSource(audio);
        const gainNode = audioContext.createGain();
        let panNode = null;
        sourceNode.connect(gainNode);
        if (typeof audioContext.createStereoPanner === 'function') {
          panNode = audioContext.createStereoPanner();
          gainNode.connect(panNode);
          panNode.connect(audioDestination);
        } else {
          gainNode.connect(audioDestination);
        }
        renderNodes[assetId] = { gainNode, panNode };
      }

      const applyRenderTrack = (assetId, volumePercent, panValue, enabled) => {
        const nodes = renderNodes[assetId];
        const audio = renderAudios[assetId];
        if (!nodes || !audio) return;
        audio.volume = 1;
        nodes.gainNode.gain.value = enabled ? clamp(Number(volumePercent || 0) / 100, 0, 1) : 0;
        if (nodes.panNode) {
          nodes.panNode.pan.value = clampPan(panValue);
        }
      };

      if (multicamAudioMixMode === 'stereo_mix') {
        applyRenderTrack('camera1', multicamAudioMixSettings.camera1Volume, multicamAudioMixSettings.camera1Pan, Boolean(renderAudios.camera1));
        applyRenderTrack('camera2', multicamAudioMixSettings.camera2Volume, multicamAudioMixSettings.camera2Pan, Boolean(renderAudios.camera2));
      } else {
        applyRenderTrack('camera1', 100, 0, multicamClockAssetId === 'camera1' && Boolean(renderAudios.camera1));
        applyRenderTrack('camera2', 100, 0, multicamClockAssetId === 'camera2' && Boolean(renderAudios.camera2));
      }

      const combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks(),
      ]);

      const chunks = [];
      recorder = new window.MediaRecorder(combinedStream, { mimeType: recorderMimeType });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      const renderComplete = new Promise((resolve, reject) => {
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorderMimeType });
          if (!blob.size) {
            reject(new Error('The browser recorder did not produce output.'));
            return;
          }
          const extension = recorderMimeType.includes('webm') ? 'webm' : 'mp4';
          const fileName = `${sanitizeFileNamePart(selectedProject?.name || 'program', 'program')}-director-render.${extension}`;
          const downloadUrl = URL.createObjectURL(blob);
          setRenderedProgramDownload((previous) => {
            if (previous?.url) URL.revokeObjectURL(previous.url);
            return { url: downloadUrl, fileName };
          });
          const anchor = document.createElement('a');
          anchor.href = downloadUrl;
          anchor.download = fileName;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          resolve({ fileName });
        };
        recorder.onerror = (event) => {
          reject(event?.error || new Error('The browser recorder failed during program render.'));
        };
      });

      const initialProgramSeconds = 0;
      Object.entries(renderVideos).forEach(([assetId, video]) => {
        const assetDuration = Number(multicamAssets.find((asset) => String(asset.id || '') === String(assetId || ''))?.durationSeconds || video.duration || 0);
        video.currentTime = getMulticamSourceTimeForAsset(initialProgramSeconds, assetId, assetDuration);
      });
      Object.entries(renderAudios).forEach(([assetId, audio]) => {
        const assetDuration = Number(multicamAssets.find((asset) => String(asset.id || '') === String(assetId || ''))?.durationSeconds || audio.duration || 0);
        audio.currentTime = getMulticamSourceTimeForAsset(initialProgramSeconds, assetId, assetDuration);
      });

      const initialSegment = getMulticamSegmentForSeconds(initialProgramSeconds);
      const initialShotId = getMulticamSegmentShotId(initialSegment);
      const initialPreset = getMulticamShotPresetById(initialShotId) || multicamShotPresets[0] || null;
      const initialCameraId = initialPreset?.cameraId || getMulticamCameraIdForShotId(initialShotId);
      drawProgramShotFrame({
        canvas: renderCanvas,
        video: renderVideos[initialCameraId],
        preset: initialPreset,
      });

      const videoPlayResults = await Promise.all(
        Object.values(renderVideos).map((video) => video.play().then(() => true).catch(() => false))
      );
      const audioPlayResults = await Promise.all(
        Object.values(renderAudios).map((audio) => audio.play().then(() => true).catch(() => false))
      );
      const clockVideo = renderVideos[multicamClockAssetId] || renderVideos.camera1 || renderVideos.camera2;
      if (!clockVideo || !videoPlayResults.some(Boolean) || !audioPlayResults.some(Boolean)) {
        throw new Error('Browser media playback did not start for the program render.');
      }

      await new Promise((resolve) => window.setTimeout(resolve, 200));
      if (clockVideo.paused || clockVideo.ended) {
        throw new Error('Program render transport did not advance. Browser blocked hidden media playback.');
      }

      recorder.start(1000);

      const drawRenderFrame = () => {
        const activeClockVideo = renderVideos[multicamClockAssetId] || renderVideos.camera1 || renderVideos.camera2;
        if (!activeClockVideo) return;
        const nextProgramSeconds = clamp(
          Number(activeClockVideo.currentTime || 0) + getProjectAssetOffsetSeconds(selectedProject, multicamClockAssetId),
          0,
          multicamTrackDurationSeconds,
        );
        const activeSegment = getMulticamSegmentForSeconds(nextProgramSeconds);
        const activeShotId = getMulticamSegmentShotId(activeSegment);
        const activePreset = getMulticamShotPresetById(activeShotId) || multicamShotPresets[0] || null;
        const activeCameraId = activePreset?.cameraId || getMulticamCameraIdForShotId(activeShotId);
        const activeVideo = renderVideos[activeCameraId];
        drawProgramShotFrame({
          canvas: renderCanvas,
          video: activeVideo,
          preset: activePreset,
        });

        if (nextProgramSeconds >= multicamTrackDurationSeconds - 0.02) {
          recorder.stop();
          return;
        }
        animationFrameId = window.requestAnimationFrame(drawRenderFrame);
      };

      drawRenderFrame();
      const result = await renderComplete;
      setLocalStatus(`Finished program render: ${result.fileName}`);
    } catch (error) {
      console.error('Failed rendering multicam program:', error);
      setLocalStatus(`Unable to render finished program. ${String(error?.message || error || 'Unknown error')}`);
    } finally {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      try {
        recorder?.state === 'recording' && recorder.stop();
      } catch {
        // no-op
      }
      Object.values(renderVideos).forEach((video) => {
        try { video.pause(); } catch { /* no-op */ }
      });
      Object.values(renderAudios).forEach((audio) => {
        try { audio.pause(); } catch { /* no-op */ }
      });
      cleanupTasks.forEach((task) => task());
      renderHost.remove();
      try {
        await audioContext.close();
      } catch {
        // no-op
      }
      setIsRenderingMulticamProgram(false);
    }
  }, [
    getMulticamSegmentForSeconds,
    getMulticamShotPresetById,
    getMulticamSourceTimeForAsset,
    isMulticamProject,
    multicamAssets,
    multicamAudioMixMode,
    multicamAudioMixSettings.camera1Pan,
    multicamAudioMixSettings.camera1Volume,
    multicamAudioMixSettings.camera2Pan,
    multicamAudioMixSettings.camera2Volume,
    multicamClockAssetId,
    multicamShotPresets,
    multicamTrackDurationSeconds,
    pauseSelectedMulticamProgram,
    multicamPreviewUrls,
    selectedProject,
  ]);

  const handleMulticamLoadedMetadata = useCallback((assetId, event) => {
    const video = event.currentTarget;
    const assetDuration = Number(
      multicamAssets.find((asset) => String(asset.id || '') === String(assetId || ''))?.durationSeconds || 0
    );
    try {
      video.currentTime = getMulticamSourceTimeForAsset(timelinePlayheadSeconds, assetId, assetDuration);
    } catch {
      // ignore seek edge cases
    }
    if (isMulticamPlaying) {
      video.play().catch(() => { });
    }
  }, [getMulticamSourceTimeForAsset, isMulticamPlaying, multicamAssets, timelinePlayheadSeconds]);

  useEffect(() => {
    void ensureMulticamAudioRouting().then(() => {
      applyMulticamAudioMix();
    });
  }, [applyMulticamAudioMix, ensureMulticamAudioRouting]);

  useEffect(() => {
    multicamProgramSecondsRef.current = timelinePlayheadSeconds;
  }, [timelinePlayheadSeconds]);

  const handleCaptionStyleChange = useCallback((event) => {
    const nextValue = String(event.target.value || 'reel-bold').trim() || 'reel-bold';
    updateSelectedTimelineItem({ captionStylePreset: nextValue });
  }, [updateSelectedTimelineItem]);

  const handleCaptionEnabledToggle = useCallback(() => {
    const currentlyEnabled = selectedTimelineEntry?.item?.captionEnabled !== false;
    updateSelectedTimelineItem({ captionEnabled: !currentlyEnabled });
  }, [selectedTimelineEntry?.item?.captionEnabled, updateSelectedTimelineItem]);

  const handleDialogueTrackDefaultToggle = useCallback(() => {
    updateSelectedProject((project) => {
      const currentDefaults = normalizeDialogueTrackDefaults(project?.dialogueTrackDefaults || createDefaultDialogueTrackDefaults());
      return {
        dialogueTrackDefaults: {
          ...currentDefaults,
          speechCleanupEnabled: !currentDefaults.speechCleanupEnabled,
        },
      };
    });
  }, [updateSelectedProject]);

  const handleDialogueTrackDefaultPresetChange = useCallback((event) => {
    const nextPreset = normalizeSpeechCleanupPreset(event.target.value);
    updateSelectedProject((project) => {
      const currentDefaults = normalizeDialogueTrackDefaults(project?.dialogueTrackDefaults || createDefaultDialogueTrackDefaults());
      return {
        dialogueTrackDefaults: {
          ...currentDefaults,
          speechCleanupPreset: nextPreset,
        },
      };
    });
  }, [updateSelectedProject]);

  const handleSpeechCleanupModeChange = useCallback((event) => {
    const nextMode = normalizeSpeechCleanupMode(event.target.value);
    const currentPreset = normalizeSpeechCleanupPreset(selectedTimelineEntry?.item?.speechCleanupPreset || DEFAULT_SPEECH_CLEANUP_PRESET);
    updateSelectedTimelineItem({
      speechCleanupMode: nextMode,
      speechCleanupPreset: currentPreset,
    });
  }, [selectedTimelineEntry?.item?.speechCleanupPreset, updateSelectedTimelineItem]);

  const handleSpeechCleanupPresetChange = useCallback((event) => {
    const nextPreset = normalizeSpeechCleanupPreset(event.target.value);
    const currentMode = normalizeSpeechCleanupMode(selectedTimelineEntry?.item?.speechCleanupMode);
    updateSelectedTimelineItem({
      speechCleanupMode: currentMode === 'inherit' ? 'on' : currentMode,
      speechCleanupPreset: nextPreset,
    });
  }, [selectedTimelineEntry?.item?.speechCleanupMode, updateSelectedTimelineItem]);

  const applyClipTranscriptEdit = useCallback(() => {
    if (!selectedEditableClip?.id || !onUpdateClip) return;
    const normalizedDraft = normalizeCaptionEditorText(clipTranscriptDraft);
    const normalizedSource = selectedClipSourceTranscriptText;
    if (!normalizedDraft) {
      onUpdateClip(selectedEditableClip.id, {
        transcriptEditedText: '',
        transcriptEditedAt: '',
        captionCuesEdited: [],
        captionEditMode: 'source',
      });
      setLocalStatus('Cleared clip transcript edit and restored source captions.');
      return;
    }

    if (normalizedDraft === normalizedSource) {
      onUpdateClip(selectedEditableClip.id, {
        transcriptEditedText: '',
        transcriptEditedAt: '',
        captionCuesEdited: [],
        captionEditMode: 'source',
      });
      setLocalStatus('Transcript matches source. Removed clip-level text edit.');
      return;
    }

    const clipDuration = getClipDurationSeconds(selectedEditableClip);
    const sourceCues = getClipOriginalCaptionCues(selectedEditableClip);
    const editedCues = buildReflowedCaptionCues({
      sourceCues,
      editedText: normalizedDraft,
      rangeStartSeconds: 0,
      rangeEndSeconds: Number.isFinite(clipDuration) ? clipDuration : null,
      idPrefix: 'clip-edit',
    });

    onUpdateClip(selectedEditableClip.id, {
      transcriptEditedText: normalizedDraft,
      transcriptEditedAt: new Date().toISOString(),
      captionCuesEdited: editedCues,
      captionEditMode: 'text-edit',
    });
    setLocalStatus(
      editedCues.length > 0
        ? `Saved transcript edit and reflowed ${editedCues.length} timed caption cues.`
        : 'Saved transcript edit.'
    );
  }, [clipTranscriptDraft, onUpdateClip, selectedClipSourceTranscriptText, selectedEditableClip]);

  const resetClipTranscriptEdit = useCallback(() => {
    if (!selectedEditableClip?.id || !onUpdateClip) return;
    setClipTranscriptDraft(selectedClipSourceTranscriptText);
    onUpdateClip(selectedEditableClip.id, {
      transcriptEditedText: '',
      transcriptEditedAt: '',
      captionCuesEdited: [],
      captionEditMode: 'source',
    });
    setLocalStatus('Restored source transcript and source caption timing for this clip.');
  }, [onUpdateClip, selectedClipSourceTranscriptText, selectedEditableClip]);

  const previewTimelineIndex = useMemo(() => {
    if (!previewTimelineEntry) return -1;
    return timelineEntries.findIndex((entry) => entry.item.id === previewTimelineEntry.item.id);
  }, [timelineEntries, previewTimelineEntry]);

  const previewClip = previewTimelineEntry?.clip || null;
  const effectiveSelectedSpeechCleanup = useMemo(() => (
    resolveEffectiveSpeechCleanup({
      item: selectedTimelineEntry?.item,
      projectDefaults: dialogueTrackDefaults,
    })
  ), [dialogueTrackDefaults, selectedTimelineEntry?.item]);
  const effectivePreviewSpeechCleanup = useMemo(() => (
    resolveEffectiveSpeechCleanup({
      item: previewTimelineEntry?.item,
      projectDefaults: dialogueTrackDefaults,
    })
  ), [dialogueTrackDefaults, previewTimelineEntry?.item]);
  const previewCleanupToken = useMemo(
    () => extractRenderedClipToken(getClipRenderUrl(previewClip)),
    [previewClip]
  );
  const previewCleanupKey = useMemo(() => (
    effectivePreviewSpeechCleanup.enabled
      ? buildSpeechCleanupPreviewKey({
        token: previewCleanupToken,
        preset: effectivePreviewSpeechCleanup.preset,
      })
      : ''
  ), [effectivePreviewSpeechCleanup.enabled, effectivePreviewSpeechCleanup.preset, previewCleanupToken]);
  const previewCleanupEntry = previewCleanupKey ? speechCleanupPreviewByKey[previewCleanupKey] : null;
  const previewClipPlaybackUrl = useMemo(() => {
    if (effectivePreviewSpeechCleanup.enabled && previewCleanupEntry?.status === 'ready' && previewCleanupEntry?.url) {
      return previewCleanupEntry.url;
    }
    return getClipPlaybackUrl(previewClip);
  }, [effectivePreviewSpeechCleanup.enabled, previewCleanupEntry?.status, previewCleanupEntry?.url, previewClip]);

  useEffect(() => {
    if (!previewCleanupKey || !effectivePreviewSpeechCleanup.enabled || !previewCleanupToken) return undefined;
    const existing = speechCleanupPreviewByKey[previewCleanupKey];
    if (existing?.status === 'ready' || existing?.status === 'loading') return undefined;

    let cancelled = false;
    setSpeechCleanupPreviewByKey((previous) => ({
      ...previous,
      [previewCleanupKey]: {
        status: 'loading',
        url: previous[previewCleanupKey]?.url || '',
        error: '',
      },
    }));

    void prepareSpeechCleanupProxy({
      token: previewCleanupToken,
      speechCleanupPreset: effectivePreviewSpeechCleanup.preset,
    }).then((result) => {
      if (cancelled) return;
      const downloadUrl = String(result?.data?.downloadUrl || '').trim();
      if (!downloadUrl) {
        throw new Error('Speech Cleanup preview did not return a proxy URL.');
      }
      setSpeechCleanupPreviewByKey((previous) => ({
        ...previous,
        [previewCleanupKey]: {
          status: 'ready',
          url: downloadUrl,
          error: '',
        },
      }));
    }).catch((error) => {
      if (cancelled) return;
      console.error('Speech Cleanup preview failed:', error);
      setSpeechCleanupPreviewByKey((previous) => ({
        ...previous,
        [previewCleanupKey]: {
          status: 'failed',
          url: '',
          error: String(error?.message || 'Unable to prepare Speech Cleanup preview.'),
        },
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [
    effectivePreviewSpeechCleanup.enabled,
    effectivePreviewSpeechCleanup.preset,
    prepareSpeechCleanupProxy,
    previewCleanupKey,
    previewCleanupToken,
    speechCleanupPreviewByKey,
  ]);
  const previewTrimRange = useMemo(() => {
    if (!previewTimelineEntry) return null;
    return getTimelineEntryTrimRange(previewTimelineEntry);
  }, [previewTimelineEntry]);
  const previewCaptionPayload = useMemo(() => {
    if (!previewTimelineEntry) return { enabled: false, stylePreset: 'reel-bold', cues: [] };
    return buildCaptionPayloadForEntry(previewTimelineEntry);
  }, [previewTimelineEntry]);
  const previewRelativeTime = useMemo(() => {
    if (!previewTrimRange) return Number(currentPreviewTime) || 0;
    return Math.max(0, (Number(currentPreviewTime) || 0) - previewTrimRange.start);
  }, [currentPreviewTime, previewTrimRange]);
  const previewCaptionLines = useMemo(() => {
    if (!previewCaptionPayload?.enabled || !Array.isArray(previewCaptionPayload.cues)) return [];
    const cue = previewCaptionPayload.cues.find((item) => (
      Number.isFinite(Number(item.startSeconds))
      && Number.isFinite(Number(item.endSeconds))
      && previewRelativeTime >= Number(item.startSeconds)
      && previewRelativeTime < Number(item.endSeconds)
    ));
    if (!cue) return [];

    const cueStart = Number(cue.startSeconds);
    const cueEnd = Number(cue.endSeconds);
    const cueWords = Array.isArray(cue?.words) && cue.words.length > 0
      ? cue.words
        .map((word, index) => {
          const text = normalizeCaptionText(word?.text || '');
          const startSeconds = Number(word?.startSeconds);
          const endSeconds = Number(word?.endSeconds);
          if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
            return null;
          }
          return {
            id: String(word?.id || `${cue.id || 'cue'}-word-${index + 1}`),
            text,
            startSeconds,
            endSeconds,
          };
        })
        .filter(Boolean)
      : splitCaptionWords(normalizeCaptionText(cue?.text || '')).map((word, index, words) => {
        const safeCueStart = Number.isFinite(cueStart) ? cueStart : 0;
        const safeCueEnd = Number.isFinite(cueEnd) && cueEnd > safeCueStart ? cueEnd : safeCueStart + 0.1;
        const perWordDuration = Math.max(0.08, (safeCueEnd - safeCueStart) / Math.max(1, words.length));
        const wordStart = safeCueStart + perWordDuration * index;
        const wordEnd = index === words.length - 1
          ? safeCueEnd
          : safeCueStart + perWordDuration * (index + 1);
        return {
          id: `${cue.id || 'cue'}-word-${index + 1}`,
          text: word,
          startSeconds: wordStart,
          endSeconds: wordEnd,
        };
      });

    if (
      !Number.isFinite(cueStart)
      || !Number.isFinite(cueEnd)
      || cueEnd <= cueStart
      || cueWords.length === 0
    ) {
      return [];
    }

    let activeWordIndex = 0;
    for (let index = 0; index < cueWords.length; index += 1) {
      const word = cueWords[index];
      if (previewRelativeTime >= word.startSeconds && previewRelativeTime < word.endSeconds) {
        activeWordIndex = index;
        break;
      }
      if (word.startSeconds <= previewRelativeTime) {
        activeWordIndex = index;
      } else {
        break;
      }
    }

    const windowSize = 5;
    const windowIndex = Math.floor(activeWordIndex / windowSize);
    const windowStart = windowIndex * windowSize;
    const visibleWords = cueWords
      .slice(windowStart, windowStart + windowSize)
      .map((word, index) => ({
        ...word,
        isActive: windowStart + index === activeWordIndex,
      }));
    if (visibleWords.length === 0) return [];
    const firstLineCount = Math.max(1, Math.ceil(visibleWords.length / 2));
    return [
      visibleWords.slice(0, firstLineCount),
      visibleWords.slice(firstLineCount),
    ].filter((line) => line.length > 0);
  }, [previewCaptionPayload, previewRelativeTime]);

  const projectScopedVaultClips = useMemo(() => {
    if (!selectedProjectId) return [];
    return clips.filter((clip) => String(clip.projectId || '') === selectedProjectId);
  }, [clips, selectedProjectId]);

  const filteredVaultClips = useMemo(() => {
    const query = mediaSearchQuery.trim().toLowerCase();
    if (!query) return projectScopedVaultClips;
    return projectScopedVaultClips.filter((clip) => {
      return `${clip.title || ''} ${clip.description || ''} ${clip.sourceTitle || ''}`.toLowerCase().includes(query);
    });
  }, [mediaSearchQuery, projectScopedVaultClips]);

  const renderableTimelineItemCount = useMemo(() => {
    return timelineEntries.reduce((count, entry) => (
      extractRenderedClipToken(getClipRenderUrl(entry?.clip)) ? count + 1 : count
    ), 0);
  }, [timelineEntries]);
  const timelinePixelsPerSecond = useMemo(() => {
    return clamp(
      TIMELINE_BASE_PX_PER_SECOND * Number(timelineZoom || 1),
      TIMELINE_MIN_PX_PER_SECOND,
      TIMELINE_MAX_PX_PER_SECOND
    );
  }, [timelineZoom]);
  const timelineSequenceEntries = useMemo(() => {
    let cursor = 0;
    return timelineEntries.map((entry) => {
      const duration = Math.max(TRIM_MIN_GAP_SECONDS, getTimelineEntryTrimmedDuration(entry));
      const sequenceStart = cursor;
      const sequenceEnd = sequenceStart + duration;
      cursor = sequenceEnd;
      return {
        ...entry,
        sequenceStart,
        sequenceEnd,
        sequenceDuration: duration,
      };
    });
  }, [timelineEntries]);
  const timelineDurationSeconds = useMemo(() => {
    if (timelineSequenceEntries.length === 0) return 0;
    return timelineSequenceEntries[timelineSequenceEntries.length - 1].sequenceEnd;
  }, [timelineSequenceEntries]);
  const timelineTrackDurationSeconds = useMemo(() => {
    return Math.max(15, timelineDurationSeconds + 4);
  }, [timelineDurationSeconds]);
  const timelineTrackWidthPx = useMemo(() => {
    return Math.max(960, Math.ceil(timelineTrackDurationSeconds * timelinePixelsPerSecond) + 80);
  }, [timelinePixelsPerSecond, timelineTrackDurationSeconds]);
  const timelineEntryById = useMemo(() => {
    const map = new Map();
    timelineSequenceEntries.forEach((entry) => {
      map.set(entry.item.id, entry);
    });
    return map;
  }, [timelineSequenceEntries]);
  const timelineRulerStepSeconds = useMemo(() => {
    if (timelinePixelsPerSecond >= 180) return 0.25;
    if (timelinePixelsPerSecond >= 120) return 0.5;
    if (timelinePixelsPerSecond >= 70) return 1;
    if (timelinePixelsPerSecond >= 36) return 2;
    if (timelinePixelsPerSecond >= 18) return 5;
    return 10;
  }, [timelinePixelsPerSecond]);
  const timelineRulerTicks = useMemo(() => {
    const ticks = [];
    const count = Math.ceil(timelineTrackDurationSeconds / timelineRulerStepSeconds);
    for (let index = 0; index <= count; index += 1) {
      const seconds = index * timelineRulerStepSeconds;
      ticks.push({
        seconds,
        isMajor: index % Math.round(Math.max(1, 5 / timelineRulerStepSeconds)) === 0,
      });
    }
    return ticks;
  }, [timelineRulerStepSeconds, timelineTrackDurationSeconds]);
  const multicamTrackWidthPx = useMemo(() => {
    return Math.max(960, Math.ceil(multicamTrackDurationSeconds * timelinePixelsPerSecond) + 80);
  }, [multicamTrackDurationSeconds, timelinePixelsPerSecond]);
  const multicamRulerTicks = useMemo(() => {
    const ticks = [];
    const count = Math.ceil(multicamTrackDurationSeconds / timelineRulerStepSeconds);
    for (let index = 0; index <= count; index += 1) {
      const seconds = index * timelineRulerStepSeconds;
      ticks.push({
        seconds,
        isMajor: index % Math.round(Math.max(1, 5 / timelineRulerStepSeconds)) === 0,
      });
    }
    return ticks;
  }, [multicamTrackDurationSeconds, timelineRulerStepSeconds]);

  const hasPlayableTimelineClip = useMemo(() => {
    return timelineEntries.some((entry) => Boolean(getClipPlaybackUrl(entry.clip)));
  }, [timelineEntries]);

  const findPlayableTimelineIndex = useCallback((startIndex, { wrap = false } = {}) => {
    const normalizedStart = Math.max(0, startIndex);

    for (let index = normalizedStart; index < timelineEntries.length; index += 1) {
      if (getClipPlaybackUrl(timelineEntries[index]?.clip)) return index;
    }

    if (wrap && normalizedStart > 0) {
      for (let index = 0; index < normalizedStart; index += 1) {
        if (getClipPlaybackUrl(timelineEntries[index]?.clip)) return index;
      }
    }

    return -1;
  }, [timelineEntries]);

  const stopTimelinePlayback = useCallback((message = '') => {
    setIsTimelinePlaying(false);
    timelineAutoPlayRef.current = false;
    timelineAdvanceThrottleRef.current = 0;
    if (message) setLocalStatus(message);
  }, []);

  const advanceTimelinePlayback = useCallback(() => {
    if (timelineEntries.length === 0) {
      stopTimelinePlayback('Timeline is empty.');
      return;
    }

    const currentIndex = timelineEntries.findIndex((entry) => entry.item.id === effectivePlaybackTimelineItemId);
    const nextIndex = findPlayableTimelineIndex(currentIndex + 1, { wrap: false });

    if (nextIndex < 0) {
      stopTimelinePlayback('Reached end of grouped timeline playback.');
      return;
    }

    const nextEntry = timelineEntries[nextIndex];
    setPlaybackTimelineItemId(nextEntry.item.id);
    setSelectedTimelineItemId(nextEntry.item.id);
    const sequenceEntry = timelineEntryById.get(nextEntry.item.id);
    if (sequenceEntry) {
      setTimelinePlayheadSeconds(sequenceEntry.sequenceStart);
    }
    timelineAutoPlayRef.current = true;
    setLocalStatus(`Playing grouped timeline (${nextIndex + 1}/${timelineEntries.length}).`);
  }, [effectivePlaybackTimelineItemId, findPlayableTimelineIndex, stopTimelinePlayback, timelineEntries, timelineEntryById]);

  const startTimelinePlayback = useCallback((fromSelected = true) => {
    if (timelineEntries.length === 0) {
      setLocalStatus('Add clips to the timeline first.');
      return;
    }

    const selectedIndex = timelineEntries.findIndex((entry) => entry.item.id === effectiveSelectedTimelineItemId);
    const startIndex = fromSelected && selectedIndex >= 0 ? selectedIndex : 0;
    const playableIndex = findPlayableTimelineIndex(startIndex, { wrap: true });

    if (playableIndex < 0) {
      setLocalStatus('No rendered clip files found on the timeline yet. Render clips first, then play as one.');
      return;
    }

    const entry = timelineEntries[playableIndex];
    setPreviewMode('timeline');
    setPlaybackTimelineItemId(entry.item.id);
    setSelectedTimelineItemId(entry.item.id);
    const sequenceEntry = timelineEntryById.get(entry.item.id);
    if (sequenceEntry) {
      setTimelinePlayheadSeconds(sequenceEntry.sequenceStart);
    }
    setIsTimelinePlaying(true);
    timelineAutoPlayRef.current = true;
    timelineAdvanceThrottleRef.current = 0;
    setLocalStatus(`Playing grouped timeline (${playableIndex + 1}/${timelineEntries.length}).`);
  }, [effectiveSelectedTimelineItemId, findPlayableTimelineIndex, timelineEntries, timelineEntryById]);

  const resumeTimelinePlayback = useCallback(() => {
    if (previewMode !== 'timeline') {
      startTimelinePlayback(true);
      return;
    }

    if (!playbackTimelineItemId) {
      startTimelinePlayback(true);
      return;
    }

    setIsTimelinePlaying(true);
    timelineAutoPlayRef.current = true;
    previewRef.current?.play?.().catch(() => { });
    setLocalStatus('Resumed grouped timeline playback.');
  }, [playbackTimelineItemId, previewMode, startTimelinePlayback]);

  const handleCreateProject = () => {
    const trimmedName = newProjectName.trim();
    if (!trimmedName) {
      setLocalStatus('Enter a project name first.');
      return;
    }
    const created = onCreateProject?.(trimmedName);
    setNewProjectName('');
    setLocalStatus(created ? `Created project "${trimmedName}".` : 'Unable to create project.');
  };

  const handleRenameProject = () => {
    if (!selectedProjectId) {
      setLocalStatus('Select a project first.');
      return;
    }

    const trimmed = String(projectNameDraft || '').trim();
    if (!trimmed) {
      setLocalStatus('Enter a project name first.');
      return;
    }

    const renamed = onRenameProject?.(selectedProjectId, trimmed);
    setLocalStatus(renamed ? `Project renamed to "${trimmed}".` : 'No project rename was applied.');
  };

  const handleMediaDragStart = (event, clipId) => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(DND_PAYLOAD_KEY, JSON.stringify({ type: 'vault-clip', clipId }));
  };

  const handleTimelineDragStart = (event, timelineItemId) => {
    if (trimDragStateRef.current) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DND_PAYLOAD_KEY, JSON.stringify({
      type: 'timeline-item',
      timelineItemId,
      projectId: selectedProjectId,
    }));
  };

  const getTimelineSecondsFromClientX = useCallback((clientX) => {
    const track = timelineTrackRef.current;
    if (!track) return null;
    const bounds = track.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    return ratio * timelineTrackDurationSeconds;
  }, [timelineTrackDurationSeconds]);

  const getTimelineInsertIndexForSeconds = useCallback((secondsRaw) => {
    const seconds = clamp(Number(secondsRaw) || 0, 0, timelineTrackDurationSeconds);
    for (let index = 0; index < timelineSequenceEntries.length; index += 1) {
      const entry = timelineSequenceEntries[index];
      const midpoint = entry.sequenceStart + (entry.sequenceDuration / 2);
      if (seconds < midpoint) return index;
    }
    return timelineSequenceEntries.length;
  }, [timelineSequenceEntries, timelineTrackDurationSeconds]);

  const seekTimelineToSeconds = useCallback((secondsRaw, options = {}) => {
    const seconds = clamp(Number(secondsRaw) || 0, 0, timelineTrackDurationSeconds);
    setTimelinePlayheadSeconds(seconds);

    if (timelineSequenceEntries.length === 0) return;
    const sequenceEntry = timelineSequenceEntries.find((entry) => (
      seconds >= entry.sequenceStart && seconds <= entry.sequenceEnd
    )) || timelineSequenceEntries[timelineSequenceEntries.length - 1];
    if (!sequenceEntry?.item?.id) return;

    setSelectedTimelineItemId(sequenceEntry.item.id);
    if (previewMode === 'timeline') {
      setPlaybackTimelineItemId(sequenceEntry.item.id);
    }

    const range = getTimelineEntryTrimRange(sequenceEntry);
    const relative = clamp(seconds - sequenceEntry.sequenceStart, 0, sequenceEntry.sequenceDuration);
    const clipSeconds = clamp(range.start + relative, range.start, range.end);
    setCurrentPreviewTime(clipSeconds);

    if (previewRef.current && options.updatePreview !== false && getClipPlaybackUrl(sequenceEntry.clip)) {
      try {
        previewRef.current.currentTime = clipSeconds;
      } catch {
        // ignore seek edge cases
      }
      if (options.resumePlayback === true) {
        previewRef.current.play?.().catch(() => { });
      }
    }
  }, [previewMode, timelineSequenceEntries, timelineTrackDurationSeconds]);

  const handleTimelineRulerPointerDown = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (timelineSequenceEntries.length === 0) return;
    event.preventDefault();
    event.stopPropagation();

    const targetSeconds = getTimelineSecondsFromClientX(event.clientX);
    if (!Number.isFinite(targetSeconds)) return;

    timelinePlayheadDragRef.current = {
      pointerId: event.pointerId,
    };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    seekTimelineToSeconds(targetSeconds, { updatePreview: true });
  }, [getTimelineSecondsFromClientX, seekTimelineToSeconds, timelineSequenceEntries.length]);

  const handleMulticamRulerPointerDown = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (multicamSegments.length === 0) return;
    event.preventDefault();
    event.stopPropagation();

    const targetSeconds = getTimelineSecondsFromClientX(event.clientX);
    if (!Number.isFinite(targetSeconds)) return;

    timelinePlayheadDragRef.current = {
      pointerId: event.pointerId,
      multicam: true,
    };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    setTimelinePlayheadSeconds(clamp(targetSeconds, 0, multicamTrackDurationSeconds));
    setCurrentPreviewTime(clamp(targetSeconds, 0, multicamTrackDurationSeconds));
  }, [getTimelineSecondsFromClientX, multicamSegments.length, multicamTrackDurationSeconds]);

  const handleTimelineTrackDrop = useCallback((event) => {
    event.preventDefault();
    const payload = parseDragPayload(event);
    if (!payload) return;

    if (!selectedProjectId) {
      setLocalStatus('Create or select a montage project first.');
      return;
    }

    const seconds = getTimelineSecondsFromClientX(event.clientX);
    const targetIndex = getTimelineInsertIndexForSeconds(Number.isFinite(seconds) ? seconds : timelineTrackDurationSeconds);

    if (payload.type === 'vault-clip' && payload.clipId) {
      const added = onAddClipToProject?.(payload.clipId, selectedProjectId, targetIndex);
      setLocalStatus(added ? 'Clip added to timeline.' : 'Unable to add clip to timeline.');
      return;
    }

    if (payload.type === 'timeline-item' && payload.timelineItemId && payload.projectId === selectedProjectId) {
      onMoveTimelineItem?.(selectedProjectId, payload.timelineItemId, targetIndex);
    }
  }, [
    getTimelineInsertIndexForSeconds,
    getTimelineSecondsFromClientX,
    onAddClipToProject,
    onMoveTimelineItem,
    selectedProjectId,
    timelineTrackDurationSeconds,
  ]);

  const buildTrimUpdatePatch = useCallback((patch = {}) => {
    return {
      ...patch,
      captionConfirmationStatus: 'pending',
      captionConfirmedText: '',
      captionConfirmedAt: '',
    };
  }, []);

  const handleSelectTimelineItem = useCallback((timelineItemId) => {
    setSelectedTimelineItemId(timelineItemId);
    if (previewMode === 'timeline') {
      setPlaybackTimelineItemId(timelineItemId);
      timelineAutoPlayRef.current = isTimelinePlaying;
    }
  }, [isTimelinePlaying, previewMode]);

  const handleTimelineItemDoubleClick = useCallback((entry) => {
    if (!entry?.item?.id) return;
    if (!getClipPlaybackUrl(entry?.clip)) {
      setLocalStatus('This timeline clip does not have a rendered file yet.');
      return;
    }

    handleSelectTimelineItem(entry.item.id);
    stopTimelinePlayback('');
    setPreviewMode('selected');
    setPlaybackTimelineItemId('');

    const range = getTimelineEntryTrimRange(entry);
    selectedPreviewAutoPlayRef.current = true;
    setCurrentPreviewTime(range.start);
    const sequenceEntry = timelineEntryById.get(entry.item.id);
    if (sequenceEntry) {
      setTimelinePlayheadSeconds(sequenceEntry.sequenceStart);
    }

    if (previewRef.current) {
      try {
        previewRef.current.currentTime = range.start;
      } catch {
        // ignore currentTime errors during source swaps
      }
      previewRef.current.play?.()
        .then(() => {
          selectedPreviewAutoPlayRef.current = false;
        })
        .catch(() => {
          // loadedmetadata handler will retry if needed
        });
    }

    setLocalStatus('Playing selected clip preview.');
  }, [handleSelectTimelineItem, stopTimelinePlayback, timelineEntryById]);

  const buildRenderableItemFromEntry = useCallback((entry, index) => {
    const renderUrl = getClipRenderUrl(entry?.clip);
    const token = extractRenderedClipToken(renderUrl);
    if (!token) return null;

    const range = getTimelineEntryTrimRange(entry);
    const title = String(entry?.clip?.title || `Edited Clip ${index + 1}`).trim() || `Edited Clip ${index + 1}`;
    const effectsPreset = String(entry?.item?.effectsPreset || 'none').trim() || 'none';
    const effectsIntensity = clamp(Number(entry?.item?.effectsIntensity) || 100, 0, 100);
    const speechCleanup = resolveEffectiveSpeechCleanup({
      item: entry?.item,
      projectDefaults: dialogueTrackDefaults,
    });
    const captionPayload = buildCaptionPayloadForEntry(entry);
    return {
      token,
      title,
      trimStartSeconds: Number(range.start.toFixed(2)),
      trimEndSeconds: Number(range.end.toFixed(2)),
      effectsPreset,
      effectsIntensity: Number(effectsIntensity.toFixed(0)),
      speechCleanupEnabled: Boolean(speechCleanup.enabled),
      speechCleanupPreset: String(speechCleanup.preset || DEFAULT_SPEECH_CLEANUP_PRESET),
      captionEnabled: Boolean(captionPayload.enabled),
      captionStylePreset: String(captionPayload.stylePreset || 'reel-bold'),
      captionCues: Array.isArray(captionPayload.cues)
        ? captionPayload.cues.map((cue) => ({
          text: String(cue.text || ''),
          startSeconds: Number(Number(cue.startSeconds || 0).toFixed(2)),
          endSeconds: Number(Number(cue.endSeconds || 0).toFixed(2)),
          words: Array.isArray(cue.words)
            ? cue.words.map((word) => ({
              text: String(word.text || ''),
              startSeconds: Number(Number(word.startSeconds || 0).toFixed(2)),
              endSeconds: Number(Number(word.endSeconds || 0).toFixed(2)),
            }))
            : [],
        }))
        : [],
    };
  }, [dialogueTrackDefaults]);

  const renderEditedGroup = useCallback(async () => {
    const allItems = timelineEntries
      .map((entry, index) => buildRenderableItemFromEntry(entry, index))
      .filter(Boolean);
    const items = allItems.slice(0, MAX_TIMELINE_RENDER_ITEMS);

    if (items.length === 0) {
      setLocalStatus('No server-rendered timeline clips available to render as a group.');
      return;
    }
    if (items.length < 2) {
      setLocalStatus('Add at least 2 rendered clips to the timeline for a montage render.');
      return;
    }

    setIsRenderingEditedGroup(true);
    try {
      const result = await renderTimelineEdits({
        mode: 'group',
        montageTitle: selectedProject?.name || 'Montage',
        items,
      });
      const montage = result.data?.montage;
      if (!montage?.downloadUrl) {
        setLocalStatus('Group render completed but no downloadable montage was returned.');
        return;
      }

      setRenderedEditDownloads((previous) => [montage, ...previous].slice(0, 25));
      const truncated = allItems.length > items.length;
      setLocalStatus(
        truncated
          ? `Rendered grouped montage from ${items.length} clips (first ${MAX_TIMELINE_RENDER_ITEMS} of ${allItems.length}).`
          : `Rendered grouped montage from ${items.length} clips.`
      );
    } catch (error) {
      setLocalStatus(`Group render failed: ${error.message || 'Unknown error'}`);
    } finally {
      setIsRenderingEditedGroup(false);
    }
  }, [buildRenderableItemFromEntry, renderTimelineEdits, selectedProject?.name, timelineEntries]);

  const startTimelineTrimDrag = useCallback((event, entry, edge, cardWidthPx) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selectedProjectId || !entry?.item?.id) return;
    const range = getTimelineEntryTrimRange(entry);
    if (!Number.isFinite(range.clipDuration) || range.clipDuration <= 0) {
      setLocalStatus('This clip does not have a known duration to drag-trim.');
      return;
    }
    const visibleDuration = Math.max(TRIM_MIN_GAP_SECONDS, range.end - range.start);
    const secondsPerPixel = visibleDuration / Math.max(40, Number(cardWidthPx) || 40);

    trimDragStateRef.current = {
      edge,
      projectId: selectedProjectId,
      timelineItemId: entry.item.id,
      clipDuration: range.clipDuration,
      secondsPerPixel,
      pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
      startX: event.clientX,
      initialStart: range.start,
      initialEnd: range.end,
    };

    handleSelectTimelineItem(entry.item.id);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [handleSelectTimelineItem, selectedProjectId]);

  const handlePreviewLoadedMetadata = useCallback((event) => {
    const video = event.currentTarget;
    const range = previewTimelineEntry ? getTimelineEntryTrimRange(previewTimelineEntry) : null;

    if (range) {
      video.currentTime = range.start;
      setCurrentPreviewTime(range.start);
      const sequenceEntry = timelineEntryById.get(previewTimelineEntry?.item?.id);
      if (sequenceEntry) {
        const sequencePlayhead = sequenceEntry.sequenceStart;
        setTimelinePlayheadSeconds(sequencePlayhead);
      }
    } else {
      setCurrentPreviewTime(video.currentTime || 0);
    }

    if (previewMode === 'selected' && selectedPreviewAutoPlayRef.current) {
      selectedPreviewAutoPlayRef.current = false;
      video.play().catch(() => { });
      return;
    }

    if (previewMode === 'timeline' && isTimelinePlaying) {
      if (timelineAutoPlayRef.current) {
        timelineAutoPlayRef.current = false;
      }
      video.play().catch(() => { });
    }
  }, [isTimelinePlaying, previewMode, previewTimelineEntry, timelineEntryById]);

  useEffect(() => {
    if (!isMulticamProject || isMulticamPlaying) return undefined;
    if (multicamPreviewAnimationRef.current) {
      cancelAnimationFrame(multicamPreviewAnimationRef.current);
      multicamPreviewAnimationRef.current = null;
    }
    seekMulticamMediaToProgramSeconds(timelinePlayheadSeconds, { play: false });
    return undefined;
  }, [
    isMulticamPlaying,
    isMulticamProject,
    seekMulticamMediaToProgramSeconds,
    timelinePlayheadSeconds,
  ]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = directorShotDragRef.current;
      if (!dragState) return;
      if (event.pointerId !== dragState.pointerId) return;
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      const activePreset = multicamShotPresets.find((preset) => preset.id === dragState.shotId);
      const panLimit = getShotPanLimit(activePreset?.zoom || 1);
      const nextPanX = clamp(dragState.startPanX + (deltaX * 0.18), -panLimit, panLimit);
      const nextPanY = clamp(dragState.startPanY + (deltaY * 0.18), -panLimit, panLimit);
      updateMulticamShotPreset(dragState.shotId, {
        panX: Number(nextPanX.toFixed(2)),
        panY: Number(nextPanY.toFixed(2)),
      });
    };

    const finishDrag = (event) => {
      const dragState = directorShotDragRef.current;
      if (!dragState) return;
      if (event.pointerId !== dragState.pointerId) return;
      directorShotDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, [multicamShotPresets, updateMulticamShotPreset]);

  useEffect(() => {
    if (!isMulticamProject || !isProgramPreviewOpen) return undefined;
    const render = () => {
      drawProgramPreviewFrame();
      programPreviewAnimationRef.current = window.requestAnimationFrame(render);
    };
    render();
    return () => {
      if (programPreviewAnimationRef.current) {
        cancelAnimationFrame(programPreviewAnimationRef.current);
        programPreviewAnimationRef.current = null;
      }
    };
  }, [drawProgramPreviewFrame, isMulticamProject, isProgramPreviewOpen]);

  useEffect(() => {
    if (isMulticamProject) return;
    setIsProgramPreviewOpen(false);
  }, [isMulticamProject]);

  useEffect(() => {
    return () => {
      if (renderedProgramDownload?.url) {
        URL.revokeObjectURL(renderedProgramDownload.url);
      }
    };
  }, [renderedProgramDownload]);

  useEffect(() => {
    const handleWindowPointerMove = (event) => {
      const dragState = programPreviewWindowDragRef.current;
      if (dragState && event.pointerId === dragState.pointerId) {
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        setProgramPreviewRect((current) => ({
          ...current,
          x: dragState.startRect.x + deltaX,
          y: dragState.startRect.y + deltaY,
        }));
        return;
      }

      const resizeState = programPreviewWindowResizeRef.current;
      if (resizeState && event.pointerId === resizeState.pointerId) {
        const deltaX = event.clientX - resizeState.startX;
        const deltaY = event.clientY - resizeState.startY;
        const aspectRatio = Math.max(0.1, Number(resizeState.startRect.width || 720) / Math.max(1, Number(resizeState.startRect.height || 405)));
        const widthFromX = resizeState.startRect.width + deltaX;
        const heightFromY = resizeState.startRect.height + deltaY;
        const useWidthAsDriver = Math.abs(deltaX) >= Math.abs(deltaY * aspectRatio);

        let nextWidth;
        let nextHeight;
        if (useWidthAsDriver) {
          nextWidth = clamp(widthFromX, 360, 1400);
          nextHeight = clamp(nextWidth / aspectRatio, 220, 900);
          nextWidth = clamp(nextHeight * aspectRatio, 360, 1400);
        } else {
          nextHeight = clamp(heightFromY, 220, 900);
          nextWidth = clamp(nextHeight * aspectRatio, 360, 1400);
          nextHeight = clamp(nextWidth / aspectRatio, 220, 900);
        }

        setProgramPreviewRect((current) => ({
          ...current,
          width: nextWidth,
          height: nextHeight,
        }));
      }
    };

    const clearWindowPointerState = (event) => {
      if (programPreviewWindowDragRef.current?.pointerId === event.pointerId) {
        programPreviewWindowDragRef.current = null;
      }
      if (programPreviewWindowResizeRef.current?.pointerId === event.pointerId) {
        programPreviewWindowResizeRef.current = null;
      }
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', clearWindowPointerState);
    window.addEventListener('pointercancel', clearWindowPointerState);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', clearWindowPointerState);
      window.removeEventListener('pointercancel', clearWindowPointerState);
    };
  }, []);

  useEffect(() => {
    if (!isDirectorShotSetupActive || !selectedDirectorShotPreset || selectedDirectorShotPreset.locked) return undefined;

    const surfaceElement = directorSuiteSurfaceRef.current;
    const activePaneElement = directorPaneRefs.current[selectedDirectorShotPreset.cameraId];
    const rootElement = document.documentElement;
    const bodyElement = document.body;
    if (!surfaceElement || !activePaneElement || !rootElement || !bodyElement) return undefined;

    const previousRootOverscroll = rootElement.style.overscrollBehavior;
    const previousRootOverscrollX = rootElement.style.overscrollBehaviorX;
    const previousBodyOverscroll = bodyElement.style.overscrollBehavior;
    const previousBodyOverscrollX = bodyElement.style.overscrollBehaviorX;
    const previousSurfaceOverscroll = surfaceElement.style.overscrollBehavior;
    const previousSurfaceOverscrollX = surfaceElement.style.overscrollBehaviorX;

    rootElement.style.overscrollBehavior = 'none';
    rootElement.style.overscrollBehaviorX = 'none';
    bodyElement.style.overscrollBehavior = 'none';
    bodyElement.style.overscrollBehaviorX = 'none';
    surfaceElement.style.overscrollBehavior = 'none';
    surfaceElement.style.overscrollBehaviorX = 'none';

    const onWindowWheel = (event) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node)) return;
      if (!surfaceElement.contains(eventTarget)) return;
      event.preventDefault();
      event.stopPropagation?.();
      if (!activePaneElement.contains(eventTarget)) return;
      handleDirectorShotWheel(event, selectedDirectorShotPreset.cameraId);
    };

    window.addEventListener('wheel', onWindowWheel, { passive: false, capture: true });

    return () => {
      window.removeEventListener('wheel', onWindowWheel, { capture: true });
      rootElement.style.overscrollBehavior = previousRootOverscroll;
      rootElement.style.overscrollBehaviorX = previousRootOverscrollX;
      bodyElement.style.overscrollBehavior = previousBodyOverscroll;
      bodyElement.style.overscrollBehaviorX = previousBodyOverscrollX;
      surfaceElement.style.overscrollBehavior = previousSurfaceOverscroll;
      surfaceElement.style.overscrollBehaviorX = previousSurfaceOverscrollX;
    };
  }, [handleDirectorShotWheel, isDirectorShotSetupActive, selectedDirectorShotPreset]);

  useEffect(() => {
    if (!isMulticamProject || !isMulticamPlaying) return undefined;
    seekMulticamMediaToProgramSeconds(multicamProgramSecondsRef.current, { play: true });
    multicamPreviewAnimationRef.current = window.requestAnimationFrame(syncMulticamPreviewFrame);
    return () => {
      if (multicamPreviewAnimationRef.current) {
        cancelAnimationFrame(multicamPreviewAnimationRef.current);
        multicamPreviewAnimationRef.current = null;
      }
    };
  }, [
    isMulticamPlaying,
    isMulticamProject,
    seekMulticamMediaToProgramSeconds,
    syncMulticamPreviewFrame,
  ]);

  useEffect(() => {
    if (!isMulticamProject) return undefined;

    const handleKeyDown = (event) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      );
      if (isEditable) return;

      if (event.code === 'Space') {
        event.preventDefault();
        if (isMulticamPlaying) {
          pauseSelectedMulticamProgram();
        } else {
          playSelectedMulticamProgram();
        }
        return;
      }

      if (event.ctrlKey && !event.metaKey && event.code === 'KeyT') {
        event.preventDefault();
        splitSelectedMulticamSegment();
        return;
      }

      if (event.ctrlKey && !event.metaKey && event.code === 'KeyJ') {
        event.preventDefault();
        joinSelectedMulticamSegment();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isMulticamPlaying,
    isMulticamProject,
    joinSelectedMulticamSegment,
    pauseSelectedMulticamProgram,
    playSelectedMulticamProgram,
    splitSelectedMulticamSegment,
  ]);

  useEffect(() => {
    if (!isMulticamProject || isDirectorShotSetupActive) return undefined;

    const scroller = timelineScrollerRef.current;
    const rootElement = document.documentElement;
    const bodyElement = document.body;
    if (!scroller || !rootElement || !bodyElement) return undefined;

    const previousRootOverscroll = rootElement.style.overscrollBehaviorX;
    const previousBodyOverscroll = bodyElement.style.overscrollBehaviorX;
    const previousScrollerOverscroll = scroller.style.overscrollBehaviorX;

    rootElement.style.overscrollBehaviorX = 'none';
    bodyElement.style.overscrollBehaviorX = 'none';
    scroller.style.overscrollBehaviorX = 'none';

    const onWheel = (event) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node)) return;
      if (!scroller.contains(eventTarget)) return;
      if (event.ctrlKey || event.metaKey) return;

      const deltaX = Number(event.deltaX || 0);
      const deltaY = Number(event.deltaY || 0);
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

      event.preventDefault();
      event.stopPropagation?.();
      const nextScrollLeft = scroller.scrollLeft + deltaX + (Math.abs(deltaX) < Math.abs(deltaY) ? deltaY : 0);
      scroller.scrollLeft = Math.max(0, nextScrollLeft);
    };

    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });
      rootElement.style.overscrollBehaviorX = previousRootOverscroll;
      bodyElement.style.overscrollBehaviorX = previousBodyOverscroll;
      scroller.style.overscrollBehaviorX = previousScrollerOverscroll;
    };
  }, [isDirectorShotSetupActive, isMulticamProject]);

  const handlePreviewTimeUpdate = useCallback((event) => {
    const video = event.currentTarget;
    const nextTime = Number(video.currentTime || 0);
    setCurrentPreviewTime(nextTime);
    if (previewTimelineEntry?.item?.id) {
      const sequenceEntry = timelineEntryById.get(previewTimelineEntry.item.id);
      if (sequenceEntry) {
        const range = getTimelineEntryTrimRange(previewTimelineEntry);
        const relative = clamp(nextTime - range.start, 0, sequenceEntry.sequenceDuration);
        setTimelinePlayheadSeconds(sequenceEntry.sequenceStart + relative);
      }
    }

    if (previewMode !== 'timeline' || !isTimelinePlaying || !previewTimelineEntry) return;

    const { end } = getTimelineEntryTrimRange(previewTimelineEntry);
    if (!Number.isFinite(end)) return;
    if (nextTime + 0.02 < end) return;

    const nowMs = Date.now();
    if (nowMs < timelineAdvanceThrottleRef.current) return;
    timelineAdvanceThrottleRef.current = nowMs + 250;

    video.pause();
    advanceTimelinePlayback();
  }, [advanceTimelinePlayback, isTimelinePlaying, previewMode, previewTimelineEntry, timelineEntryById]);

  const handlePreviewEnded = useCallback(() => {
    if (previewMode !== 'timeline' || !isTimelinePlaying) return;

    const nowMs = Date.now();
    if (nowMs < timelineAdvanceThrottleRef.current) return;
    timelineAdvanceThrottleRef.current = nowMs + 250;
    advanceTimelinePlayback();
  }, [advanceTimelinePlayback, isTimelinePlaying, previewMode]);

  useEffect(() => {
    if (!previewRef.current || previewMode !== 'selected' || !selectedTimelineEntry) return;
    const { start } = getTimelineEntryTrimRange(selectedTimelineEntry);
    previewRef.current.currentTime = start;
    const sequenceEntry = timelineEntryById.get(selectedTimelineEntry.item.id);
    if (sequenceEntry) {
      setTimelinePlayheadSeconds(sequenceEntry.sequenceStart);
    }
  }, [previewMode, selectedTimelineEntry, timelineEntryById]);

  useEffect(() => {
    if (!previewRef.current || previewMode !== 'timeline' || !playbackTimelineEntry) return;

    const { start } = getTimelineEntryTrimRange(playbackTimelineEntry);
    previewRef.current.currentTime = start;
    const sequenceEntry = timelineEntryById.get(playbackTimelineEntry.item.id);
    if (sequenceEntry) {
      setTimelinePlayheadSeconds(sequenceEntry.sequenceStart);
    }

    if (isTimelinePlaying) {
      previewRef.current.play().catch(() => { });
    }
  }, [isTimelinePlaying, playbackTimelineEntry, playbackTimelineItemId, previewMode, timelineEntryById]);

  useEffect(() => {
    if (!previewTimelineEntry?.item?.id) return;
    const sequenceEntry = timelineEntryById.get(previewTimelineEntry.item.id);
    if (!sequenceEntry) return;
    const range = getTimelineEntryTrimRange(previewTimelineEntry);
    const relative = clamp(Number(currentPreviewTime || 0) - range.start, 0, sequenceEntry.sequenceDuration);
    setTimelinePlayheadSeconds(sequenceEntry.sequenceStart + relative);
  }, [currentPreviewTime, previewTimelineEntry, timelineEntryById]);

  useEffect(() => {
    setTimelinePlayheadSeconds((previous) => clamp(previous, 0, timelineTrackDurationSeconds));
  }, [timelineTrackDurationSeconds]);

  useEffect(() => {
    const scroller = timelineScrollerRef.current;
    if (!scroller) return;
    const targetX = timelinePlayheadSeconds * timelinePixelsPerSecond;
    const leftBound = scroller.scrollLeft + 80;
    const rightBound = scroller.scrollLeft + scroller.clientWidth - 120;
    if (targetX < leftBound) {
      scroller.scrollLeft = Math.max(0, targetX - 80);
      return;
    }
    if (targetX > rightBound) {
      scroller.scrollLeft = Math.max(0, targetX - scroller.clientWidth + 120);
    }
  }, [timelinePixelsPerSecond, timelinePlayheadSeconds]);

  useEffect(() => {
    const handleMouseMove = (event) => {
      const resizeState = paneResizeStateRef.current;
      if (!resizeState) return;

      if (resizeState.type === 'media') {
        const nextWidth = clamp(
          resizeState.startWidth + (event.clientX - resizeState.startX),
          MEDIA_BIN_MIN_WIDTH,
          MEDIA_BIN_MAX_WIDTH
        );
        setMediaBinWidth(nextWidth);
        return;
      }

      if (resizeState.type === 'monitor') {
        const nextHeight = clamp(
          resizeState.startHeight + (event.clientY - resizeState.startY),
          MONITOR_MIN_HEIGHT,
          MONITOR_MAX_HEIGHT
        );
        setMonitorHeight(nextHeight);
      }
    };

    const handleMouseUp = () => {
      if (!paneResizeStateRef.current) return;
      paneResizeStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = trimDragStateRef.current;
      if (!dragState) return;
      if (Number.isFinite(dragState.pointerId) && event.pointerId !== dragState.pointerId) return;

      const deltaX = event.clientX - dragState.startX;
      const deltaSeconds = deltaX * dragState.secondsPerPixel;

      if (dragState.edge === 'start') {
        const nextStart = clamp(
          dragState.initialStart + deltaSeconds,
          0,
          dragState.initialEnd - TRIM_MIN_GAP_SECONDS
        );
        onUpdateTimelineItem?.(
          dragState.projectId,
          dragState.timelineItemId,
          buildTrimUpdatePatch({
            trimStartSeconds: Number(nextStart.toFixed(2)),
          })
        );
        return;
      }

      const nextEnd = clamp(
        dragState.initialEnd + deltaSeconds,
        dragState.initialStart + TRIM_MIN_GAP_SECONDS,
        dragState.clipDuration
      );
      onUpdateTimelineItem?.(
        dragState.projectId,
        dragState.timelineItemId,
        buildTrimUpdatePatch({
          trimEndSeconds: Number(nextEnd.toFixed(2)),
        })
      );
    };

    const finishPointerDrag = (event) => {
      if (!trimDragStateRef.current) return;
      const dragState = trimDragStateRef.current;
      if (event && Number.isFinite(dragState.pointerId) && event.pointerId !== dragState.pointerId) return;
      trimDragStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishPointerDrag);
    window.addEventListener('pointercancel', finishPointerDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishPointerDrag);
      window.removeEventListener('pointercancel', finishPointerDrag);
    };
  }, [buildTrimUpdatePatch, onUpdateTimelineItem]);

  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = timelinePlayheadDragRef.current;
      if (!dragState) return;
      if (event.pointerId !== dragState.pointerId) return;
      const seconds = getTimelineSecondsFromClientX(event.clientX);
      if (!Number.isFinite(seconds)) return;
      if (dragState.multicam) {
        const nextSeconds = clamp(seconds, 0, multicamTrackDurationSeconds);
        setTimelinePlayheadSeconds(nextSeconds);
        setCurrentPreviewTime(nextSeconds);
        return;
      }
      seekTimelineToSeconds(seconds, { updatePreview: true });
    };

    const handlePointerUp = (event) => {
      const dragState = timelinePlayheadDragRef.current;
      if (!dragState) return;
      if (event.pointerId !== dragState.pointerId) return;
      timelinePlayheadDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [getTimelineSecondsFromClientX, multicamTrackDurationSeconds, seekTimelineToSeconds]);

  const startPaneResize = useCallback((type) => (event) => {
    event.preventDefault();

    if (type === 'media' && isMediaBinCollapsed) return;

    paneResizeStateRef.current = {
      type,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: mediaBinWidth,
      startHeight: monitorHeight,
    };

    document.body.style.cursor = type === 'monitor' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isMediaBinCollapsed, mediaBinWidth, monitorHeight]);

  return (
    <>
      <section className="glass rounded-3xl p-5 lg:p-6 space-y-4 min-h-[200vh]">
        {isMulticamProject && sidebarBottomPortalNode ? createPortal(
          <div className="rounded-2xl border border-emerald-300/70 dark:border-emerald-700/70 bg-emerald-50/80 dark:bg-emerald-950/20 px-4 py-3 mx-4 mb-4">
            <div className="flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px] text-emerald-700 dark:text-emerald-300">video_camera_front</span>
                  <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">Multicam Mode</div>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-emerald-800/80 dark:text-emerald-200/80">
                  Editing a synced two-camera project. Camera A is the top track, Camera B is the bottom track, and each segment controls which shot preset is live in the program output.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold">
                <span className="rounded-md bg-emerald-600/90 text-white px-2 py-0.5">Green = Active</span>
                <span className="rounded-md bg-rose-600/90 text-white px-2 py-0.5">Red = Inactive</span>
                <span className="rounded-md bg-slate-800/90 text-white px-2 py-0.5">Ctrl+T Cut</span>
                <span className="rounded-md bg-slate-800/90 text-white px-2 py-0.5">Ctrl+J Join</span>
              </div>
            </div>
          </div>,
          sidebarBottomPortalNode
        ) : null}

        <div className="flex flex-col lg:flex-row gap-4 lg:gap-0 h-full">
          {isMulticamProject && sidebarPortalNode ? createPortal(
            <div className="px-4 pb-4 space-y-4">
              <div className="space-y-2">
                <label htmlFor="new-montage-project" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  New Montage
                </label>
                <div className="flex gap-2">
                  <input
                    id="new-montage-project"
                    name="newMontageProject"
                    type="text"
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleCreateProject();
                      }
                    }}
                    placeholder="Best Of Session"
                    className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    onClick={handleCreateProject}
                    className="bg-primary text-white px-3 py-2 rounded-lg text-xs font-semibold"
                  >
                    Create
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="select-montage-project" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Active Project
                </label>
                <select
                  id="select-montage-project"
                  name="selectMontageProject"
                  value={selectedProjectId}
                  onChange={(event) => onSelectedProjectChange?.(event.target.value)}
                  className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select project...</option>
                  {montageProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label htmlFor="rename-montage-project" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Project Name
                </label>
                <div className="flex gap-2">
                  <input
                    id="rename-montage-project"
                    name="renameMontageProject"
                    type="text"
                    value={projectNameDraft}
                    onChange={(event) => setProjectNameDraft(event.target.value)}
                    placeholder="Project name"
                    className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={handleRenameProject}
                    disabled={!selectedProjectId}
                    className="bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-100 px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Rename
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={!selectedProjectId || isRenderingMulticamProgram}
                  onClick={async () => {
                    if (!selectedProjectId) return;
                    await renderFinishedMulticamProgram();
                  }}
                  className="rounded-md border border-emerald-300/70 text-emerald-700 dark:text-emerald-300 dark:border-emerald-500/40 px-2 py-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isRenderingMulticamProgram ? 'Rendering…' : 'Render Finished Product'}
                </button>
                <button
                  type="button"
                  disabled={!selectedProjectId}
                  onClick={async () => {
                    if (!selectedProjectId) return;
                    const confirmed = window.confirm('Flush cached clip files for this project?');
                    if (!confirmed) return;
                    const ok = await onFlushProjectMedia?.(selectedProjectId);
                    setLocalStatus(ok ? 'Project media cache cleared.' : 'Unable to clear project media cache.');
                  }}
                  className="rounded-md border border-amber-300/70 text-amber-700 dark:text-amber-300 dark:border-amber-500/40 px-2 py-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Flush Media
                </button>
                <button
                  type="button"
                  disabled={!selectedProjectId}
                  onClick={async () => {
                    if (!selectedProjectId) return;
                    const confirmed = window.confirm('Delete this project and all clips in it?');
                    if (!confirmed) return;
                    const ok = await onDeleteProject?.(selectedProjectId);
                    setLocalStatus(ok ? 'Project deleted.' : 'Unable to delete project.');
                  }}
                  className="rounded-md border border-rose-300/70 text-rose-700 dark:text-rose-300 dark:border-rose-500/40 px-2 py-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete Project
                </button>
              </div>

              <div className="space-y-3 rounded-xl border border-slate-200/70 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 p-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Dialogue Track Default</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Speech Cleanup runs during backend render and export. New timeline clips inherit this by default.
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDialogueTrackDefaultToggle}
                    disabled={!selectedProjectId}
                    className={`rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-50 ${dialogueTrackDefaults.speechCleanupEnabled
                      ? 'bg-emerald-600 text-white'
                      : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                      }`}
                  >
                    {dialogueTrackDefaults.speechCleanupEnabled ? 'Speech Cleanup On' : 'Speech Cleanup Off'}
                  </button>
                  <select
                    value={dialogueTrackDefaults.speechCleanupPreset}
                    onChange={handleDialogueTrackDefaultPresetChange}
                    disabled={!selectedProjectId || !dialogueTrackDefaults.speechCleanupEnabled}
                    className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-100 disabled:opacity-50"
                    aria-label="Dialogue track default speech cleanup preset"
                  >
                    {SPEECH_CLEANUP_PRESET_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200/70 dark:border-slate-700/70 px-2.5 py-2 text-[11px] text-slate-600 dark:text-slate-300">
                Cached Media: <span className="font-semibold">{formatBytesLabel(mediaStats?.totalBytes)}</span> ({Number(mediaStats?.clipCount || 0)} clips)
              </div>

              <div className="rounded-lg border border-sky-300/40 dark:border-sky-500/35 bg-sky-50/70 dark:bg-sky-950/20 px-3 py-2 grid grid-cols-2 gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                <div>
                  Workflow: <span className="font-semibold text-slate-800 dark:text-slate-100">Two-Camera Podcast</span>
                </div>
                <div>
                  Assets: <span className="font-semibold text-slate-800 dark:text-slate-100">{Array.isArray(selectedProject?.mediaAssets) ? selectedProject.mediaAssets.length : 0}</span>
                </div>
                <div>
                  Sync: <span className="font-semibold text-slate-800 dark:text-slate-100">{Number.isFinite(Number(selectedProject?.syncMap?.offsetSeconds)) ? `${Number(selectedProject.syncMap.offsetSeconds).toFixed(2)}s` : '--'}</span>
                </div>
                <div>
                  Project Audio: <span className="font-semibold text-slate-800 dark:text-slate-100">{multicamAudioMixMode === 'stereo_mix' ? 'Synced Stereo Mix' : (String(selectedProject?.masterAudioAssetId || '').trim() || '--')}</span>
                </div>
              </div>
            </div>,
            sidebarPortalNode
          ) : null}

          {!isMulticamProject && isMediaBinCollapsed && (
            <button
              type="button"
              onClick={() => setIsMediaBinCollapsed(false)}
              className="hidden lg:inline-flex absolute left-4 top-[11.5rem] z-30 items-center justify-center rounded-r-xl rounded-l-md border border-slate-300/80 dark:border-slate-700/80 bg-white/90 dark:bg-slate-900/90 px-2 py-5 text-slate-700 dark:text-slate-200 shadow-lg shadow-black/10"
              aria-label="Open left control pane"
              title="Open left control pane"
            >
              <span className="material-symbols-outlined text-[18px]">left_panel_open</span>
            </button>
          )}
          {!isMulticamProject && !isMediaBinCollapsed && (
            <aside
              className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 p-4 space-y-3 lg:shrink-0"
              style={{ width: `min(100%, ${mediaBinWidth}px)` }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{isMulticamProject ? 'Director Suite' : 'Media Bin'}</div>
                <button
                  type="button"
                  onClick={() => setIsMediaBinCollapsed(true)}
                  className="inline-flex items-center justify-center rounded-md p-1.5 text-slate-500 hover:bg-slate-200/70 dark:hover:bg-slate-800/70"
                  aria-label="Collapse media bin"
                  title="Collapse media bin"
                >
                  <span className="material-symbols-outlined text-[18px]">left_panel_close</span>
                </button>
              </div>

              {sidebarPortalNode ? createPortal(
                <div className="px-4 pb-4 space-y-4">
                  <div className="space-y-2">
                    <label htmlFor="new-montage-project" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      New Montage
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="new-montage-project"
                        name="newMontageProject"
                        type="text"
                        value={newProjectName}
                        onChange={(event) => setNewProjectName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            handleCreateProject();
                          }
                        }}
                        placeholder="Best Of Session"
                        className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                      />
                      <button
                        onClick={handleCreateProject}
                        className="bg-primary text-white px-3 py-2 rounded-lg text-xs font-semibold"
                      >
                        Create
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="select-montage-project" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Active Project
                    </label>
                    <select
                      id="select-montage-project"
                      name="selectMontageProject"
                      value={selectedProjectId}
                      onChange={(event) => onSelectedProjectChange?.(event.target.value)}
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Select project...</option>
                      {montageProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="rename-montage-project" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Project Name
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="rename-montage-project"
                        name="renameMontageProject"
                        type="text"
                        value={projectNameDraft}
                        onChange={(event) => setProjectNameDraft(event.target.value)}
                        placeholder="Project name"
                        className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        onClick={handleRenameProject}
                        disabled={!selectedProjectId}
                        className="bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-100 px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Rename
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      disabled={!selectedProjectId || isRenderingMulticamProgram}
                      onClick={async () => {
                        if (!selectedProjectId) return;
                        if (isMulticamProject) {
                          await renderFinishedMulticamProgram();
                          return;
                        }
                        const result = await onExportProject?.(selectedProjectId);
                        const ok = typeof result === 'object'
                          ? Boolean(result?.success)
                          : Boolean(result);
                        const message = typeof result === 'object'
                          ? String(result?.message || '')
                          : '';
                        setLocalStatus(message || (ok ? 'Project export started.' : 'Unable to export project.'));
                      }}
                      className="rounded-md border border-emerald-300/70 text-emerald-700 dark:text-emerald-300 dark:border-emerald-500/40 px-2 py-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isMulticamProject ? (isRenderingMulticamProgram ? 'Rendering…' : 'Render Finished Product') : 'Export Project'}
                    </button>
                    <button
                      type="button"
                      disabled={!selectedProjectId}
                      onClick={async () => {
                        if (!selectedProjectId) return;
                        const confirmed = window.confirm('Flush cached clip files for this project?');
                        if (!confirmed) return;
                        const ok = await onFlushProjectMedia?.(selectedProjectId);
                        setLocalStatus(ok ? 'Project media cache cleared.' : 'Unable to clear project media cache.');
                      }}
                      className="rounded-md border border-amber-300/70 text-amber-700 dark:text-amber-300 dark:border-amber-500/40 px-2 py-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Flush Media
                    </button>
                    <button
                      type="button"
                      disabled={!selectedProjectId}
                      onClick={async () => {
                        if (!selectedProjectId) return;
                        const confirmed = window.confirm('Delete this project and all clips in it?');
                        if (!confirmed) return;
                        const ok = await onDeleteProject?.(selectedProjectId);
                        setLocalStatus(ok ? 'Project deleted.' : 'Unable to delete project.');
                      }}
                      className="rounded-md border border-rose-300/70 text-rose-700 dark:text-rose-300 dark:border-rose-500/40 px-2 py-1.5 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Delete Project
                    </button>
                  </div>

                  <div className="space-y-3 rounded-xl border border-slate-200/70 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Dialogue Track Default</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        Speech Cleanup runs during backend render and export. New timeline clips inherit this by default.
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleDialogueTrackDefaultToggle}
                        disabled={!selectedProjectId}
                        className={`rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-50 ${dialogueTrackDefaults.speechCleanupEnabled
                          ? 'bg-emerald-600 text-white'
                          : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                          }`}
                      >
                        {dialogueTrackDefaults.speechCleanupEnabled ? 'Speech Cleanup On' : 'Speech Cleanup Off'}
                      </button>
                      <select
                        value={dialogueTrackDefaults.speechCleanupPreset}
                        onChange={handleDialogueTrackDefaultPresetChange}
                        disabled={!selectedProjectId || !dialogueTrackDefaults.speechCleanupEnabled}
                        className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-100 disabled:opacity-50"
                        aria-label="Dialogue track default speech cleanup preset"
                      >
                        {SPEECH_CLEANUP_PRESET_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200/70 dark:border-slate-700/70 px-2.5 py-2 text-[11px] text-slate-600 dark:text-slate-300">
                    Cached Media: <span className="font-semibold">{formatBytesLabel(mediaStats?.totalBytes)}</span> ({Number(mediaStats?.clipCount || 0)} clips)
                  </div>

                  {selectedProject?.workflowType === 'multicam' ? (
                    <div className="rounded-lg border border-sky-300/40 dark:border-sky-500/35 bg-sky-50/70 dark:bg-sky-950/20 px-3 py-2 grid grid-cols-2 gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                      <div>
                        Workflow: <span className="font-semibold text-slate-800 dark:text-slate-100">Two-Camera Podcast</span>
                      </div>
                      <div>
                        Assets: <span className="font-semibold text-slate-800 dark:text-slate-100">{Array.isArray(selectedProject?.mediaAssets) ? selectedProject.mediaAssets.length : 0}</span>
                      </div>
                      <div>
                        Sync: <span className="font-semibold text-slate-800 dark:text-slate-100">{Number.isFinite(Number(selectedProject?.syncMap?.offsetSeconds)) ? `${Number(selectedProject.syncMap.offsetSeconds).toFixed(2)}s` : '--'}</span>
                      </div>
                      <div>
                        Project Audio: <span className="font-semibold text-slate-800 dark:text-slate-100">{multicamAudioMixMode === 'stereo_mix' ? 'Synced Stereo Mix' : (String(selectedProject?.masterAudioAssetId || '').trim() || '--')}</span>
                      </div>
                    </div>
                  ) : null}
                </div>,
                sidebarPortalNode
              ) : null}
              {isMulticamProject ? null : (
                <>
                  <div className="space-y-2">
                    <label htmlFor="vault-search" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Search Clips
                    </label>
                    <input
                      id="vault-search"
                      name="vaultSearch"
                      type="text"
                      value={mediaSearchQuery}
                      onChange={(event) => setMediaSearchQuery(event.target.value)}
                      placeholder="Title, source, keyword..."
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="space-y-2">
                    {!selectedProjectId ? (
                      <div className="text-sm text-slate-500 dark:text-slate-400">
                        Select or create a project to view its clips.
                      </div>
                    ) : filteredVaultClips.length === 0 ? (
                      <div className="text-sm text-slate-500 dark:text-slate-400">
                        No clips in this project yet.
                      </div>
                    ) : (
                      filteredVaultClips.map((clip) => (
                        <article
                          key={clip.id}
                          draggable
                          onDragStart={(event) => handleMediaDragStart(event, clip.id)}
                          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 p-3 space-y-2 cursor-grab active:cursor-grabbing"
                        >
                          <div className="aspect-video rounded-lg bg-gradient-to-br from-slate-300/70 to-slate-500/60 dark:from-slate-700/70 dark:to-slate-900/70 flex items-center justify-center">
                            <span className="material-symbols-outlined text-slate-800 dark:text-slate-200 text-[30px]">movie</span>
                          </div>
                          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 line-clamp-2">{clip.title || 'Untitled Clip'}</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {clip.startTimestamp || '--:--'} - {clip.endTimestamp || '--:--'} ({formatDurationLabel(clip.startTimestamp, clip.endTimestamp)})
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 break-all">{clip.sourceTitle || 'Unknown source'}</div>
                        </article>
                      ))
                    )}
                  </div>
                </>
              )}
            </aside>
          )}

          {!isMulticamProject && !isMediaBinCollapsed && (
            <button
              type="button"
              onMouseDown={startPaneResize('media')}
              aria-label="Resize media bin"
              className="hidden lg:block w-1.5 mx-1 cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors"
            />
          )}

          <div className="min-w-0 flex-1 flex flex-col">
            {isMulticamProject ? (
              <>
                <section
                  ref={directorSuiteSurfaceRef}
                  className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 p-4 flex flex-col min-h-[460px]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Director Suite</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={isProgramPreviewOpen ? handleCloseProgramPreview : handleOpenProgramPreview}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200"
                      >
                        <span className="material-symbols-outlined text-[14px]">{isProgramPreviewOpen ? 'picture_in_picture_alt_off' : 'picture_in_picture_alt'}</span>
                        {isProgramPreviewOpen ? 'Hide Program Preview' : 'Open Program Preview'}
                      </button>
                      {isMulticamPlaying ? (
                        <button
                          type="button"
                          onClick={pauseSelectedMulticamProgram}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-800 text-white px-3 py-2 text-xs font-semibold"
                        >
                          <span className="material-symbols-outlined text-[14px]">pause</span>
                          Pause Program
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={playSelectedMulticamProgram}
                          disabled={!multicamPreviewUrls.camera1 && !multicamPreviewUrls.camera2}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary text-white px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                          Play Program
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={splitSelectedMulticamSegment}
                        disabled={!selectedMulticamSegment}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[14px]">content_cut</span>
                        Cut At Playhead
                      </button>
                      <button
                        type="button"
                        onClick={joinSelectedMulticamSegment}
                        disabled={!selectedMulticamSegment}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[14px]">join_inner</span>
                        Join Next
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                    <span>{selectedProject ? selectedProject.name : 'No Project Selected'}</span>
                    {selectedMulticamSegment ? (
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        Segment {multicamSegments.findIndex((segment) => segment.id === selectedMulticamSegment.id) + 1}/{multicamSegments.length}
                      </span>
                    ) : null}
                    {multicamPreviewSegment ? (
                      <span className="font-semibold text-emerald-600 dark:text-emerald-300">
                        Active {formatShotPresetLabel(getMulticamSegmentShotId(multicamPreviewSegment))}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-3 flex-1 min-h-0">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 w-full h-full">
                      {multicamPreviewUrls.camera1 || multicamPreviewUrls.camera2 ? (
                        <>
                          {(['camera1', 'camera2']).map((assetId) => {
                            const src = multicamPreviewUrls[assetId];
                            if (!src) return null;
                            const isActive = getMulticamActiveCameraId(multicamPreviewSegment) === assetId;
                            const preset = multicamPreviewPresets[assetId];
                            const displayLabel = assetId === 'camera2' ? 'Camera B' : 'Camera A';
                            return (
                              <div
                                key={assetId}
                                ref={(node) => {
                                  directorPaneRefs.current[assetId] = node;
                                }}
                                className={`relative min-h-[220px] rounded-xl overflow-hidden bg-black/90 border ${isActive ? 'border-emerald-400/80 shadow-[0_0_0_1px_rgba(52,211,153,0.45)]' : 'border-slate-300/60 dark:border-slate-700/60'}`}
                                onPointerDown={(event) => handleDirectorShotPointerDown(event, assetId)}
                                onWheel={(event) => handleDirectorShotWheel(event, assetId)}
                              >
                                <div className="absolute left-3 top-3 z-20 rounded-md bg-black/55 px-2 py-1 text-[11px] font-semibold text-white">
                                  {displayLabel} {preset?.id ? `• ${formatShotPresetLabel(preset.id)}` : ''}
                                </div>
                                <div className="absolute right-3 top-3 z-20 rounded-md bg-black/55 px-2 py-1 text-[11px] text-white/90">
                                  {isActive ? 'LIVE' : 'standby'}
                                </div>
                                {isDirectorShotSetupActive && selectedDirectorShotPreset?.cameraId === assetId ? (
                                  <div className="absolute inset-0 z-10 border-2 border-dashed border-cyan-300/80 pointer-events-none">
                                    <div className="absolute inset-0 flex items-center justify-center">
                                      <div className="rounded-md bg-cyan-400/15 px-3 py-1 text-[11px] font-semibold text-cyan-100 backdrop-blur-sm">
                                        Setting {selectedDirectorShotPreset.id}: drag to pan, wheel to zoom
                                      </div>
                                    </div>
                                  </div>
                                ) : null}
                                <div className="absolute inset-0 overflow-hidden">
                                  <video
                                    ref={(node) => {
                                      multicamPreviewRefs.current[assetId] = node;
                                    }}
                                    src={src}
                                    playsInline
                                    muted
                                    className="absolute inset-0 w-full h-full object-contain"
                                    style={getShotTransformStyle(preset)}
                                    onLoadedMetadata={(event) => handleMulticamLoadedMetadata(assetId, event)}
                                  />
                                </div>
                              </div>
                            );
                          })}
                          {(['camera1', 'camera2']).map((assetId) => {
                            const src = multicamPreviewUrls[assetId];
                            if (!src) return null;
                            return (
                              <audio
                                key={`audio-${assetId}`}
                                ref={(node) => {
                                  multicamAudioRefs.current[assetId] = node;
                                }}
                                src={src}
                                preload="auto"
                                className="hidden"
                              />
                            );
                          })}
                        </>
                      ) : (
                        <div className="w-full h-full col-span-full flex flex-col items-center justify-center text-slate-300 text-sm gap-2">
                          <span className="material-symbols-outlined text-[34px]">videocam_off</span>
                          Select a multicam segment with a valid source file to preview.
                        </div>
                      )}
                    </div>
                  </div>

                </section>

                <section className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 p-4">
                  <div className="flex flex-col xl:flex-row xl:items-center xl:justify-center gap-4 xl:gap-6">
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {multicamShotPresets
                        .filter((preset) => preset.cameraId === 'camera1')
                        .map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => handleSelectDirectorShotPreset(preset.id)}
                            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${selectedDirectorShotId === preset.id
                              ? (preset.locked
                                ? 'border-emerald-500 bg-emerald-600 text-white'
                                : 'border-cyan-400 bg-cyan-500 text-white')
                              : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                              }`}
                          >
                            <span className="inline-flex items-center gap-1">
                              {formatShotPresetLabel(preset.id)}
                              <span className="material-symbols-outlined text-[13px]">
                                {preset.locked ? 'lock' : 'tune'}
                              </span>
                            </span>
                          </button>
                        ))}
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <div className="inline-flex items-center gap-2">
                        <InlineHelpTooltip
                          label="Shot setup help"
                          text="Choose a preset, press Set Shot, then drag in the matching camera view and use the wheel to zoom. Press Lock Shot when the framing is right."
                        />
                      </div>
                      <button
                        type="button"
                        onClick={armDirectorShotSetup}
                        disabled={!selectedDirectorShotPreset}
                        className="rounded-lg bg-primary text-white px-5 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        Set Shot
                      </button>
                      <button
                        type="button"
                        onClick={lockDirectorShotSetup}
                        disabled={!selectedDirectorShotPreset}
                        className={`rounded-lg px-5 py-2 text-xs font-semibold disabled:opacity-50 ${selectedDirectorShotPreset?.locked
                          ? 'bg-emerald-600 text-white'
                          : 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                          }`}
                      >
                        Lock Shot
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {multicamShotPresets
                        .filter((preset) => preset.cameraId === 'camera2')
                        .map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => handleSelectDirectorShotPreset(preset.id)}
                            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${selectedDirectorShotId === preset.id
                              ? (preset.locked
                                ? 'border-emerald-500 bg-emerald-600 text-white'
                                : 'border-cyan-400 bg-cyan-500 text-white')
                              : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                              }`}
                          >
                            <span className="inline-flex items-center gap-1">
                              {formatShotPresetLabel(preset.id)}
                              <span className="material-symbols-outlined text-[13px]">
                                {preset.locked ? 'lock' : 'tune'}
                              </span>
                            </span>
                          </button>
                        ))}
                    </div>
                  </div>
                </section>

                <button
                  type="button"
                  onMouseDown={startPaneResize('monitor')}
                  aria-label="Resize monitor and timeline panes"
                  className="hidden lg:block h-2 my-2 cursor-row-resize rounded bg-transparent hover:bg-primary/30 transition-colors"
                />

                <section className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 p-4 flex flex-col min-h-[280px] flex-1">
                  <div className="flex flex-col gap-3 xl:grid xl:grid-cols-[auto_1fr_auto] xl:items-center">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Multicam Timeline</div>
                      <button
                        type="button"
                        onClick={() => selectedDirectorShotPreset && selectedMulticamSegment && setSelectedMulticamShot(selectedDirectorShotPreset.id)}
                        disabled={!selectedDirectorShotPreset || !selectedMulticamSegment}
                        className="rounded-md bg-emerald-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        Apply Shot
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400 xl:px-4">
                      <div className="inline-flex items-center gap-2">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">Director Status</span>
                        <InlineHelpTooltip
                          label="Timeline shot assignment help"
                          text="Split the timeline where you want the cut, select the segment, then assign a shot preset here."
                        />
                      </div>
                      {selectedMulticamSegment ? (
                        <span>
                          Segment shot: <span className="font-semibold text-slate-800 dark:text-slate-100">{formatShotPresetLabel(getMulticamSegmentShotId(selectedMulticamSegment))}</span>
                        </span>
                      ) : null}
                      {selectedMulticamSegment ? (
                        <span>
                          Segment range: <span className="font-semibold text-slate-800 dark:text-slate-100">{formatTimelineTickLabel(selectedMulticamSegment.startSeconds)} - {formatTimelineTickLabel(selectedMulticamSegment.endSeconds)}</span>
                        </span>
                      ) : null}
                      {selectedDirectorShotPreset ? (
                        <span>
                          Setup preset: <span className="font-semibold text-slate-800 dark:text-slate-100">{formatShotPresetLabel(selectedDirectorShotPreset.id)}</span>
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 xl:justify-end">
                      <button
                        type="button"
                        onClick={clearSelectedMulticamOverride}
                        disabled={!selectedMulticamSegment || (!selectedMulticamSegment?.manualShotId && !selectedMulticamSegment?.isLocked)}
                        className="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                      >
                        Clear Override
                      </button>
                      <span>Playhead {formatTimelineTickLabel(timelinePlayheadSeconds)}</span>
                      <div className="inline-flex items-center gap-1">
                        <span>Zoom</span>
                        <input
                          type="range"
                          min="0.6"
                          max="4"
                          step="0.1"
                          value={timelineZoom}
                          onChange={(event) => setTimelineZoom(clamp(Number(event.target.value), 0.6, 4))}
                          className="w-24 accent-primary"
                          aria-label="Timeline zoom"
                        />
                        <span className="font-semibold text-slate-700 dark:text-slate-200">{timelineZoom.toFixed(1)}x</span>
                      </div>
                    </div>
                  </div>

                  <div
                    ref={timelineScrollerRef}
                    className="mt-3 rounded-xl border border-slate-300/70 dark:border-slate-700/70 bg-slate-950/80 overflow-x-auto overflow-y-hidden flex-1 min-h-0"
                  >
                    {multicamSegments.length === 0 ? (
                      <div className="h-full min-h-[240px] flex items-center justify-center text-slate-400 text-sm">
                        Multicam segments will appear here after Sermon Prep sync.
                      </div>
                    ) : (
                      <div
                        ref={timelineTrackRef}
                        className="relative min-h-[240px] select-none"
                        style={{ width: `${multicamTrackWidthPx}px` }}
                        onPointerDown={handleMulticamRulerPointerDown}
                      >
                        <div
                          className="absolute left-0 right-0 top-0 bg-slate-900/95 border-b border-slate-700"
                          style={{ height: `${TIMELINE_RULER_HEIGHT_PX}px` }}
                        >
                          {multicamRulerTicks.map((tick) => {
                            const leftPx = tick.seconds * timelinePixelsPerSecond;
                            return (
                              <div
                                key={`multicam-tick-${tick.seconds}`}
                                className="absolute top-0 bottom-0 text-[10px] text-slate-400"
                                style={{ left: `${leftPx}px` }}
                              >
                                <div className={`w-px bg-slate-500/70 ${tick.isMajor ? 'h-4' : 'h-2.5'}`} />
                                {tick.isMajor && (
                                  <div className="mt-0.5 -translate-x-1/2 whitespace-nowrap">
                                    {formatTimelineTickLabel(tick.seconds)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="absolute left-0 right-0 border-b border-slate-700/80 bg-slate-900/45" style={{ top: `${TIMELINE_RULER_HEIGHT_PX}px`, height: `${TIMELINE_ROW_HEIGHT_PX}px` }} />
                        <div className="absolute left-0 right-0 border-b border-slate-700/80 bg-slate-900/35" style={{ top: `${TIMELINE_RULER_HEIGHT_PX + TIMELINE_ROW_HEIGHT_PX}px`, height: `${TIMELINE_ROW_HEIGHT_PX}px` }} />
                        <div className="absolute left-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400" style={{ top: `${TIMELINE_RULER_HEIGHT_PX + 6}px` }}>Camera A</div>
                        <div className="absolute left-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400" style={{ top: `${TIMELINE_RULER_HEIGHT_PX + TIMELINE_ROW_HEIGHT_PX + 6}px` }}>Camera B</div>

                        {multicamSegments.map((segment, index) => {
                          const start = Number(segment.startSeconds || 0);
                          const end = Number(segment.endSeconds || 0);
                          const duration = Math.max(TRIM_MIN_GAP_SECONDS, end - start);
                          const activeCameraId = getMulticamActiveCameraId(segment);
                          const leftPx = start * timelinePixelsPerSecond;
                          const widthPx = Math.max(24, duration * timelinePixelsPerSecond);
                          const isSelected = segment.id === effectiveSelectedMulticamSegmentId;
                          const shotId = getMulticamSegmentShotId(segment);
                          const topSegmentStyle = activeCameraId === 'camera1'
                            ? 'bg-emerald-500/85 border-emerald-200 text-emerald-50'
                            : 'bg-rose-500/70 border-rose-200/70 text-rose-50';
                          const bottomSegmentStyle = activeCameraId === 'camera2'
                            ? 'bg-emerald-500/85 border-emerald-200 text-emerald-50'
                            : 'bg-rose-500/70 border-rose-200/70 text-rose-50';
                          return (
                            <React.Fragment key={segment.id}>
                              <button
                                type="button"
                                onClick={() => handleSelectMulticamSegment(segment.id)}
                                className={`absolute overflow-hidden rounded-lg border px-2 py-1 text-left transition-colors ${topSegmentStyle} ${isSelected ? 'ring-2 ring-white/90' : ''}`}
                                style={{ left: `${leftPx}px`, width: `${widthPx}px`, top: `${TIMELINE_RULER_HEIGHT_PX + 10}px`, height: `${TIMELINE_ROW_HEIGHT_PX - 20}px` }}
                                title={`Segment ${index + 1} • Camera A • ${formatShotPresetLabel(shotId)} • ${formatTimelineTickLabel(start)} - ${formatTimelineTickLabel(end)}`}
                              >
                                <div className="text-[10px] font-bold opacity-80">#{index + 1}</div>
                                <div className="text-xs font-semibold truncate">{activeCameraId === 'camera1' ? `${formatShotPresetLabel(shotId)} LIVE` : formatShotPresetLabel(shotId)}</div>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSelectMulticamSegment(segment.id)}
                                className={`absolute overflow-hidden rounded-lg border px-2 py-1 text-left transition-colors ${bottomSegmentStyle} ${isSelected ? 'ring-2 ring-white/90' : ''}`}
                                style={{ left: `${leftPx}px`, width: `${widthPx}px`, top: `${TIMELINE_RULER_HEIGHT_PX + TIMELINE_ROW_HEIGHT_PX + 10}px`, height: `${TIMELINE_ROW_HEIGHT_PX - 20}px` }}
                                title={`Segment ${index + 1} • Camera B • ${formatShotPresetLabel(shotId)} • ${formatTimelineTickLabel(start)} - ${formatTimelineTickLabel(end)}`}
                              >
                                <div className="text-[10px] font-bold opacity-80">#{index + 1}</div>
                                <div className="text-xs font-semibold truncate">{activeCameraId === 'camera2' ? `${formatShotPresetLabel(shotId)} LIVE` : formatShotPresetLabel(shotId)}</div>
                              </button>
                              <div
                                className="pointer-events-none absolute top-[28px] bottom-0 z-30 w-px bg-white/50"
                                style={{ left: `${leftPx}px` }}
                              />
                            </React.Fragment>
                          );
                        })}

                        <div
                          className="pointer-events-none absolute top-0 bottom-0 z-40"
                          style={{ left: `${timelinePlayheadSeconds * timelinePixelsPerSecond}px` }}
                        >
                          <div className="w-[2px] h-full bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
                          <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[7px] border-r-[7px] border-t-[10px] border-l-transparent border-r-transparent border-t-white/95" />
                        </div>
                      </div>
                    )}
                  </div>

                </section>
              </>
            ) : (
              <>
                <section
                  className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 p-4 flex flex-col min-h-0"
                  style={{ height: `${monitorHeight}px` }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Program Monitor</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => startTimelinePlayback(true)}
                        disabled={!hasPlayableTimelineClip}
                        className="inline-flex items-center gap-1 rounded-lg bg-primary text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="material-symbols-outlined text-[14px]">linked_camera</span>
                        Play As One
                      </button>

                      <button
                        type="button"
                        onClick={renderEditedGroup}
                        disabled={isRenderingEditedGroup || renderableTimelineItemCount < 2}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-3 py-2 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="material-symbols-outlined text-[14px]">movie_edit</span>
                        {isRenderingEditedGroup ? 'Rendering Montage...' : 'Render Montage (2-100)'}
                      </button>

                      {previewMode === 'timeline' && (
                        <>
                          {isTimelinePlaying ? (
                            <button
                              type="button"
                              onClick={() => {
                                setIsTimelinePlaying(false);
                                timelineAutoPlayRef.current = false;
                                previewRef.current?.pause?.();
                                setLocalStatus('Paused grouped timeline playback.');
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-slate-800 text-white px-3 py-2 text-xs font-semibold"
                            >
                              <span className="material-symbols-outlined text-[14px]">pause</span>
                              Pause Group
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={resumeTimelinePlayback}
                              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 text-white px-3 py-2 text-xs font-semibold"
                            >
                              <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                              Resume Group
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              stopTimelinePlayback('Grouped timeline playback stopped.');
                              setPreviewMode('selected');
                              setPlaybackTimelineItemId('');
                            }}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200"
                          >
                            <span className="material-symbols-outlined text-[14px]">stop</span>
                            Stop Group
                          </button>
                        </>
                      )}

                      {previewMode !== 'selected' && (
                        <button
                          type="button"
                          onClick={() => {
                            stopTimelinePlayback('Switched to selected clip preview mode.');
                            setPreviewMode('selected');
                            setPlaybackTimelineItemId('');
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200"
                        >
                          <span className="material-symbols-outlined text-[14px]">movie</span>
                          Preview Selected
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                    <span>{selectedProject ? selectedProject.name : 'No Project Selected'}</span>
                    {previewTimelineIndex >= 0 && (
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        Clip {previewTimelineIndex + 1}/{timelineEntries.length}
                      </span>
                    )}
                    {previewMode === 'timeline' && (
                      <span className="font-semibold text-primary">
                        Grouped Playback {isTimelinePlaying ? 'ON' : 'Paused'}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex-1 min-h-0">
                    <div className="relative w-full h-full rounded-xl overflow-hidden bg-black/90 border border-slate-300/60 dark:border-slate-700/60">
                      {previewClipPlaybackUrl ? (
                        <video
                          ref={previewRef}
                          src={previewClipPlaybackUrl}
                          controls
                          className="w-full h-full object-contain"
                          onLoadedMetadata={handlePreviewLoadedMetadata}
                          onTimeUpdate={handlePreviewTimeUpdate}
                          onEnded={handlePreviewEnded}
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-slate-300 text-sm gap-2">
                          <span className="material-symbols-outlined text-[34px]">videocam_off</span>
                          Select a timeline clip with a rendered file to preview.
                        </div>
                      )}
                      {previewCaptionLines.length > 0 && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex items-end justify-center px-4">
                          <div className={getCaptionOverlayClassName(previewCaptionPayload?.stylePreset)}>
                            <div className="space-y-1.5 text-center leading-tight">
                              {previewCaptionLines.map((line, lineIndex) => (
                                <div
                                  key={`vault-caption-line-${lineIndex}`}
                                  className="flex flex-wrap justify-center items-baseline gap-x-1.5 gap-y-1"
                                >
                                  {line.map((word) => (
                                    <span
                                      key={word.id}
                                      className={`inline-block px-1 rounded transition-all duration-100 ${getCaptionWordClassName({
                                        stylePreset: previewCaptionPayload?.stylePreset,
                                        isActive: word.isActive,
                                      })}`}
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
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                    <span>
                      Playhead: <span className="font-semibold">{formatSecondsLabel(currentPreviewTime)}</span>
                    </span>
                    {previewTrimRange && (
                      <span>
                        Trim Range: <span className="font-semibold">{formatSecondsLabel(previewTrimRange.start)} - {formatSecondsLabel(previewTrimRange.end)}</span>
                      </span>
                    )}
                    {effectivePreviewSpeechCleanup.enabled && (
                      <span className="font-semibold text-slate-700 dark:text-slate-200">
                        Speech Cleanup {previewCleanupEntry?.status === 'loading'
                          ? 'proxying…'
                          : (previewCleanupEntry?.status === 'failed'
                            ? 'preview unavailable'
                            : `on (${effectivePreviewSpeechCleanup.preset})`)}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 rounded-xl border border-slate-200/70 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Caption Style</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Changes look only. Word timing and cue sync stay intact.
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleCaptionEnabledToggle}
                          disabled={!selectedTimelineEntry}
                          className={`rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-50 ${selectedTimelineEntry?.item?.captionEnabled === false
                            ? 'border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200'
                            : 'bg-emerald-600 text-white'
                            }`}
                        >
                          {selectedTimelineEntry?.item?.captionEnabled === false ? 'Captions Off' : 'Captions On'}
                        </button>
                        <select
                          value={selectedCaptionStylePreset}
                          onChange={handleCaptionStyleChange}
                          disabled={!selectedTimelineEntry}
                          className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-100 disabled:opacity-50"
                          aria-label="Caption style preset"
                        >
                          {CAPTION_STYLE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl border border-slate-200/70 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Speech Cleanup</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Backend speech-focused denoise for noisy dialogue. Preview proxies are prepared lazily when enabled.
                        </div>
                      </div>
                      <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                        Effective: {effectiveSelectedSpeechCleanup.enabled ? effectiveSelectedSpeechCleanup.preset : 'off'} ({effectiveSelectedSpeechCleanup.source})
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select
                        value={normalizeSpeechCleanupMode(selectedTimelineEntry?.item?.speechCleanupMode)}
                        onChange={handleSpeechCleanupModeChange}
                        disabled={!selectedTimelineEntry}
                        className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-100 disabled:opacity-50"
                        aria-label="Speech Cleanup mode"
                      >
                        <option value="inherit">Use Project Default</option>
                        <option value="off">Off For This Clip</option>
                        <option value="on">On For This Clip</option>
                      </select>
                      <select
                        value={normalizeSpeechCleanupPreset(selectedTimelineEntry?.item?.speechCleanupPreset || DEFAULT_SPEECH_CLEANUP_PRESET)}
                        onChange={handleSpeechCleanupPresetChange}
                        disabled={!selectedTimelineEntry || normalizeSpeechCleanupMode(selectedTimelineEntry?.item?.speechCleanupMode) === 'inherit'}
                        className="rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-100 disabled:opacity-50"
                        aria-label="Speech Cleanup preset"
                      >
                        {SPEECH_CLEANUP_PRESET_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {effectivePreviewSpeechCleanup.enabled && previewCleanupEntry?.status === 'failed' && (
                        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-300">
                          Preview fallback: original audio
                        </span>
                      )}
                    </div>
                  </div>

                </section>

                <section className="mt-4 rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20">
                  <button
                    type="button"
                    onClick={() => setIsClipToolsOpen((previous) => !previous)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <div>
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Clip Tools</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Advanced transcript correction and reflow.
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedEditableClip && (
                        <span className={`text-[11px] font-semibold px-2 py-1 rounded-md ${selectedClipHasTranscriptEdit
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                          : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'
                          }`}>
                          {selectedClipHasTranscriptEdit ? 'Edited text active' : 'Hidden'}
                        </span>
                      )}
                      <span className="material-symbols-outlined text-slate-500 dark:text-slate-300">
                        {isClipToolsOpen ? 'expand_less' : 'expand_more'}
                      </span>
                    </div>
                  </button>
                  {isClipToolsOpen && (
                    <div className="border-t border-slate-200/70 dark:border-slate-700/70 p-4 space-y-3">
                      <textarea
                        value={clipTranscriptDraft}
                        onChange={(event) => setClipTranscriptDraft(event.target.value)}
                        disabled={!selectedEditableClip}
                        rows={4}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                        placeholder={selectedEditableClip ? 'Edit the clip transcript here' : 'Select a clip in the timeline to edit its transcript'}
                      />
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {selectedEditableClip
                            ? 'Apply Text + Reflow regenerates timed caption cues from the selected clip timing.'
                            : 'Select a timeline clip to enable transcript editing.'}
                        </div>
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={resetClipTranscriptEdit}
                            disabled={!selectedEditableClip}
                            className="rounded-md border border-slate-300 dark:border-slate-600 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                          >
                            Reset to Source
                          </button>
                          <button
                            type="button"
                            onClick={applyClipTranscriptEdit}
                            disabled={!selectedEditableClip}
                            className="rounded-md bg-primary text-white px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Apply Text + Reflow
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                <button
                  type="button"
                  onMouseDown={startPaneResize('monitor')}
                  aria-label="Resize monitor and timeline panes"
                  className="hidden lg:block h-2 my-2 cursor-row-resize rounded bg-transparent hover:bg-primary/30 transition-colors"
                />

                <section className="rounded-2xl border border-slate-200/70 dark:border-slate-700/70 bg-white/40 dark:bg-slate-900/20 p-4 flex flex-col min-h-[280px] flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Timeline Editor</div>
                    <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>Playhead {formatTimelineTickLabel(timelinePlayheadSeconds)}</span>
                      <div className="inline-flex items-center gap-1">
                        <span>Zoom</span>
                        <input
                          type="range"
                          min="0.6"
                          max="4"
                          step="0.1"
                          value={timelineZoom}
                          onChange={(event) => setTimelineZoom(clamp(Number(event.target.value), 0.6, 4))}
                          className="w-24 accent-primary"
                          aria-label="Timeline zoom"
                        />
                        <span className="font-semibold text-slate-700 dark:text-slate-200">{timelineZoom.toFixed(1)}x</span>
                      </div>
                    </div>
                  </div>

                  <div
                    ref={timelineScrollerRef}
                    className="mt-3 rounded-xl border border-slate-300/70 dark:border-slate-700/70 bg-slate-950/80 overflow-x-auto overflow-y-hidden flex-1 min-h-0"
                  >
                    {timelineSequenceEntries.length === 0 ? (
                      <div
                        className="h-full min-h-[210px] rounded-xl border border-dashed border-slate-600 flex items-center justify-center text-slate-400 text-sm"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={handleTimelineTrackDrop}
                      >
                        Drop clips here to start your montage timeline.
                      </div>
                    ) : (
                      <div
                        ref={timelineTrackRef}
                        className="relative min-h-[210px] select-none"
                        style={{ width: `${timelineTrackWidthPx}px` }}
                        onPointerDown={handleTimelineRulerPointerDown}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={handleTimelineTrackDrop}
                      >
                        <div
                          className="absolute left-0 right-0 top-0 bg-slate-900/95 border-b border-slate-700"
                          style={{ height: `${TIMELINE_RULER_HEIGHT_PX}px` }}
                        >
                          {timelineRulerTicks.map((tick) => {
                            const leftPx = tick.seconds * timelinePixelsPerSecond;
                            return (
                              <div
                                key={`tick-${tick.seconds}`}
                                className="absolute top-0 bottom-0 text-[10px] text-slate-400"
                                style={{ left: `${leftPx}px` }}
                              >
                                <div className={`w-px bg-slate-500/70 ${tick.isMajor ? 'h-4' : 'h-2.5'}`} />
                                {tick.isMajor && (
                                  <div className="mt-0.5 -translate-x-1/2 whitespace-nowrap">
                                    {formatTimelineTickLabel(tick.seconds)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div
                          className="absolute left-0 right-0 bg-slate-900/45 border-b border-slate-700/80"
                          style={{
                            top: `${TIMELINE_RULER_HEIGHT_PX}px`,
                            height: `${TIMELINE_ROW_HEIGHT_PX}px`,
                          }}
                        />
                        <div
                          className="absolute left-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                          style={{ top: `${TIMELINE_RULER_HEIGHT_PX + 6}px` }}
                        >
                          V1
                        </div>

                        {timelineSequenceEntries.map((entry, index) => {
                          const isSelected = entry.item.id === effectiveSelectedTimelineItemId;
                          const isPlaybackEntry = entry.item.id === effectivePlaybackTimelineItemId && previewMode === 'timeline';
                          const trimRange = getTimelineEntryTrimRange(entry);
                          const clipDuration = Number(trimRange.clipDuration);
                          const trimStartPercent = Number.isFinite(clipDuration) && clipDuration > 0
                            ? (trimRange.start / clipDuration) * 100
                            : 0;
                          const trimEndPercent = Number.isFinite(clipDuration) && clipDuration > 0
                            ? (trimRange.end / clipDuration) * 100
                            : 100;
                          const segmentLeftPx = entry.sequenceStart * timelinePixelsPerSecond;
                          const segmentWidthPx = Math.max(28, entry.sequenceDuration * timelinePixelsPerSecond);
                          const segmentTopPx = TIMELINE_RULER_HEIGHT_PX + 9;
                          const segmentHeightPx = TIMELINE_ROW_HEIGHT_PX - 18;
                          return (
                            <button
                              key={entry.item.id}
                              type="button"
                              draggable
                              onDragStart={(event) => handleTimelineDragStart(event, entry.item.id)}
                              onClick={() => handleSelectTimelineItem(entry.item.id)}
                              onDoubleClick={() => handleTimelineItemDoubleClick(entry)}
                              className={`absolute overflow-hidden rounded-lg border px-2 py-1 text-left transition-colors ${isSelected
                                ? 'border-primary bg-primary/20 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.12)]'
                                : 'border-slate-600 bg-slate-800/90 text-slate-100 hover:border-slate-500'
                                }`}
                              style={{
                                left: `${segmentLeftPx}px`,
                                width: `${segmentWidthPx}px`,
                                top: `${segmentTopPx}px`,
                                height: `${segmentHeightPx}px`,
                              }}
                              title={`${entry.clip.title || 'Clip'} • ${entry.sequenceDuration.toFixed(2)}s`}
                            >
                              <div className="pointer-events-none absolute left-1 right-1 bottom-1 h-1 rounded-full bg-white/10">
                                <div
                                  className="absolute h-full rounded-full bg-accent-neon/80"
                                  style={{
                                    left: `${trimStartPercent}%`,
                                    right: `${Math.max(0, 100 - trimEndPercent)}%`,
                                  }}
                                />
                              </div>

                              <span
                                role="presentation"
                                title="Drag to trim start"
                                onPointerDown={(event) => startTimelineTrimDrag(event, entry, 'start', segmentWidthPx)}
                                className="absolute left-0 top-0 bottom-0 z-20 cursor-ew-resize border-r border-accent-neon/80 bg-accent-neon/25 hover:bg-accent-neon/40"
                                style={{ width: `${TRIM_HANDLE_WIDTH_PX}px` }}
                              />
                              <span
                                role="presentation"
                                title="Drag to trim end"
                                onPointerDown={(event) => startTimelineTrimDrag(event, entry, 'end', segmentWidthPx)}
                                className="absolute right-0 top-0 bottom-0 z-20 cursor-ew-resize border-l border-accent-neon/80 bg-accent-neon/25 hover:bg-accent-neon/40"
                                style={{ width: `${TRIM_HANDLE_WIDTH_PX}px` }}
                              />

                              <div className="relative z-10 flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-[10px] font-bold opacity-75">#{index + 1}</div>
                                  <div className="text-xs font-semibold truncate">{entry.clip.title || 'Untitled Clip'}</div>
                                </div>
                                {isPlaybackEntry && (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300">
                                    <span className="material-symbols-outlined text-[12px]">play_arrow</span>
                                    LIVE
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })}

                        <div
                          className="pointer-events-none absolute top-0 bottom-0 z-40"
                          style={{ left: `${timelinePlayheadSeconds * timelinePixelsPerSecond}px` }}
                        >
                          <div className="w-[2px] h-full bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
                          <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[7px] border-r-[7px] border-t-[10px] border-l-transparent border-r-transparent border-t-white/95" />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>Trim by dragging clip edges in the bottom timeline.</span>
                    <span>Click anywhere on the ruler/track to move the playhead and update the monitor.</span>
                  </div>
                </section>
              </>
            )}
          </div>

        </div>



        {renderedProgramDownload && (
          <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-700/60 p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Finished Program</div>
            <div className="flex flex-wrap gap-2">
              <a
                href={renderedProgramDownload.url}
                download={renderedProgramDownload.fileName}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-600/25 transition-colors px-2.5 py-1.5 text-xs font-semibold"
              >
                <span className="material-symbols-outlined text-[14px]">download</span>
                {renderedProgramDownload.fileName}
              </a>
            </div>
          </div>
        )}

        {renderedEditDownloads.length > 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Rendered Outputs</div>
            <div className="flex flex-wrap gap-2">
              {renderedEditDownloads.map((item, index) => (
                <a
                  key={`${item.downloadUrl || item.fileName}-${index}`}
                  href={item.downloadUrl}
                  download={item.fileName || `edited-output-${index + 1}.mp4`}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors px-2.5 py-1.5 text-xs font-semibold"
                >
                  <span className="material-symbols-outlined text-[14px]">download</span>
                  {item.fileName || item.title || `Output ${index + 1}`}
                </a>
              ))}
            </div>
          </div>
        )}

        {localStatus && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs text-slate-700 dark:text-slate-200">
            {localStatus}
          </div>
        )}
      </section>

      {isMulticamProject && isProgramPreviewOpen && (
        <div
          className="fixed z-[90] rounded-2xl border border-slate-300/70 dark:border-slate-700/80 bg-slate-950/92 shadow-2xl shadow-black/50 overflow-hidden"
          style={{
            left: `${programPreviewRect.x}px`,
            top: `${programPreviewRect.y}px`,
            width: `${programPreviewRect.width}px`,
            height: `${programPreviewRect.height}px`,
          }}
        >
          <div
            className="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-700/80 bg-slate-900/95 cursor-move"
            onPointerDown={handleProgramPreviewWindowPointerDown}
          >
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-100">Program Preview</div>
              <div className="text-[11px] text-slate-400">
                Live cut preview of the current timeline and shot presets
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isMulticamPlaying ? (
                <button
                  type="button"
                  onClick={pauseSelectedMulticamProgram}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-800 text-white px-2 py-1 text-[11px] font-semibold"
                >
                  <span className="material-symbols-outlined text-[13px]">pause</span>
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={playSelectedMulticamProgram}
                  className="inline-flex items-center gap-1 rounded-md bg-primary text-white px-2 py-1 text-[11px] font-semibold"
                >
                  <span className="material-symbols-outlined text-[13px]">play_arrow</span>
                  Play
                </button>
              )}
              <button
                type="button"
                onClick={handleCloseProgramPreview}
                className="inline-flex items-center justify-center rounded-md border border-slate-700 px-2 py-1 text-slate-200"
                aria-label="Close program preview"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          </div>
          <div className="relative bg-black" style={{ height: `${Math.max(180, programPreviewRect.height - 34)}px` }}>
            <canvas
              ref={programPreviewCanvasRef}
              className="block w-full h-full"
            />
            <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/55 px-2 py-1 text-[11px] font-semibold text-white">
              {multicamPreviewSegment ? `LIVE ${formatShotPresetLabel(getMulticamSegmentShotId(multicamPreviewSegment))}` : 'Awaiting segment'}
            </div>
          </div>
          <button
            type="button"
            onPointerDown={handleProgramPreviewResizePointerDown}
            className="absolute right-1 bottom-1 inline-flex items-center justify-center rounded-md bg-slate-900/80 text-slate-200"
            aria-label="Resize program preview"
          >
            <span className="material-symbols-outlined text-[18px]">drag_handle</span>
          </button>
        </div>
      )}
    </>
  );
};

export default ClipVaultWorkspace;
