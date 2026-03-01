import React, { useEffect, useRef, useState } from 'react';
import { renderLocalClipFiles } from '../lib/localClipper';

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

const ManualClipLab = () => {
  const videoRef = useRef(null);
  const [sourceFile, setSourceFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [startTime, setStartTime] = useState('00:00');
  const [endTime, setEndTime] = useState('00:15');
  const [segments, setSegments] = useState([]);
  const [renderedClips, setRenderedClips] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [status, setStatus] = useState('');

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
    setStatus('');
    event.target.value = null;
  };

  const addSegment = () => {
    const startSeconds = parseTimestamp(startTime);
    const endSeconds = parseTimestamp(endTime);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      setStatus('Invalid segment range. Use MM:SS and ensure end is after start.');
      return;
    }

    const nextIndex = segments.length + 1;
    setSegments((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${nextIndex}`,
        title: `Manual Clip ${nextIndex}`,
        description: 'Manual selection',
        viralScore: 80,
        startTimestamp: formatTimestamp(startSeconds),
        endTimestamp: formatTimestamp(endSeconds),
      },
    ]);
    setStatus(`Added segment ${nextIndex}.`);
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

  const filteredRenderedClips = renderedClips.filter((clip) => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return true;
    return `${clip.title} ${clip.description}`.toLowerCase().includes(needle);
  });

  return (
    <section className="glass rounded-3xl p-5 lg:p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Manual Clip Lab</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Scrub video, define exact ranges, and export real MP4 clips.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 bg-primary/10 hover:bg-primary/20 text-primary px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold transition-colors">
          <span className="material-symbols-outlined text-[18px]">upload</span>
          Choose Video
          <input type="file" accept="video/*" className="hidden" onChange={handleSelectFile} />
        </label>
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

      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Search (Keyword)</div>
        <input
          type="text"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="Search rendered clips (titles/descriptions)"
          className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
        />
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Transcript keyword search is planned next. This currently searches rendered clip metadata.
        </div>
      </div>

      {filteredRenderedClips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {filteredRenderedClips.map((clip, index) => (
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
