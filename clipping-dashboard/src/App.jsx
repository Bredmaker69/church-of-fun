import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { db, storage, functions } from './firebase';
import { collection, addDoc, updateDoc, serverTimestamp, query, orderBy, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import Sidebar from './components/Sidebar';
import TopNav from './components/TopNav';
import VideoGrid from './components/VideoGrid';
import MobileTabBar from './components/MobileTabBar';
import ManualClipLab from './components/ManualClipLab';
import ClipVaultWorkspace from './components/ClipVaultWorkspace';
import IngestSurface from './components/IngestSurface';
import AppErrorBoundary from './components/AppErrorBoundary';
import { renderLocalClipFiles } from './lib/localClipper';
import {
  storeClipMedia,
  getClipMedia,
  deleteClipMedia,
  deleteProjectClipMedia,
  getClipMediaStats,
  trimClipMediaStore,
} from './lib/clipMediaStore';

const CLIP_VAULT_STORAGE_KEY = 'clip-vault.v1';
const MONTAGE_PROJECT_STORAGE_KEY = 'montage-projects.v1';
const SELECTED_PROJECT_STORAGE_KEY = 'selected-montage-project.v1';
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 440;
const SIDEBAR_DEFAULT_WIDTH = 288;
const TIMELINE_MIN_GAP_SECONDS = 0.1;
const CLIP_MEDIA_MAX_BYTES = Number(import.meta.env.VITE_CLIP_MEDIA_MAX_BYTES || (800 * 1024 * 1024));

const parseHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const looksLikeYouTubeUrl = (value) => {
  const text = String(value || '').toLowerCase();
  return text.includes('youtube.com') || text.includes('youtu.be');
};

const parseTimestampToSeconds = (value) => {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
};

const normalizeCaptionCues = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((cue, index) => {
      const text = cleanClipText(cue?.text || '');
      const startSeconds = Number(cue?.startSeconds);
      const endSeconds = Number(cue?.endSeconds);
      if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }

      return {
        id: String(cue?.id || `cue-${index + 1}`),
        text,
        startSeconds: Number(startSeconds.toFixed(2)),
        endSeconds: Number(endSeconds.toFixed(2)),
        sourceStartSeconds: Number.isFinite(Number(cue?.sourceStartSeconds))
          ? Number(Number(cue.sourceStartSeconds).toFixed(2))
          : null,
        sourceEndSeconds: Number.isFinite(Number(cue?.sourceEndSeconds))
          ? Number(Number(cue.sourceEndSeconds).toFixed(2))
          : null,
      };
    })
    .filter(Boolean)
    .slice(0, 400);
};

const readLocalJson = (key, fallbackValue) => {
  if (typeof window === 'undefined') return fallbackValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallbackValue;
    const parsed = JSON.parse(raw);
    return parsed ?? fallbackValue;
  } catch {
    return fallbackValue;
  }
};

const writeLocalJsonSafe = (key, value) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Failed to persist local state for ${key}.`, error);
  }
};

const buildVaultDedupeKey = ({ projectId, sourceRef, startTimestamp, endTimestamp }) => {
  return `${String(projectId || '')}|${String(sourceRef || '')}|${String(startTimestamp || '')}|${String(endTimestamp || '')}`.toLowerCase();
};

const CLIP_TITLE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'for', 'on', 'in', 'at', 'by', 'with',
  'from', 'up', 'down', 'into', 'out', 'about', 'as', 'is', 'it', 'this', 'that', 'these', 'those',
  'be', 'been', 'being', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'not',
  'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'them', 'i', 'im', 'its',
]);

const cleanClipText = (value) => {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\[\s*_{2,}\s*\]/g, ' ')
    .replace(/[[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const toTitleCase = (value) => {
  return String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const slugify = (value) => {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const sanitizeFileNamePart = (value, fallback = 'item') => {
  const normalized = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const getFileExtension = (fileName, fallback = 'mp4') => {
  const text = String(fileName || '').trim();
  const index = text.lastIndexOf('.');
  if (index < 0) return fallback;
  const ext = text.slice(index + 1).toLowerCase();
  return ext || fallback;
};

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const stripFileExtension = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const index = text.lastIndexOf('.');
  if (index <= 0) return text;
  return text.slice(0, index).trim();
};

const inferProjectNameFromUrl = (urlValue) => {
  const normalized = parseHttpUrl(urlValue);
  if (!normalized) return 'Web Video Session';

  if (looksLikeYouTubeUrl(normalized)) {
    return `YouTube Session ${new Date().toLocaleDateString()}`;
  }

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '').split('.')[0] || 'web';
    return `${toTitleCase(host)} Session ${new Date().toLocaleDateString()}`;
  } catch {
    return `Web Video Session ${new Date().toLocaleDateString()}`;
  }
};

const shortHash = (value) => {
  let hash = 0;
  const source = String(value || '');
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, '0').slice(-4);
};

const buildSemanticTitleBase = (clip) => {
  const transcriptText = cleanClipText(clip?.transcriptSnippet || clip?.transcriptText || '');
  const descriptionText = cleanClipText(clip?.description || '');
  const fallbackText = cleanClipText(clip?.title || '');
  const sourceText = transcriptText || descriptionText || fallbackText;

  if (!sourceText) return 'Untitled Moment';

  const words = sourceText
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'Untitled Moment';

  const weightedWords = words.filter((word) => word.length > 2 && !CLIP_TITLE_STOP_WORDS.has(word));
  const chosenWords = (weightedWords.length >= 3 ? weightedWords : words).slice(0, 6);
  return toTitleCase(chosenWords.join(' ')) || 'Untitled Moment';
};

const buildSemanticClipName = ({ clip, sourceRef, startTimestamp, endTimestamp }) => {
  const safeStart = String(startTimestamp || clip?.startTimestamp || '00:00');
  const safeEnd = String(endTimestamp || clip?.endTimestamp || safeStart);
  const base = buildSemanticTitleBase(clip);
  const hash = shortHash(`${sourceRef}|${safeStart}|${safeEnd}|${clip?.description || clip?.title || ''}`);
  const title = `${base} (${safeStart}-${safeEnd}) ${hash}`;
  const fileStem = slugify(`${base}-${safeStart}-${safeEnd}-${hash}`) || `clip-${hash.toLowerCase()}`;
  return {
    title,
    fileName: `${fileStem}.mp4`,
    hash,
  };
};

const createTimelineItem = (clipId) => ({
  id: `timeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  createdAt: new Date().toISOString(),
});

const normalizeProject = (project, index = 0) => {
  const baseId = String(project?.id || `montage-${Date.now()}-${index}`);
  const existingTimeline = Array.isArray(project?.timelineItems) ? project.timelineItems : [];

  const timelineItems = existingTimeline.length > 0
    ? existingTimeline.map((item, itemIndex) => ({
      id: String(item?.id || `${baseId}-timeline-${itemIndex}`),
      clipId: String(item?.clipId || ''),
      trimStartSeconds: Number.isFinite(Number(item?.trimStartSeconds)) ? Number(item.trimStartSeconds) : 0,
      trimEndSeconds: Number.isFinite(Number(item?.trimEndSeconds)) ? Number(item.trimEndSeconds) : null,
      effectsPreset: String(item?.effectsPreset || 'none'),
      effectsIntensity: Number.isFinite(Number(item?.effectsIntensity)) ? Number(item.effectsIntensity) : 100,
      captionEnabled: item?.captionEnabled !== false,
      captionStylePreset: String(item?.captionStylePreset || 'reel-bold'),
      captionTextOverride: String(item?.captionTextOverride || ''),
      captionConfirmationStatus: String(item?.captionConfirmationStatus || 'pending'),
      captionConfirmedText: String(item?.captionConfirmedText || ''),
      captionConfirmedAt: String(item?.captionConfirmedAt || ''),
      createdAt: item?.createdAt || project?.createdAt || new Date().toISOString(),
    })).filter((item) => item.clipId)
    : (Array.isArray(project?.clipIds) ? project.clipIds : []).map((clipId) => createTimelineItem(String(clipId)));

  return {
    id: baseId,
    name: String(project?.name || `Montage ${index + 1}`),
    timelineItems,
    clipIds: timelineItems.map((item) => item.clipId),
    createdAt: project?.createdAt || new Date().toISOString(),
    updatedAt: project?.updatedAt || project?.createdAt || new Date().toISOString(),
  };
};

function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [workspace, setWorkspace] = useState('studio');
  const [videos, setVideos] = useState([]);
  const [localVideos, setLocalVideos] = useState([]);
  const [localDebugStatus, setLocalDebugStatus] = useState('');
  const [contentProfile, setContentProfile] = useState('generic');
  const [activeSource, setActiveSource] = useState(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [activeTopNavView, setActiveTopNavView] = useState('preview');
  const [pendingStudioNavTarget, setPendingStudioNavTarget] = useState('');
  const [clipVault, setClipVault] = useState(() => readLocalJson(CLIP_VAULT_STORAGE_KEY, []));
  const [montageProjects, setMontageProjects] = useState(() => {
    const storedProjects = readLocalJson(MONTAGE_PROJECT_STORAGE_KEY, []);
    return Array.isArray(storedProjects) ? storedProjects.map((project, index) => normalizeProject(project, index)) : [];
  });
  const [selectedMontageProjectId, setSelectedMontageProjectId] = useState(() =>
    readLocalJson(SELECTED_PROJECT_STORAGE_KEY, '')
  );
  const [clipPlaybackUrls, setClipPlaybackUrls] = useState({});
  const [clipMediaStats, setClipMediaStats] = useState({ totalBytes: 0, clipCount: 0 });
  const clipPlaybackUrlsRef = useRef({});
  const desktopIngestSurfaceRef = useRef(null);
  const mobileIngestSurfaceRef = useRef(null);
  const sidebarResizeStateRef = useRef(null);
  const mainScrollContainerRef = useRef(null);
  const previewSectionRef = useRef(null);
  const recentSectionRef = useRef(null);
  const pendingAutoProjectIdRef = useRef('');
  const mediaHydrationInFlightRef = useRef(new Set());
  const clipPersistenceInFlightRef = useRef(new Set());
  const manualProjectNameOverridesRef = useRef(new Set());

  const generateClips = httpsCallable(functions, 'generateClips');
  const skipStorageUploadInLocalMode =
    import.meta.env.DEV && import.meta.env.VITE_SKIP_STORAGE_UPLOAD !== 'false';

  const waitWithTimeout = async (promise, timeoutMs, errorMessage) => {
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

  const callGenerateClipsWithTimeout = async (payload, timeoutMs = 20000) => {
    return waitWithTimeout(
      generateClips(payload),
      timeoutMs,
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for generateClips`
    );
  };

  const setLocalDebug = (message) => {
    if (!import.meta.env.DEV) return;
    setLocalDebugStatus(message);
    console.log(`[local-debug] ${message}`);
  };

  const updateLocalVideo = (id, patch) => {
    setLocalVideos(prev =>
      prev.map(video => (video.id === id ? { ...video, ...patch } : video))
    );
  };

  const setClipPlaybackUrl = useCallback((clipId, nextUrl) => {
    const normalizedId = String(clipId || '').trim();
    if (!normalizedId) return;

    setClipPlaybackUrls((previous) => {
      const currentUrl = previous[normalizedId];
      if (currentUrl === nextUrl) return previous;
      if (currentUrl && currentUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentUrl);
      }

      const next = { ...previous };
      if (nextUrl) {
        next[normalizedId] = nextUrl;
      } else {
        delete next[normalizedId];
      }
      return next;
    });
  }, []);

  const refreshClipMediaStats = useCallback(async () => {
    try {
      const stats = await getClipMediaStats();
      setClipMediaStats(stats);
    } catch (error) {
      console.error('Failed to read clip media stats:', error);
    }
  }, []);

  const createMontageProjectRecord = useCallback((projectName, options = {}) => {
    const trimmedName = String(projectName || '').trim();
    const fallbackName = trimmedName || `Session ${new Date().toLocaleDateString()}`;
    const createdAt = new Date().toISOString();
    const createdProject = {
      id: `montage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: fallbackName,
      timelineItems: [],
      clipIds: [],
      createdAt,
      updatedAt: createdAt,
    };

    setMontageProjects((previous) => [createdProject, ...previous]);
    pendingAutoProjectIdRef.current = createdProject.id;
    if (options.markManualOverride) {
      manualProjectNameOverridesRef.current.add(createdProject.id);
    } else {
      manualProjectNameOverridesRef.current.delete(createdProject.id);
    }
    setSelectedMontageProjectId(createdProject.id);
    if (options.switchWorkspaceToVault) {
      setWorkspace('vault');
    }
    return createdProject.id;
  }, []);

  const ensureActiveProjectId = useCallback((nameHint = 'Session') => {
    if (selectedMontageProjectId) {
      pendingAutoProjectIdRef.current = selectedMontageProjectId;
      return selectedMontageProjectId;
    }

    if (pendingAutoProjectIdRef.current) {
      return pendingAutoProjectIdRef.current;
    }

    return createMontageProjectRecord(nameHint, { switchWorkspaceToVault: false, markManualOverride: false });
  }, [createMontageProjectRecord, selectedMontageProjectId]);

  const projectNameById = useMemo(() => {
    return new Map(montageProjects.map((project) => [project.id, String(project.name || '').trim()]));
  }, [montageProjects]);

  const saveClipsToVault = useCallback((clips, sourceMeta = {}) => {
    if (!Array.isArray(clips) || clips.length === 0) return;

    const resolvedProjectId = String(sourceMeta.projectId || '').trim()
      || ensureActiveProjectId(String(sourceMeta.projectNameHint || sourceMeta.sourceTitle || 'Session'));
    const resolvedProjectName = String(
      sourceMeta.projectNameHint
      || projectNameById.get(resolvedProjectId)
      || 'Session'
    ).trim() || 'Session';
    const resolvedProjectFolder = slugify(resolvedProjectName) || 'session';
    const timestampNow = new Date().toISOString();
    setClipVault((previous) => {
      const next = [...previous];
      const indexByDedupeKey = new Map(next.map((item, index) => [item.dedupeKey, index]));

      clips.forEach((clip, index) => {
        const startTimestamp = String(clip.startTimestamp || '00:00');
        const endTimestamp = String(clip.endTimestamp || startTimestamp);
        const sourceRef = String(sourceMeta.sourceRef || '');
        const sourceTitle = String(sourceMeta.sourceTitle || sourceRef || 'Unknown Source');
        const originalTitle = String(clip.title || `Clip ${index + 1}`);
        const semanticName = buildSemanticClipName({
          clip: {
            ...clip,
            title: originalTitle,
          },
          sourceRef,
          startTimestamp,
          endTimestamp,
        });
        const title = semanticName.title;
        const dedupeKey = buildVaultDedupeKey({
          projectId: resolvedProjectId,
          sourceRef,
          startTimestamp,
          endTimestamp,
        });
        const rawDownloadUrl = String(clip.downloadUrl || '').trim();
        const renderDownloadUrl = String(clip.renderDownloadUrl || rawDownloadUrl).trim();
        const hasPersistableMedia = Boolean(rawDownloadUrl);
        const startSeconds = parseTimestampToSeconds(startTimestamp);
        const endSeconds = parseTimestampToSeconds(endTimestamp);
        const durationSeconds = (
          Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds
            ? endSeconds - startSeconds
            : Number(clip.durationSeconds) || null
        );
        const normalizedTranscriptSourceText = cleanClipText(
          clip.transcriptSourceText || clip.transcriptText || clip.description || ''
        );
        const normalizedTranscriptSelectedText = cleanClipText(clip.transcriptSelectedText || '');
        const normalizedTranscriptSnippet = cleanClipText(
          clip.transcriptSnippet || normalizedTranscriptSelectedText || normalizedTranscriptSourceText
        ).slice(0, 260);
        const normalizedCaptionCues = normalizeCaptionCues(clip.captionCues);

        const baseItem = {
          id: `vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          dedupeKey,
          projectId: resolvedProjectId,
          projectName: resolvedProjectName,
          projectFolder: resolvedProjectFolder,
          title,
          originalTitle,
          description: String(clip.description || ''),
          startTimestamp,
          endTimestamp,
          durationSeconds,
          viralScore: Number.isFinite(Number(clip.viralScore)) ? Number(clip.viralScore) : null,
          sourceRef,
          sourceTitle,
          sourceType: String(sourceMeta.sourceType || 'unknown'),
          contentProfile: String(sourceMeta.contentProfile || contentProfile),
          origin: String(sourceMeta.origin || 'identified'),
          transcriptSourceText: normalizedTranscriptSourceText,
          transcriptSnippet: normalizedTranscriptSnippet,
          transcriptSelectedText: normalizedTranscriptSelectedText,
          transcriptProvider: String(clip.transcriptProvider || ''),
          transcriptLanguage: String(clip.transcriptLanguage || ''),
          selectionStartSeconds: Number.isFinite(Number(clip.selectionStartSeconds))
            ? Number(Number(clip.selectionStartSeconds).toFixed(2))
            : null,
          selectionEndSeconds: Number.isFinite(Number(clip.selectionEndSeconds))
            ? Number(Number(clip.selectionEndSeconds).toFixed(2))
            : null,
          captionCues: normalizedCaptionCues,
          captionStylePreset: String(clip.captionStylePreset || 'reel-bold'),
          captionConfirmationStatus: String(clip.captionConfirmationStatus || 'pending'),
          captionConfirmedText: cleanClipText(clip.captionConfirmedText || ''),
          captionConfirmedAt: String(clip.captionConfirmedAt || ''),
          fileName: String(semanticName.fileName || clip.fileName || ''),
          downloadUrl: rawDownloadUrl,
          renderDownloadUrl,
          mediaPersistenceStatus: hasPersistableMedia ? 'pending' : 'none',
          mediaPersistenceError: '',
          mediaPersistedAt: '',
          mediaSizeBytes: null,
          createdAt: timestampNow,
          updatedAt: timestampNow,
        };

        const existingIndex = indexByDedupeKey.get(dedupeKey);
        if (Number.isInteger(existingIndex)) {
          const existing = next[existingIndex];
          const existingStatus = String(existing.mediaPersistenceStatus || '');
          const mergedMediaStatus = hasPersistableMedia
            ? (existingStatus === 'persisted' || existingStatus === 'persisting' ? existingStatus : 'pending')
            : 'none';
          next[existingIndex] = {
            ...existing,
            ...baseItem,
            id: existing.id,
            createdAt: existing.createdAt || timestampNow,
            mediaPersistenceStatus: mergedMediaStatus,
            mediaPersistenceError: mergedMediaStatus === 'failed' ? String(existing.mediaPersistenceError || '') : '',
            mediaPersistedAt: mergedMediaStatus === 'persisted' ? String(existing.mediaPersistedAt || '') : '',
            mediaSizeBytes: mergedMediaStatus === 'persisted'
              ? (Number.isFinite(Number(existing.mediaSizeBytes)) ? Number(existing.mediaSizeBytes) : null)
              : null,
          };
          return;
        }

        next.unshift(baseItem);
        indexByDedupeKey.set(dedupeKey, 0);
      });

      return next.sort((a, b) => {
        return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      });
    });
  }, [contentProfile, ensureActiveProjectId, projectNameById]);

  const persistClipMediaById = useCallback(async (clipId) => {
    const normalizedClipId = String(clipId || '').trim();
    if (!normalizedClipId) return;

    let targetClip = null;
    const nowIso = new Date().toISOString();
    setClipVault((previous) => previous.map((item) => {
      if (item.id !== normalizedClipId) return item;
      if (String(item.mediaPersistenceStatus || '') !== 'pending') return item;
      targetClip = item;
      return {
        ...item,
        mediaPersistenceStatus: 'persisting',
        mediaPersistenceError: '',
        updatedAt: nowIso,
      };
    }));

    if (!targetClip) return;

    try {
      const sourceUrl = String(targetClip.downloadUrl || '').trim();
      if (!sourceUrl) {
        throw new Error('No clip file URL available to persist.');
      }

      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`Unable to cache clip file (HTTP ${response.status}).`);
      }

      const blob = await response.blob();
      if (!(blob instanceof Blob) || blob.size <= 0) {
        throw new Error('Clip file returned empty data.');
      }

      await storeClipMedia({
        clipId: normalizedClipId,
        projectId: targetClip.projectId,
        fileName: targetClip.fileName,
        blob,
      });

      const trimmedIds = await trimClipMediaStore({
        maxBytes: CLIP_MEDIA_MAX_BYTES,
        protectedClipIds: [normalizedClipId],
      });

      const persistedRecord = await getClipMedia(normalizedClipId);
      if (!persistedRecord?.blob) {
        throw new Error('Clip cache write did not persist.');
      }

      setClipPlaybackUrl(normalizedClipId, URL.createObjectURL(persistedRecord.blob));
      setClipVault((previous) => previous.map((item) => {
        if (item.id === normalizedClipId) {
          return {
            ...item,
            mediaPersistenceStatus: 'persisted',
            mediaPersistenceError: '',
            mediaPersistedAt: new Date().toISOString(),
            mediaSizeBytes: Number(blob.size || 0),
            updatedAt: new Date().toISOString(),
          };
        }

        if (!trimmedIds.includes(item.id)) {
          return item;
        }

        return {
          ...item,
          mediaPersistenceStatus: 'none',
          mediaPersistenceError: '',
          mediaPersistedAt: '',
          mediaSizeBytes: null,
          updatedAt: new Date().toISOString(),
        };
      }));

      trimmedIds.forEach((trimmedId) => {
        if (trimmedId !== normalizedClipId) {
          setClipPlaybackUrl(trimmedId, '');
        }
      });
      await refreshClipMediaStats();
    } catch (error) {
      const errorMessage = String(error?.message || 'Clip cache failed.');
      console.error('Clip media persistence failed:', error);
      setClipVault((previous) => previous.map((item) => {
        if (item.id !== normalizedClipId) return item;
        return {
          ...item,
          mediaPersistenceStatus: 'failed',
          mediaPersistenceError: errorMessage,
          updatedAt: new Date().toISOString(),
        };
      }));
      await refreshClipMediaStats();
    }
  }, [refreshClipMediaStats, setClipPlaybackUrl]);

  useEffect(() => {
    const q = query(collection(db, 'videos'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const videosData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setVideos(videosData);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    clipPlaybackUrlsRef.current = clipPlaybackUrls;
  }, [clipPlaybackUrls]);

  useEffect(() => {
    return () => {
      const activeUrls = Object.values(clipPlaybackUrlsRef.current || {});
      activeUrls.forEach((url) => {
        if (typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (!selectedMontageProjectId) {
      pendingAutoProjectIdRef.current = '';
      return;
    }
    pendingAutoProjectIdRef.current = selectedMontageProjectId;
  }, [selectedMontageProjectId]);

  useEffect(() => {
    void refreshClipMediaStats();
  }, [refreshClipMediaStats]);

  useEffect(() => {
    writeLocalJsonSafe(CLIP_VAULT_STORAGE_KEY, clipVault);
  }, [clipVault]);

  useEffect(() => {
    writeLocalJsonSafe(MONTAGE_PROJECT_STORAGE_KEY, montageProjects);
  }, [montageProjects]);

  useEffect(() => {
    writeLocalJsonSafe(SELECTED_PROJECT_STORAGE_KEY, selectedMontageProjectId);
  }, [selectedMontageProjectId]);

  useEffect(() => {
    const hasUnscopedClips = clipVault.some((clip) => !String(clip.projectId || '').trim());
    if (!hasUnscopedClips) return;

    const legacyProjectId = 'montage-legacy-imports';
    const hasLegacyProject = montageProjects.some((project) => project.id === legacyProjectId);
    if (!hasLegacyProject) {
      const createdAt = new Date().toISOString();
      setMontageProjects((previous) => ([
        {
          id: legacyProjectId,
          name: 'Legacy Imports',
          timelineItems: [],
          clipIds: [],
          createdAt,
          updatedAt: createdAt,
        },
        ...previous,
      ]));
    }

    setClipVault((previous) => previous.map((clip) => {
      if (String(clip.projectId || '').trim()) return clip;
      return {
        ...clip,
        projectId: legacyProjectId,
        projectName: 'Legacy Imports',
        projectFolder: 'legacy-imports',
        dedupeKey: buildVaultDedupeKey({
          projectId: legacyProjectId,
          sourceRef: clip.sourceRef,
          startTimestamp: clip.startTimestamp,
          endTimestamp: clip.endTimestamp,
        }),
        updatedAt: clip.updatedAt || new Date().toISOString(),
      };
    }));

    if (!selectedMontageProjectId) {
      setSelectedMontageProjectId(legacyProjectId);
    }
  }, [clipVault, montageProjects, selectedMontageProjectId]);

  useEffect(() => {
    if (!selectedMontageProjectId) return;
    const stillExists = montageProjects.some((project) => project.id === selectedMontageProjectId);
    if (!stillExists) {
      setSelectedMontageProjectId(montageProjects[0]?.id || '');
    }
  }, [montageProjects, selectedMontageProjectId]);

  useEffect(() => {
    if (workspace === 'vault') {
      setActiveTopNavView('vault');
      return;
    }

    if (activeTopNavView === 'vault') {
      setActiveTopNavView('preview');
    }
  }, [workspace, activeTopNavView]);

  useEffect(() => {
    const clipIds = new Set(clipVault.map((clip) => clip.id));
    const staleIds = Object.keys(clipPlaybackUrls).filter((clipId) => !clipIds.has(clipId));
    if (staleIds.length === 0) return;
    staleIds.forEach((clipId) => setClipPlaybackUrl(clipId, ''));
  }, [clipPlaybackUrls, clipVault, setClipPlaybackUrl]);

  useEffect(() => {
    const pendingClips = clipVault.filter((clip) => {
      return String(clip.mediaPersistenceStatus || '') === 'pending'
        && Boolean(String(clip.downloadUrl || '').trim());
    });

    pendingClips.forEach((clip) => {
      if (clipPersistenceInFlightRef.current.has(clip.id)) return;
      clipPersistenceInFlightRef.current.add(clip.id);
      void persistClipMediaById(clip.id).finally(() => {
        clipPersistenceInFlightRef.current.delete(clip.id);
      });
    });
  }, [clipVault, persistClipMediaById]);

  useEffect(() => {
    const hydrateTargets = clipVault.filter((clip) => {
      return String(clip.mediaPersistenceStatus || '') === 'persisted'
        && !clipPlaybackUrls[clip.id];
    });
    if (hydrateTargets.length === 0) return;

    let disposed = false;
    hydrateTargets.forEach((clip) => {
      if (mediaHydrationInFlightRef.current.has(clip.id)) return;
      mediaHydrationInFlightRef.current.add(clip.id);

      void (async () => {
        try {
          const record = await getClipMedia(clip.id);
          if (disposed) return;

          if (record?.blob) {
            setClipPlaybackUrl(clip.id, URL.createObjectURL(record.blob));
            return;
          }

          setClipVault((previous) => previous.map((item) => {
            if (item.id !== clip.id) return item;
            return {
              ...item,
              mediaPersistenceStatus: item.downloadUrl ? 'pending' : 'none',
              mediaPersistenceError: '',
              mediaPersistedAt: '',
              mediaSizeBytes: null,
              updatedAt: new Date().toISOString(),
            };
          }));
        } catch (error) {
          console.error('Failed to hydrate persisted clip media:', error);
        } finally {
          mediaHydrationInFlightRef.current.delete(clip.id);
        }
      })();
    });

    return () => {
      disposed = true;
    };
  }, [clipPlaybackUrls, clipVault, setClipPlaybackUrl]);

  useEffect(() => {
    const handleMouseMove = (event) => {
      const resizeState = sidebarResizeStateRef.current;
      if (!resizeState) return;

      const deltaX = event.clientX - resizeState.startX;
      const nextWidth = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, resizeState.startWidth + deltaX)
      );
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      if (!sidebarResizeStateRef.current) return;
      sidebarResizeStateRef.current = null;
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

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
    if (!isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const processUploadedFile = async (file, projectId) => {
    if (!file) return;

    try {
      if (skipStorageUploadInLocalMode) {
        setLocalDebug('Local mode active');
        const localVideoReference = `local-file://${encodeURIComponent(file.name)}`;
        const localVideoId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const localVideo = {
          id: localVideoId,
          title: file.name,
          status: 'processing',
          image: 'https://images.unsplash.com/photo-1516280440502-a169b2752101?q=80&w=2670&auto=format&fit=crop',
          duration: '00:00',
          statusLabel: 'Calling AI (local mode)...',
          dateLabel: 'Just Now',
          clipsGenerated: 0,
          clips: [],
          clipFiles: [],
          uploadProgress: 100,
          videoUrl: localVideoReference
        };
        setLocalVideos(prev => [localVideo, ...prev]);
        setLocalDebug('Local card created');

        try {
          setLocalDebug('Calling generateClips...');
          const result = await callGenerateClipsWithTimeout({
            videoUrl: localVideoReference,
            videoTitle: file.name,
            contentType: contentProfile
          });
          const generatedClips = Array.isArray(result.data?.clips) ? result.data.clips : [];
          setLocalDebug(`AI returned ${generatedClips.length} clips`);
          saveClipsToVault(generatedClips, {
            projectId,
            projectNameHint: stripFileExtension(file.name) || file.name,
            sourceRef: localVideoReference,
            sourceTitle: file.name,
            sourceType: 'local-file',
            contentProfile,
            origin: 'ai-identify',
          });
          updateLocalVideo(localVideoId, {
            statusLabel: `Rendering clips (0/${generatedClips.length})...`,
            clips: generatedClips
          });

          const clipFiles = await renderLocalClipFiles({
            sourceFile: file,
            clips: generatedClips,
            onProgress: ({ current, total }) => {
              setLocalDebug(`Rendering clip ${current}/${total}...`);
              updateLocalVideo(localVideoId, {
                statusLabel: `Rendering clips (${current}/${total})...`
              });
            }
          });
          setLocalDebug(`Rendered ${clipFiles.length} clips`);
          saveClipsToVault(clipFiles, {
            projectId,
            projectNameHint: stripFileExtension(file.name) || file.name,
            sourceRef: localVideoReference,
            sourceTitle: file.name,
            sourceType: 'local-file',
            contentProfile,
            origin: 'local-render',
          });

          updateLocalVideo(localVideoId, {
            status: 'processed',
            statusLabel: 'Ready',
            clips: generatedClips,
            clipFiles,
            clipsGenerated: clipFiles.length || generatedClips.length,
            uploadProgress: 100
          });
          setLocalDebug('Done');
        } catch (error) {
          console.error('Processing failed', error);
          setLocalDebug(`AI failed: ${error.message || 'Unknown error'}`);
          updateLocalVideo(localVideoId, {
            status: 'failed',
            statusLabel: 'Processing failed',
            uploadProgress: 100,
            errorMessage: error.message || 'Processing error'
          });
        }

        return;
      }

      const docRef = await addDoc(collection(db, 'videos'), {
        title: file.name,
        status: 'processing',
        image: 'https://images.unsplash.com/photo-1516280440502-a169b2752101?q=80&w=2670&auto=format&fit=crop',
        duration: '00:00',
        statusLabel: 'Uploading...',
        dateLabel: 'Just Now',
        clipsGenerated: 0,
        createdAt: serverTimestamp()
      });

      const storageRef = ref(storage, `videos/${docRef.id}/${file.name}`);
      const uploadTask = uploadBytesResumable(storageRef, file);
      let lastProgressUpdate = -1;

      uploadTask.on(
        'state_changed',
        (snapshot) => {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
          const shouldUpdate =
            progress === 100 ||
            lastProgressUpdate < 0 ||
            progress - lastProgressUpdate >= 10;

          if (!shouldUpdate) return;

          lastProgressUpdate = progress;
          void updateDoc(docRef, {
            status: 'processing',
            statusLabel: `Uploading... ${progress}%`,
            uploadProgress: progress,
            updatedAt: serverTimestamp()
          }).catch((error) => {
            console.error('Failed to update upload progress', error);
          });
        },
        async (error) => {
          console.error('Upload failed', error);
          try {
            await updateDoc(docRef, {
              status: 'failed',
              statusLabel: 'Upload failed',
              uploadProgress: 0,
              errorMessage: error.message || 'Upload error',
              updatedAt: serverTimestamp()
            });
          } catch (updateError) {
            console.error('Failed to update upload error state', updateError);
          }
        },
        async () => {
          try {
            const videoUrl = await getDownloadURL(uploadTask.snapshot.ref);

            await updateDoc(docRef, {
              status: 'processing',
              statusLabel: 'Analyzing video...',
              uploadProgress: 100,
              videoUrl,
              updatedAt: serverTimestamp()
            });

            const result = await callGenerateClipsWithTimeout({
              videoUrl,
              videoTitle: file.name,
              contentType: contentProfile
            });

            const generatedClips = Array.isArray(result.data?.clips) ? result.data.clips : [];
            saveClipsToVault(generatedClips, {
              projectId,
              projectNameHint: stripFileExtension(file.name) || file.name,
              sourceRef: videoUrl,
              sourceTitle: file.name,
              sourceType: 'cloud-storage',
              contentProfile,
              origin: 'ai-identify',
            });

            await updateDoc(docRef, {
              status: 'processed',
              statusLabel: 'Ready',
              clips: generatedClips,
              clipsGenerated: generatedClips.length,
              uploadProgress: 100,
              updatedAt: serverTimestamp()
            });
          } catch (error) {
            console.error('Processing failed', error);
            try {
              await updateDoc(docRef, {
                status: 'failed',
                statusLabel: 'Processing failed',
                uploadProgress: 100,
                errorMessage: error.message || 'Processing error',
                updatedAt: serverTimestamp()
              });
            } catch (updateError) {
              console.error('Failed to update processing error state', updateError);
            }
          }
        }
      );
    } catch (err) {
      console.error('Error setting up upload', err);
    }
  };

  const handleIngestFile = (file) => {
    if (!file) return;
    if (!String(file.type || '').startsWith('video/')) return;

    const projectName = stripFileExtension(file.name) || file.name || `Session ${new Date().toLocaleDateString()}`;
    const projectId = createMontageProjectRecord(projectName, {
      switchWorkspaceToVault: false,
      markManualOverride: false,
    });
    setWorkspace('studio');
    setActiveSource({
      kind: 'file',
      label: file.name,
      payload: file
    });

    void processUploadedFile(file, projectId);
  };

  const handleIngestUrl = (url) => {
    const normalizedUrl = parseHttpUrl(url);
    if (!normalizedUrl) return;

    createMontageProjectRecord(inferProjectNameFromUrl(normalizedUrl), {
      switchWorkspaceToVault: false,
      markManualOverride: false,
    });
    setWorkspace('studio');
    setActiveSource({
      kind: 'url',
      label: normalizedUrl,
      payload: normalizedUrl
    });
  };

  const handleDropPayload = (payload) => {
    if (!payload) return;

    if (payload.kind === 'file' && payload.file) {
      handleIngestFile(payload.file);
      return;
    }

    if (payload.kind === 'url' && payload.url) {
      handleIngestUrl(payload.url);
    }
  };

  const handleCreateMontageProject = useCallback((projectName) => {
    const trimmedName = String(projectName || '').trim();
    if (!trimmedName) return null;
    return createMontageProjectRecord(trimmedName, {
      switchWorkspaceToVault: true,
      markManualOverride: true,
    });
  }, [createMontageProjectRecord]);

  const handleRenameMontageProject = useCallback((projectId, nextName) => {
    const normalizedProjectId = String(projectId || '').trim();
    const normalizedName = String(nextName || '').trim();
    if (!normalizedProjectId || !normalizedName) return false;

    let changed = false;
    setMontageProjects((previous) => previous.map((project) => {
      if (project.id !== normalizedProjectId) return project;
      if (String(project.name || '').trim() === normalizedName) return project;
      changed = true;
      return {
        ...project,
        name: normalizedName,
        updatedAt: new Date().toISOString(),
      };
    }));

    if (!changed) return false;
    manualProjectNameOverridesRef.current.add(normalizedProjectId);
    setClipVault((previous) => previous.map((clip) => {
      if (String(clip.projectId || '') !== normalizedProjectId) return clip;
      return {
        ...clip,
        projectName: normalizedName,
        projectFolder: slugify(normalizedName) || 'session',
        updatedAt: new Date().toISOString(),
      };
    }));
    return true;
  }, []);

  const handleProjectNameSuggestion = useCallback((suggestedName) => {
    const normalizedProjectId = String(selectedMontageProjectId || '').trim();
    const normalizedName = String(suggestedName || '').trim();
    if (!normalizedProjectId || !normalizedName) return false;
    if (manualProjectNameOverridesRef.current.has(normalizedProjectId)) return false;

    let changed = false;
    setMontageProjects((previous) => previous.map((project) => {
      if (project.id !== normalizedProjectId) return project;
      const currentName = String(project.name || '').trim();
      if (currentName === normalizedName) return project;
      changed = true;
      return {
        ...project,
        name: normalizedName,
        updatedAt: new Date().toISOString(),
      };
    }));

    if (!changed) return false;
    setClipVault((previous) => previous.map((clip) => {
      if (String(clip.projectId || '') !== normalizedProjectId) return clip;
      return {
        ...clip,
        projectName: normalizedName,
        projectFolder: slugify(normalizedName) || 'session',
        updatedAt: new Date().toISOString(),
      };
    }));
    return true;
  }, [selectedMontageProjectId]);

  const handleFlushProjectMedia = useCallback(async (projectId) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return false;

    const clipIds = clipVault
      .filter((clip) => String(clip.projectId || '') === normalizedProjectId)
      .map((clip) => clip.id);

    try {
      await deleteProjectClipMedia(normalizedProjectId);
      clipIds.forEach((clipId) => setClipPlaybackUrl(clipId, ''));
      setClipVault((previous) => previous.map((clip) => {
        if (String(clip.projectId || '') !== normalizedProjectId) return clip;
        return {
          ...clip,
          mediaPersistenceStatus: 'none',
          mediaPersistenceError: '',
          mediaPersistedAt: '',
          mediaSizeBytes: null,
          updatedAt: new Date().toISOString(),
        };
      }));
      await refreshClipMediaStats();
      return true;
    } catch (error) {
      console.error('Failed to flush project media:', error);
      return false;
    }
  }, [clipVault, refreshClipMediaStats, setClipPlaybackUrl]);

  const handleDeleteProject = useCallback(async (projectId) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return false;

    const clipIds = clipVault
      .filter((clip) => String(clip.projectId || '') === normalizedProjectId)
      .map((clip) => clip.id);

    try {
      await deleteProjectClipMedia(normalizedProjectId);
    } catch (error) {
      console.error('Failed deleting project media from cache:', error);
    }

    clipIds.forEach((clipId) => {
      setClipPlaybackUrl(clipId, '');
      void deleteClipMedia(clipId).catch(() => {});
    });

    setClipVault((previous) => previous.filter((clip) => String(clip.projectId || '') !== normalizedProjectId));
    setMontageProjects((previous) => previous.filter((project) => project.id !== normalizedProjectId));
    setSelectedMontageProjectId((previous) => {
      if (previous !== normalizedProjectId) return previous;
      const remaining = montageProjects.filter((project) => project.id !== normalizedProjectId);
      return remaining[0]?.id || '';
    });

    if (pendingAutoProjectIdRef.current === normalizedProjectId) {
      pendingAutoProjectIdRef.current = '';
    }
    manualProjectNameOverridesRef.current.delete(normalizedProjectId);

    await refreshClipMediaStats();
    return true;
  }, [clipVault, montageProjects, refreshClipMediaStats, setClipPlaybackUrl]);

  const handleExportProject = useCallback(async (projectId) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) {
      return { success: false, message: 'Select a project first.' };
    }

    const project = montageProjects.find((entry) => entry.id === normalizedProjectId);
    const projectName = String(project?.name || 'Project').trim() || 'Project';
    const folderName = sanitizeFileNamePart(projectName, 'Project');

    const projectClips = clipVault
      .filter((clip) => String(clip.projectId || '') === normalizedProjectId)
      .sort((a, b) => {
        return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      });

    if (projectClips.length === 0) {
      return { success: false, message: 'No clips in this project yet.' };
    }

    const buildOutputName = (clip, index) => {
      const ext = getFileExtension(clip.fileName, 'mp4');
      const base = sanitizeFileNamePart(clip.title || clip.fileName || `clip-${index + 1}`, `clip-${index + 1}`);
      return `${String(index + 1).padStart(3, '0')}-${base}.${ext}`;
    };

    const resolveClipUrl = (clip) => {
      const persisted = String(clipPlaybackUrls[clip.id] || '').trim();
      if (persisted) return persisted;
      const render = String(clip.renderDownloadUrl || '').trim();
      if (render) return render;
      return String(clip.downloadUrl || '').trim();
    };

    if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
      try {
        const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const projectHandle = await rootHandle.getDirectoryHandle(folderName, { create: true });
        let exportedCount = 0;
        let skippedCount = 0;

        for (let index = 0; index < projectClips.length; index += 1) {
          const clip = projectClips[index];
          const sourceUrl = resolveClipUrl(clip);
          if (!sourceUrl) {
            skippedCount += 1;
            continue;
          }

          const response = await fetch(sourceUrl);
          if (!response.ok) {
            skippedCount += 1;
            continue;
          }

          const blob = await response.blob();
          if (!(blob instanceof Blob) || blob.size <= 0) {
            skippedCount += 1;
            continue;
          }

          const outputName = buildOutputName(clip, index);
          const fileHandle = await projectHandle.getFileHandle(outputName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          exportedCount += 1;
        }

        if (exportedCount === 0) {
          return { success: false, message: 'No clips could be exported from this project.' };
        }

        if (skippedCount > 0) {
          return { success: true, message: `Exported ${exportedCount} clip(s) to "${folderName}". ${skippedCount} skipped.` };
        }

        return { success: true, message: `Exported ${exportedCount} clip(s) to "${folderName}".` };
      } catch (error) {
        if (String(error?.name || '') === 'AbortError') {
          return { success: false, message: 'Export cancelled.' };
        }
        console.error('Project export via File System Access failed:', error);
      }
    }

    let downloadCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < projectClips.length; index += 1) {
      const clip = projectClips[index];
      const sourceUrl = resolveClipUrl(clip);
      if (!sourceUrl) {
        skippedCount += 1;
        continue;
      }

      const link = document.createElement('a');
      link.href = sourceUrl;
      link.download = `${folderName}__${buildOutputName(clip, index)}`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      downloadCount += 1;
      await sleep(120);
    }

    if (downloadCount === 0) {
      return { success: false, message: 'No clips could be exported from this project.' };
    }

    if (skippedCount > 0) {
      return { success: true, message: `Started ${downloadCount} download(s). ${skippedCount} skipped.` };
    }
    return { success: true, message: `Started ${downloadCount} download(s) for "${projectName}".` };
  }, [clipPlaybackUrls, clipVault, montageProjects]);

  const handleAddClipToProject = useCallback((clipId, projectId, targetIndex = null) => {
    if (!clipId || !projectId) return false;
    let wasAdded = false;
    const clipRecord = clipVault.find((clip) => clip.id === clipId) || null;

    setMontageProjects((previous) =>
      previous.map((project) => {
        if (project.id !== projectId) return project;
        const existingTimelineItems = Array.isArray(project.timelineItems) ? [...project.timelineItems] : [];
        const clipDuration = Number(clipRecord?.durationSeconds);
        const timelineItem = {
          ...createTimelineItem(clipId),
          trimEndSeconds: Number.isFinite(clipDuration) && clipDuration > TIMELINE_MIN_GAP_SECONDS
            ? Number(clipDuration.toFixed(2))
            : null,
          captionStylePreset: String(clipRecord?.captionStylePreset || 'reel-bold'),
        };
        const insertIndex = Number.isInteger(targetIndex)
          ? Math.max(0, Math.min(targetIndex, existingTimelineItems.length))
          : existingTimelineItems.length;
        existingTimelineItems.splice(insertIndex, 0, timelineItem);
        const nextTimelineItems = existingTimelineItems;
        wasAdded = true;
        return {
          ...project,
          timelineItems: nextTimelineItems,
          clipIds: nextTimelineItems.map((item) => item.clipId),
          updatedAt: new Date().toISOString(),
        };
      })
    );

    return wasAdded;
  }, [clipVault]);

  const handleRemoveTimelineItem = useCallback((timelineItemId, projectId) => {
    if (!timelineItemId || !projectId) return;
    setMontageProjects((previous) =>
      previous.map((project) => {
        if (project.id !== projectId) return project;
        const existingTimelineItems = Array.isArray(project.timelineItems) ? project.timelineItems : [];
        const nextTimelineItems = existingTimelineItems.filter((item) => item.id !== timelineItemId);
        return {
          ...project,
          timelineItems: nextTimelineItems,
          clipIds: nextTimelineItems.map((item) => item.clipId),
          updatedAt: new Date().toISOString(),
        };
      })
    );
  }, []);

  const handleMoveTimelineItem = useCallback((projectId, timelineItemId, targetIndex) => {
    if (!projectId || !timelineItemId || !Number.isInteger(targetIndex)) return;
    setMontageProjects((previous) =>
      previous.map((project) => {
        if (project.id !== projectId) return project;
        const existingTimelineItems = Array.isArray(project.timelineItems) ? [...project.timelineItems] : [];
        const sourceIndex = existingTimelineItems.findIndex((item) => item.id === timelineItemId);
        if (sourceIndex < 0) return project;

        const [movedItem] = existingTimelineItems.splice(sourceIndex, 1);
        const boundedTarget = Math.max(0, Math.min(targetIndex, existingTimelineItems.length));
        existingTimelineItems.splice(boundedTarget, 0, movedItem);

        return {
          ...project,
          timelineItems: existingTimelineItems,
          clipIds: existingTimelineItems.map((item) => item.clipId),
          updatedAt: new Date().toISOString(),
        };
      })
    );
  }, []);

  const handleUpdateTimelineItem = useCallback((projectId, timelineItemId, patch) => {
    if (!projectId || !timelineItemId || !patch || typeof patch !== 'object') return;
    const patchKeys = Object.keys(patch);
    const trimChanged = patchKeys.includes('trimStartSeconds') || patchKeys.includes('trimEndSeconds');
    const normalizedPatch = {
      ...patch,
    };
    if (trimChanged) {
      normalizedPatch.captionConfirmationStatus = 'pending';
      normalizedPatch.captionConfirmedText = '';
      normalizedPatch.captionConfirmedAt = '';
    }

    setMontageProjects((previous) =>
      previous.map((project) => {
        if (project.id !== projectId) return project;
        const existingTimelineItems = Array.isArray(project.timelineItems) ? project.timelineItems : [];
        const nextTimelineItems = existingTimelineItems.map((item) => {
          if (item.id !== timelineItemId) return item;
          return {
            ...item,
            ...normalizedPatch,
          };
        });

        return {
          ...project,
          timelineItems: nextTimelineItems,
          clipIds: nextTimelineItems.map((item) => item.clipId),
          updatedAt: new Date().toISOString(),
        };
      })
    );
  }, []);

  const handleSplitTimelineItem = useCallback((projectId, timelineItemId, splitSeconds) => {
    if (!projectId || !timelineItemId || !Number.isFinite(Number(splitSeconds))) return null;
    let splitResult = null;

    setMontageProjects((previous) =>
      previous.map((project) => {
        if (project.id !== projectId) return project;
        const existingTimelineItems = Array.isArray(project.timelineItems) ? [...project.timelineItems] : [];
        const sourceIndex = existingTimelineItems.findIndex((item) => item.id === timelineItemId);
        if (sourceIndex < 0) return project;

        const sourceItem = existingTimelineItems[sourceIndex];
        const currentStart = Number.isFinite(Number(sourceItem.trimStartSeconds))
          ? Number(sourceItem.trimStartSeconds)
          : 0;
        const rawEnd = Number(sourceItem.trimEndSeconds);
        const hasFiniteEnd = Number.isFinite(rawEnd);
        const currentEnd = hasFiniteEnd ? rawEnd : null;
        const splitPoint = Number(splitSeconds);

        const boundedSplit = Math.max(currentStart + TIMELINE_MIN_GAP_SECONDS, splitPoint);
        if (hasFiniteEnd && boundedSplit >= currentEnd - TIMELINE_MIN_GAP_SECONDS) {
          return project;
        }

        const leftTrimEnd = hasFiniteEnd ? Math.min(boundedSplit, currentEnd) : boundedSplit;
        const rightTrimStart = leftTrimEnd;
        const leftItem = {
          ...sourceItem,
          trimStartSeconds: Number(currentStart.toFixed(2)),
          trimEndSeconds: Number(leftTrimEnd.toFixed(2)),
          captionConfirmationStatus: 'pending',
          captionConfirmedText: '',
          captionConfirmedAt: '',
          captionTextOverride: '',
        };
        const rightItem = {
          ...sourceItem,
          id: createTimelineItem(sourceItem.clipId).id,
          trimStartSeconds: Number(rightTrimStart.toFixed(2)),
          trimEndSeconds: hasFiniteEnd ? Number(currentEnd.toFixed(2)) : null,
          captionConfirmationStatus: 'pending',
          captionConfirmedText: '',
          captionConfirmedAt: '',
          captionTextOverride: '',
          createdAt: new Date().toISOString(),
        };

        existingTimelineItems.splice(sourceIndex, 1, leftItem, rightItem);
        splitResult = {
          leftId: leftItem.id,
          rightId: rightItem.id,
        };

        return {
          ...project,
          timelineItems: existingTimelineItems,
          clipIds: existingTimelineItems.map((item) => item.clipId),
          updatedAt: new Date().toISOString(),
        };
      })
    );

    return splitResult;
  }, []);

  const handleManualClipsRendered = useCallback((clips, sourceMeta) => {
    const projectId = String(sourceMeta?.projectId || '').trim()
      || ensureActiveProjectId(String(sourceMeta?.sourceTitle || 'Manual Session'));
    saveClipsToVault(clips, { ...sourceMeta, projectId });
  }, [ensureActiveProjectId, saveClipsToVault]);

  const handleUploadShortcut = () => {
    const isDesktopViewport =
      typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

    if (isDesktopViewport) {
      desktopIngestSurfaceRef.current?.activateUpload?.();
      return;
    }

    if (workspace !== 'studio') {
      setWorkspace('studio');
      window.setTimeout(() => {
        mobileIngestSurfaceRef.current?.activateUpload?.();
      }, 40);
      return;
    }

    mobileIngestSurfaceRef.current?.activateUpload?.();
  };

  const displayVideos = skipStorageUploadInLocalMode ? [...localVideos, ...videos] : videos;
  const clipVaultForWorkspace = useMemo(() => {
    return clipVault.map((clip) => ({
      ...clip,
      playbackUrl: clipPlaybackUrls[clip.id] || '',
      renderDownloadUrl: String(clip.renderDownloadUrl || clip.downloadUrl || ''),
    }));
  }, [clipPlaybackUrls, clipVault]);

  const scrollStudioSectionIntoView = useCallback((target, behavior = 'smooth') => {
    const targetElement = target === 'recent'
      ? recentSectionRef.current
      : previewSectionRef.current;
    if (!targetElement) return false;
    targetElement.scrollIntoView({ behavior, block: 'start' });
    return true;
  }, []);

  const handleTopNavNavigate = useCallback((target) => {
    if (target === 'vault') {
      setWorkspace('vault');
      setActiveTopNavView('vault');
      mainScrollContainerRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
      return;
    }

    setWorkspace('studio');
    setActiveTopNavView(target);
    setPendingStudioNavTarget(target);
  }, []);

  useEffect(() => {
    if (workspace !== 'studio' || !pendingStudioNavTarget) return;
    const frameId = window.requestAnimationFrame(() => {
      const didScroll = scrollStudioSectionIntoView(pendingStudioNavTarget);
      if (didScroll) {
        setPendingStudioNavTarget('');
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [workspace, pendingStudioNavTarget, scrollStudioSectionIntoView]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((previous) => !previous);
  }, []);

  const handleSidebarResizeStart = useCallback((event) => {
    if (isSidebarCollapsed) return;
    event.preventDefault();
    sidebarResizeStateRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [isSidebarCollapsed, sidebarWidth]);

  return (
    <div className={`min-h-screen font-display ${isDarkMode ? 'dark text-slate-100 bg-background-dark' : 'text-slate-900 bg-background-light'}`}>
      {import.meta.env.DEV && localDebugStatus && (
        <div className="fixed top-3 right-3 z-[100] rounded-lg bg-slate-900/90 text-white text-xs px-3 py-2 shadow-xl max-w-xs">
          {localDebugStatus}
        </div>
      )}

      <div className="flex min-h-screen">
        {!isSidebarCollapsed && (
          <>
            <Sidebar
              className="hidden lg:flex shrink-0"
              style={{ width: `${sidebarWidth}px` }}
              ingestPanel={(
                <IngestSurface
                  ref={desktopIngestSurfaceRef}
                  activeSource={activeSource}
                  onIngestFile={handleIngestFile}
                  onIngestUrl={handleIngestUrl}
                  onDropPayload={handleDropPayload}
                  compact
                  sourceUrlInputId="source-url-input-desktop"
                />
              )}
              activeSource={activeSource}
              contentProfile={contentProfile}
              onContentProfileChange={setContentProfile}
              currentWorkspace={workspace}
              onWorkspaceChange={setWorkspace}
            />
            <button
              type="button"
              aria-label="Resize menu pane"
              onMouseDown={handleSidebarResizeStart}
              className="hidden lg:block w-1.5 cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors"
            />
          </>
        )}

        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <TopNav
            isDarkMode={isDarkMode}
            toggleTheme={toggleTheme}
            onUpload={handleUploadShortcut}
            onToggleSidebar={handleToggleSidebar}
            isSidebarCollapsed={isSidebarCollapsed}
            onNavigate={handleTopNavNavigate}
            activeView={activeTopNavView}
          />

          <div ref={mainScrollContainerRef} className="flex-1 overflow-y-auto p-4 lg:p-8 space-y-8 scroll-smooth pb-24 lg:pb-8">
            {workspace === 'studio' && (
              <>
                <IngestSurface
                  ref={mobileIngestSurfaceRef}
                  activeSource={activeSource}
                  onIngestFile={handleIngestFile}
                  onIngestUrl={handleIngestUrl}
                  onDropPayload={handleDropPayload}
                  className="lg:hidden"
                  sourceUrlInputId="source-url-input-mobile"
                />

                <div ref={previewSectionRef}>
                  <AppErrorBoundary
                    resetKey={`${workspace}:${String(activeSource?.kind || 'none')}:${String(activeSource?.label || '')}`}
                  >
                    <ManualClipLab
                      activeSource={activeSource}
                      contentProfile={contentProfile}
                      onClipsRendered={handleManualClipsRendered}
                      onProjectNameSuggestion={handleProjectNameSuggestion}
                    />
                  </AppErrorBoundary>
                </div>

                <div ref={recentSectionRef} className="pt-4">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-accent-neon">
                      Recent Processed
                    </h2>
                    <button className="text-sm font-medium text-slate-500 hover:text-primary dark:text-slate-400 dark:hover:text-accent-neon transition-colors">
                      View All
                    </button>
                  </div>
                  <VideoGrid videos={displayVideos} />
                </div>
              </>
            )}

            {workspace === 'vault' && (
              <ClipVaultWorkspace
                clips={clipVaultForWorkspace}
                montageProjects={montageProjects}
                selectedProjectId={selectedMontageProjectId}
                onSelectedProjectChange={setSelectedMontageProjectId}
                onCreateProject={handleCreateMontageProject}
                onRenameProject={handleRenameMontageProject}
                onExportProject={handleExportProject}
                onDeleteProject={handleDeleteProject}
                onFlushProjectMedia={handleFlushProjectMedia}
                onAddClipToProject={handleAddClipToProject}
                onRemoveClipFromProject={handleRemoveTimelineItem}
                onMoveTimelineItem={handleMoveTimelineItem}
                onUpdateTimelineItem={handleUpdateTimelineItem}
                onSplitTimelineItem={handleSplitTimelineItem}
                mediaStats={clipMediaStats}
              />
            )}
          </div>
        </main>
      </div>
      <MobileTabBar
        onUpload={handleUploadShortcut}
        currentWorkspace={workspace}
        onWorkspaceChange={setWorkspace}
      />
    </div>
  );
}

export default App;
