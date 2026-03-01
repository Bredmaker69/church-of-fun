import React, { useEffect, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { renderLocalClipFiles } from '../lib/localClipper';

const CONTENT_PROFILES = [
  { id: 'generic', label: 'Generic' },
  { id: 'sports', label: 'Sports' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'podcast', label: 'Podcast' },
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

const parseTimestamp = (value) => {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
};

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

const extractDroppedUrl = (event) => {
  const uriList = event.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    const first = uriList.split('\n').map((line) => line.trim()).find(Boolean);
    if (first) return first;
  }

  const text = event.dataTransfer?.getData('text/plain');
  if (text) {
    const first = text.split('\n').map((line) => line.trim()).find(Boolean);
    if (first && /^https?:\/\//i.test(first)) return first;
  }

  return null;
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

const ManualClipLab = ({ contentProfile = 'generic', onContentProfileChange }) => {
  const videoRef = useRef(null);
  const youtubePlayerMountRef = useRef(null);
  const youtubePlayerRef = useRef(null);
  const youtubeTimePollRef = useRef(null);
  const transcriptAvailabilityRequestRef = useRef(0);
  const [sourceMode, setSourceMode] = useState('file');
  const [sourceFile, setSourceFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [sourceUrlInput, setSourceUrlInput] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [startTime, setStartTime] = useState('00:00');
  const [endTime, setEndTime] = useState('00:15');
  const [segments, setSegments] = useState([]);
  const [renderedClips, setRenderedClips] = useState([]);
  const [transcriptSegments, setTranscriptSegments] = useState([]);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [transcriptSource, setTranscriptSource] = useState('');
  const [transcriptProviderUsed, setTranscriptProviderUsed] = useState('');
  const [transcriptLanguageUsed, setTranscriptLanguageUsed] = useState('');
  const [transcriptCacheHit, setTranscriptCacheHit] = useState(false);
  const [transcriptAvailability, setTranscriptAvailability] = useState(null);
  const [isCheckingTranscriptAvailability, setIsCheckingTranscriptAvailability] = useState(false);
  const [allowOpenAiFallback, setAllowOpenAiFallback] = useState(true);
  const [youtubePlayerError, setYoutubePlayerError] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [status, setStatus] = useState('');
  const generateTranscript = httpsCallable(functions, 'generateTranscript');
  const checkTranscriptAvailability = httpsCallable(functions, 'checkTranscriptAvailability');
  const renderYouTubeClips = httpsCallable(functions, 'renderYouTubeClips');

  const revokeClipDownloadUrl = (clip) => {
    const value = String(clip?.downloadUrl || '');
    if (value.startsWith('blob:')) {
      URL.revokeObjectURL(value);
    }
  };

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      if (youtubeTimePollRef.current) {
        clearInterval(youtubeTimePollRef.current);
        youtubeTimePollRef.current = null;
      }
      if (youtubePlayerRef.current) {
        youtubePlayerRef.current.destroy();
        youtubePlayerRef.current = null;
      }
      renderedClips.forEach((clip) => {
        revokeClipDownloadUrl(clip);
      });
    };
  }, [videoUrl, renderedClips]);

  const clearProcessingState = () => {
    renderedClips.forEach((clip) => {
      revokeClipDownloadUrl(clip);
    });
    transcriptAvailabilityRequestRef.current += 1;
    setSegments([]);
    setRenderedClips([]);
    setTranscriptSegments([]);
    setTranscriptQuery('');
    setTranscriptSource('');
    setTranscriptProviderUsed('');
    setTranscriptLanguageUsed('');
    setTranscriptCacheHit(false);
    setTranscriptAvailability(null);
    setYoutubePlayerError('');
    setIsCheckingTranscriptAvailability(false);
    setStatus('');
  };

  const checkUrlTranscriptAvailability = async (url) => {
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
  };

  const setFileSource = (file) => {
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    const nextVideoUrl = URL.createObjectURL(file);
    setSourceMode('file');
    setSourceFile(file);
    setVideoUrl(nextVideoUrl);
    setSourceUrl('');
    setSourceUrlInput('');
    setCurrentTime(0);
    setStartTime('00:00');
    setEndTime('00:15');
    setAllowOpenAiFallback(true);
    clearProcessingState();
  };

  const applySourceUrl = (candidateUrl) => {
    const value = String(candidateUrl || '').trim();
    if (!/^https?:\/\//i.test(value)) {
      setStatus('Enter a valid http(s) URL.');
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setSourceMode('url');
    setSourceFile(null);
    setVideoUrl('');
    setSourceUrl(value);
    setSourceUrlInput(value);
    setCurrentTime(0);
    setStartTime('00:00');
    setEndTime('00:15');
    setAllowOpenAiFallback(!looksLikeYouTubeUrl(value));
    clearProcessingState();
    setStatus(looksLikeYouTubeUrl(value)
      ? 'YouTube URL ready. Checking caption availability...'
      : 'URL source ready: non-YouTube link.');
    checkUrlTranscriptAvailability(value);
  };

  const addSegmentFromRange = ({ startTimestamp, endTimestamp, title, description }) => {
    const startSeconds = parseTimestamp(startTimestamp);
    const endSeconds = parseTimestamp(endTimestamp);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      setStatus('Invalid segment range. Use MM:SS and ensure end is after start.');
      return;
    }

    const nextIndex = segments.length + 1;
    setSegments((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${nextIndex}`,
        title: title || `Manual Clip ${nextIndex}`,
        description: description || 'Manual selection',
        viralScore: 80,
        startTimestamp: formatTimestamp(startSeconds),
        endTimestamp: formatTimestamp(endSeconds),
      },
    ]);
    setStatus(`Added segment ${nextIndex}.`);
  };

  const handleSelectFile = (event) => {
    const file = event.target.files?.[0];
    setFileSource(file);
    event.target.value = null;
  };

  const addSegment = () => {
    addSegmentFromRange({
      startTimestamp: startTime,
      endTimestamp: endTime,
      title: `Manual Clip ${segments.length + 1}`,
      description: 'Manual selection',
    });
  };

  const removeSegment = (id) => {
    setSegments((prev) => prev.filter((segment) => segment.id !== id));
  };

  const setFromCurrent = (type) => {
    let seconds = currentTime;
    if (sourceMode === 'url' && looksLikeYouTubeUrl(sourceUrl) && youtubePlayerRef.current?.getCurrentTime) {
      seconds = Number(youtubePlayerRef.current.getCurrentTime() || 0);
    } else if (sourceMode !== 'file') {
      setStatus('Set-from-current is available for local files or embedded YouTube playback.');
      return;
    }

    const value = formatTimestamp(seconds);
    if (type === 'start') {
      setStartTime(value);
    } else {
      setEndTime(value);
    }
  };

  const getActiveSourceReference = () => {
    if (sourceMode === 'file' && sourceFile) {
      return {
        sourceRef: `local-file://${encodeURIComponent(sourceFile.name)}`,
        sourceTitle: sourceFile.name,
      };
    }
    if (sourceMode === 'url' && sourceUrl) {
      return {
        sourceRef: sourceUrl,
        sourceTitle: sourceUrl,
      };
    }
    return null;
  };

  const jumpToTimestamp = (timestamp) => {
    const seconds = parseTimestamp(timestamp);
    if (!Number.isFinite(seconds)) return;

    if (sourceMode === 'file' && videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play().catch(() => {});
      return;
    }

    if (sourceMode === 'url' && looksLikeYouTubeUrl(sourceUrl) && youtubePlayerRef.current) {
      try {
        youtubePlayerRef.current.seekTo(seconds, true);
        youtubePlayerRef.current.playVideo?.();
        setCurrentTime(seconds);
        return;
      } catch {
        // fallback to opening timed URL below
      }
    }

    if (sourceMode === 'url' && sourceUrl) {
      window.open(buildTimedUrl(sourceUrl, seconds), '_blank', 'noopener,noreferrer');
    }
  };

  const handleGenerateTranscript = async () => {
    const activeSource = getActiveSourceReference();
    if (!activeSource) {
      setStatus('Choose a source file or paste/drop a source URL first.');
      return;
    }
    if (sourceMode === 'url' && looksLikeYouTubeUrl(sourceUrl) && isCheckingTranscriptAvailability) {
      setStatus('Still checking YouTube captions. Wait a moment, then try again.');
      return;
    }
    if (
      sourceMode === 'url' &&
      looksLikeYouTubeUrl(sourceUrl) &&
      transcriptAvailability?.status === 'ready' &&
      !transcriptAvailability?.hasCaptions &&
      !allowOpenAiFallback
    ) {
      setStatus('No YouTube captions found. Enable AI fallback to generate a transcript.');
      return;
    }

    setIsTranscribing(true);
    setStatus('Generating transcript index...');

    try {
      const result = await withTimeout(
        generateTranscript({
          videoUrl: activeSource.sourceRef,
          videoTitle: activeSource.sourceTitle,
          contentType: contentProfile,
          allowOpenAiFallback,
        }),
        90000,
        'Timed out generating transcript.'
      );

      const segmentsData = Array.isArray(result.data?.segments) ? result.data.segments : [];
      const sourceTag = result.data?.transcriptSource || 'unknown';
      const providerTag = result.data?.transcriptProviderUsed || '';
      const languageTag = result.data?.transcriptLanguageUsed || '';
      const cacheHit = Boolean(result.data?.cacheHit);
      setTranscriptSegments(segmentsData);
      setTranscriptSource(sourceTag);
      setTranscriptProviderUsed(providerTag);
      setTranscriptLanguageUsed(languageTag);
      setTranscriptCacheHit(cacheHit);
      if (sourceTag === 'youtube_caption') {
        const cacheText = cacheHit ? ' (cache hit)' : '';
        const detail = providerTag ? ` via ${providerTag}${languageTag ? ` (${languageTag})` : ''}` : '';
        setStatus(`Transcript ready: ${segmentsData.length} segments from YouTube captions${detail}${cacheText} (no OpenAI tokens used).`);
      } else {
        setStatus(`Transcript ready: ${segmentsData.length} segments (${sourceTag}).`);
      }
    } catch (error) {
      setStatus(`Transcript failed: ${error.message || 'Unknown error'}`);
    } finally {
      setIsTranscribing(false);
    }
  };

  const renderSegments = async () => {
    if (segments.length === 0) {
      setStatus('Add at least one manual segment.');
      return;
    }
    if (sourceMode === 'url' && !isYouTubeSource) {
      setStatus('URL rendering currently supports YouTube links only.');
      return;
    }
    if (sourceMode === 'file' && !sourceFile) {
      setStatus('Select a local source video first.');
      return;
    }

    setIsRendering(true);
    setStatus(sourceMode === 'url' ? 'Preparing YouTube clip renders...' : 'Preparing renderer...');

    try {
      renderedClips.forEach((clip) => {
        revokeClipDownloadUrl(clip);
      });

      if (sourceMode === 'url') {
        const result = await withTimeout(
          renderYouTubeClips({
            videoUrl: sourceUrl,
            clips: segments,
          }),
          420000,
          'Timed out rendering YouTube clips.'
        );

        const clips = Array.isArray(result.data?.clips) ? result.data.clips : [];
        const failures = Array.isArray(result.data?.failures) ? result.data.failures : [];
        setRenderedClips(clips);

        if (clips.length > 0 && failures.length > 0) {
          setStatus(`Rendered ${clips.length} clips. ${failures.length} clip(s) failed.`);
        } else {
          setStatus(`Rendered ${clips.length} clips.`);
        }
        return;
      }

      const clips = await renderLocalClipFiles({
        sourceFile,
        clips: segments,
        onProgress: ({ current, total }) => setStatus(`Rendering ${current}/${total}...`),
      });

      setRenderedClips(clips);
      setStatus(`Rendered ${clips.length} clips.`);
    } catch (error) {
      setStatus(`Render failed: ${error.message || 'Unknown error'}`);
    } finally {
      setIsRendering(false);
    }
  };

  const filteredTranscriptSegments = transcriptSegments.filter((segment) => {
    const needle = transcriptQuery.trim().toLowerCase();
    if (!needle) return true;
    return `${segment.speaker} ${segment.text}`.toLowerCase().includes(needle);
  });

  const isYouTubeSource = sourceMode === 'url' && looksLikeYouTubeUrl(sourceUrl);
  const youtubeVideoId = isYouTubeSource ? extractYouTubeVideoId(sourceUrl) : '';
  const disableGenerateForCaptionOnlyMode = (
    isYouTubeSource &&
    transcriptAvailability?.status === 'ready' &&
    !transcriptAvailability?.hasCaptions &&
    !allowOpenAiFallback
  );
  const canGenerateTranscript = (
    !isTranscribing &&
    !!(sourceFile || sourceUrl) &&
    !(isYouTubeSource && isCheckingTranscriptAvailability) &&
    !disableGenerateForCaptionOnlyMode
  );

  const generateTranscriptButtonLabel = isTranscribing
    ? 'Generating Transcript...'
    : (
      isYouTubeSource && transcriptAvailability?.hasCaptions
        ? 'Use YouTube Captions'
        : (
          sourceMode === 'url'
            ? 'Generate Transcript (AI)'
            : 'Generate Transcript Index'
        )
    );

  const transcriptAvailabilityClasses = isCheckingTranscriptAvailability
    ? 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100'
    : (
      transcriptAvailability?.hasCaptions
        ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-100'
        : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100'
    );

  const transcriptSourceBadge = transcriptSource === 'youtube_caption'
    ? {
      label: 'Real Captions (YouTube)',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
    }
    : (
      transcriptSource === 'openai_fallback'
        ? {
          label: 'AI Fallback Transcript',
          className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
        }
        : null
    );

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

    if (sourceMode !== 'url' || !isYouTubeSource || !youtubeVideoId || !youtubePlayerMountRef.current) {
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
              youtubeTimePollRef.current = setInterval(() => {
                const seconds = Number(youtubePlayerRef.current?.getCurrentTime?.() || 0);
                if (Number.isFinite(seconds)) setCurrentTime(seconds);
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
  }, [sourceMode, isYouTubeSource, youtubeVideoId]);

  return (
    <section className="glass rounded-3xl p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Manual Clip Lab</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Scrub video, search transcript keywords, and export real MP4 clips.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 bg-primary/10 hover:bg-primary/20 text-primary px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold transition-colors">
          <span className="material-symbols-outlined text-[18px]">upload</span>
          Choose Video
          <input type="file" accept="video/*" className="hidden" onChange={handleSelectFile} />
        </label>
      </div>

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const droppedUrl = extractDroppedUrl(event);
          if (droppedUrl) {
            applySourceUrl(droppedUrl);
          } else {
            setStatus('No valid URL found in dropped content.');
          }
        }}
        className="border border-dashed border-primary/40 rounded-xl p-3 text-sm text-slate-600 dark:text-slate-300 bg-primary/5"
      >
        Drag and drop a YouTube/direct video URL here, or paste below.
      </div>

      <div className="flex flex-col md:flex-row gap-2">
        <input
          type="text"
          value={sourceUrlInput}
          onChange={(event) => setSourceUrlInput(event.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
        />
        <button
          onClick={() => applySourceUrl(sourceUrlInput)}
          className="inline-flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">link</span>
          Use URL Source
        </button>
      </div>

      {(sourceFile || sourceUrl) && (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Source: {sourceMode === 'file' ? `Local file (${sourceFile?.name})` : sourceUrl}
        </div>
      )}

      {sourceMode === 'url' && sourceUrl && (
        <div className={`rounded-xl border px-3 py-3 space-y-2 ${transcriptAvailabilityClasses}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">
              {isYouTubeSource ? 'YouTube Transcript Status' : 'Transcript Provider Status'}
            </div>
            <div className="flex items-center gap-2">
              {isCheckingTranscriptAvailability && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold">
                  <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                  Checking...
                </span>
              )}
              <button
                onClick={() => checkUrlTranscriptAvailability(sourceUrl)}
                disabled={isCheckingTranscriptAvailability}
                className="text-xs font-semibold px-2 py-1 rounded-md bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 disabled:opacity-50 transition-colors"
              >
                Re-check
              </button>
            </div>
          </div>

          <p className="text-sm leading-relaxed">
            {transcriptAvailability?.message || 'Ready to generate transcript.'}
          </p>

          {isYouTubeSource && transcriptAvailability?.hasCaptions && (
            <p className="text-xs font-semibold">
              Captions available. Generation will use YouTube captions first (no OpenAI tokens).
            </p>
          )}

          {isYouTubeSource && transcriptAvailability?.hasCaptions && (
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="px-2 py-1 rounded-full bg-emerald-600/15 text-emerald-700 dark:text-emerald-300">
                Real captions available
              </span>
              {transcriptAvailability?.providerUsed && (
                <span className="px-2 py-1 rounded-full bg-black/10 dark:bg-white/10">
                  Provider: {transcriptAvailability.providerUsed}
                </span>
              )}
              {transcriptAvailability?.languageUsed && (
                <span className="px-2 py-1 rounded-full bg-black/10 dark:bg-white/10">
                  Lang: {transcriptAvailability.languageUsed}
                </span>
              )}
              {transcriptAvailability?.cacheHit && (
                <span className="px-2 py-1 rounded-full bg-black/10 dark:bg-white/10">
                  Cache hit
                </span>
              )}
            </div>
          )}

          {isYouTubeSource && (
            <label className="inline-flex items-center gap-2 text-xs font-semibold">
              <input
                type="checkbox"
                checked={allowOpenAiFallback}
                onChange={(event) => setAllowOpenAiFallback(event.target.checked)}
              />
              Allow AI fallback if YouTube captions are unavailable (uses OpenAI tokens)
            </label>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Profile</label>
          <select
            value={contentProfile}
            onChange={(event) => onContentProfileChange?.(event.target.value)}
            className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
          >
            {CONTENT_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2 flex items-end">
          <button
            onClick={handleGenerateTranscript}
            disabled={!canGenerateTranscript}
            className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 via-primary to-cyan-600 text-white px-4 py-2.5 rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:brightness-110 hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
          >
            <span className="material-symbols-outlined text-[18px]">
              {isTranscribing ? 'hourglass_top' : 'auto_awesome'}
            </span>
            {generateTranscriptButtonLabel}
          </button>
        </div>
      </div>

      {videoUrl && (
        <div className="space-y-3">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            className="w-full rounded-xl bg-black/70"
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
          />
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Current time: <span className="font-semibold">{formatTimestamp(currentTime)}</span>
          </div>
        </div>
      )}

      {sourceMode === 'url' && isYouTubeSource && youtubeVideoId && (
        <div className="space-y-3">
          <div className="aspect-video w-full rounded-xl overflow-hidden bg-black/80">
            <div ref={youtubePlayerMountRef} className="w-full h-full" />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Current time: <span className="font-semibold">{formatTimestamp(currentTime)}</span>
          </div>
          {youtubePlayerError && (
            <div className="text-xs text-amber-700 dark:text-amber-300">
              {youtubePlayerError}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input
          type="text"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
          placeholder="Start (MM:SS)"
          className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={endTime}
          onChange={(event) => setEndTime(event.target.value)}
          placeholder="End (MM:SS)"
          className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
        />
        <button
          onClick={() => setFromCurrent('start')}
          className="bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-3 py-2 rounded-lg text-sm font-semibold"
        >
          Set Start @ Current
        </button>
        <button
          onClick={() => setFromCurrent('end')}
          className="bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-3 py-2 rounded-lg text-sm font-semibold"
        >
          Set End @ Current
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={addSegment}
          className="bg-primary text-white px-3 py-2 rounded-lg text-sm font-semibold"
        >
          Add Manual Segment
        </button>
        <button
          onClick={renderSegments}
          disabled={isRendering}
          className="bg-emerald-600 text-white px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          {isRendering ? 'Rendering...' : (sourceMode === 'url' ? 'Render URL Clips' : 'Render Manual Clips')}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Transcript Search
          </div>
          {transcriptSourceBadge && (
            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${transcriptSourceBadge.className}`}>
              {transcriptSourceBadge.label}
            </span>
          )}
          {transcriptProviderUsed && (
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              Provider: {transcriptProviderUsed}
            </span>
          )}
          {transcriptLanguageUsed && (
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              Lang: {transcriptLanguageUsed}
            </span>
          )}
          {transcriptCacheHit && (
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              Cache hit
            </span>
          )}
        </div>
        <input
          type="text"
          value={transcriptQuery}
          onChange={(event) => setTranscriptQuery(event.target.value)}
          placeholder="Search transcript keywords"
          className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
        />
        {filteredTranscriptSegments.length > 0 && (
          <div className="max-h-56 overflow-y-auto space-y-2">
            {filteredTranscriptSegments.slice(0, 60).map((segment, index) => (
              <div key={`${segment.startTimestamp}-${segment.endTimestamp}-${index}`} className="bg-slate-100 dark:bg-slate-800/50 rounded-lg p-2.5 text-sm space-y-2">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {segment.startTimestamp} - {segment.endTimestamp} • {segment.speaker}
                </div>
                <div className="text-slate-700 dark:text-slate-200">{segment.text}</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => jumpToTimestamp(segment.startTimestamp)}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-slate-300/60 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                  >
                    Jump
                  </button>
                  <button
                    onClick={() => {
                      setStartTime(segment.startTimestamp);
                      setEndTime(segment.endTimestamp);
                    }}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-primary/15 text-primary"
                  >
                    Use Range
                  </button>
                  <button
                    onClick={() => addSegmentFromRange({
                      startTimestamp: segment.startTimestamp,
                      endTimestamp: segment.endTimestamp,
                      title: `Transcript Clip ${segments.length + 1}`,
                      description: segment.text,
                    })}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-emerald-600/20 text-emerald-700 dark:text-emerald-300"
                  >
                    Add Clip From Hit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {segments.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Manual Segments</div>
          {segments.map((segment) => (
            <div key={segment.id} className="flex items-center justify-between bg-slate-100 dark:bg-slate-800/50 rounded-lg px-3 py-2 text-sm">
              <span>{segment.title}: {segment.startTimestamp} - {segment.endTimestamp}</span>
              <button
                onClick={() => removeSegment(segment.id)}
                className="text-rose-500 font-semibold"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {renderedClips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {renderedClips.map((clip, index) => (
            <a
              key={`${clip.fileName}-${index}`}
              href={clip.downloadUrl}
              download={clip.fileName || `manual-clip-${index + 1}.mp4`}
              className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
            >
              Download {clip.fileName || `Clip ${index + 1}`}
            </a>
          ))}
        </div>
      )}

      {status && (
        <div className="text-xs text-slate-600 dark:text-slate-300">{status}</div>
      )}
    </section>
  );
};

export default ManualClipLab;
