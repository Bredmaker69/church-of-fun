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

const ManualClipLab = ({ contentProfile = 'generic', onContentProfileChange }) => {
  const videoRef = useRef(null);
  const [sourceFile, setSourceFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [startTime, setStartTime] = useState('00:00');
  const [endTime, setEndTime] = useState('00:15');
  const [segments, setSegments] = useState([]);
  const [renderedClips, setRenderedClips] = useState([]);
  const [transcriptSegments, setTranscriptSegments] = useState([]);
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [status, setStatus] = useState('');
  const generateTranscript = httpsCallable(functions, 'generateTranscript');

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
      renderedClips.forEach((clip) => {
        if (clip.downloadUrl) URL.revokeObjectURL(clip.downloadUrl);
      });
    };
  }, [videoUrl, renderedClips]);

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
    if (!file) return;

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    renderedClips.forEach((clip) => {
      if (clip.downloadUrl) URL.revokeObjectURL(clip.downloadUrl);
    });

    const nextVideoUrl = URL.createObjectURL(file);
    setSourceFile(file);
    setVideoUrl(nextVideoUrl);
    setCurrentTime(0);
    setStartTime('00:00');
    setEndTime('00:15');
    setSegments([]);
    setRenderedClips([]);
    setTranscriptSegments([]);
    setTranscriptQuery('');
    setStatus('');
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
    const value = formatTimestamp(currentTime);
    if (type === 'start') {
      setStartTime(value);
    } else {
      setEndTime(value);
    }
  };

  const jumpToTimestamp = (timestamp) => {
    const seconds = parseTimestamp(timestamp);
    if (!Number.isFinite(seconds) || !videoRef.current) return;
    videoRef.current.currentTime = seconds;
    videoRef.current.play().catch(() => {});
  };

  const handleGenerateTranscript = async () => {
    if (!sourceFile) {
      setStatus('Choose a source video first.');
      return;
    }

    setIsTranscribing(true);
    setStatus('Generating transcript index...');

    try {
      const localVideoReference = `local-file://${encodeURIComponent(sourceFile.name)}`;
      const result = await withTimeout(
        generateTranscript({
          videoUrl: localVideoReference,
          videoTitle: sourceFile.name,
          contentType: contentProfile,
        }),
        45000,
        'Timed out generating transcript.'
      );

      const segmentsData = Array.isArray(result.data?.segments) ? result.data.segments : [];
      setTranscriptSegments(segmentsData);
      setStatus(`Transcript ready: ${segmentsData.length} segments.`);
    } catch (error) {
      setStatus(`Transcript failed: ${error.message || 'Unknown error'}`);
    } finally {
      setIsTranscribing(false);
    }
  };

  const renderSegments = async () => {
    if (!sourceFile) {
      setStatus('Select a source video first.');
      return;
    }
    if (segments.length === 0) {
      setStatus('Add at least one manual segment.');
      return;
    }

    setIsRendering(true);
    setStatus('Preparing renderer...');

    try {
      renderedClips.forEach((clip) => {
        if (clip.downloadUrl) URL.revokeObjectURL(clip.downloadUrl);
      });

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
            disabled={isTranscribing || !sourceFile}
            className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {isTranscribing ? 'Generating Transcript...' : 'Generate Transcript Index'}
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
          {isRendering ? 'Rendering...' : 'Render Manual Clips'}
        </button>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Transcript Search</div>
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
