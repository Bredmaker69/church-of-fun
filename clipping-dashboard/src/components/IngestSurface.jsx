import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';

const parseHttpUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const extractDroppedUrl = (event) => {
  const uriList = event.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    const firstUrl = uriList
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));

    const parsed = parseHttpUrl(firstUrl);
    if (parsed) return parsed;
  }

  const text = event.dataTransfer?.getData('text/plain');
  if (text) {
    const firstCandidate = text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);

    const parsed = parseHttpUrl(firstCandidate);
    if (parsed) return parsed;
  }

  return null;
};

const IngestSurface = forwardRef(({
  activeSource,
  onIngestFile,
  onIngestUrl,
  onDropPayload,
  compact = false,
  className = '',
  sourceUrlInputId = 'source-url-input',
}, ref) => {
  const rootRef = useRef(null);
  const fileInputRef = useRef(null);
  const urlInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState('');
  const [statusMessage, setStatusMessage] = useState('Drop a file or URL, click to upload, or paste a link below.');

  const focusIngest = () => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    urlInputRef.current?.focus();
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  useImperativeHandle(ref, () => ({
    focusIngest,
    openFilePicker,
    activateUpload: () => {
      focusIngest();
      openFilePicker();
    }
  }), []);

  const handleFile = (file) => {
    if (!file) return;
    if (!String(file.type || '').startsWith('video/')) {
      setStatusMessage('Only video files are supported here.');
      return;
    }

    setStatusMessage(`Loading local file: ${file.name}`);
    onIngestFile?.(file);
  };

  const handleUrlSubmit = () => {
    const parsedUrl = parseHttpUrl(urlInputValue);
    if (!parsedUrl) {
      setStatusMessage('Enter a valid http(s) video URL.');
      return;
    }

    setStatusMessage(`Loading URL source: ${parsedUrl}`);
    setUrlInputValue(parsedUrl);
    onIngestUrl?.(parsedUrl);
  };

  const activeSourceLabel = activeSource
    ? activeSource.kind === 'file'
      ? `Active source: Local file - ${activeSource.label}`
      : `Active source: URL - ${activeSource.label}`
    : null;

  const wrapperClasses = compact
    ? 'glass rounded-2xl p-4 space-y-3'
    : 'glass rounded-3xl p-5 lg:p-6 space-y-4';

  return (
    <section ref={rootRef} className={`${wrapperClasses} ${className}`}>
      <div>
        <h3 className={`${compact ? 'text-base' : 'text-lg'} font-bold text-slate-900 dark:text-white`}>
          Clip Studio Ingest
        </h3>
        {!compact && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            One place to upload, drag/drop, or paste a source URL.
          </p>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          handleFile(file);
          event.target.value = '';
        }}
      />

      <div
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (event.target.closest('input,button,label,a,textarea,select')) return;
          openFilePicker();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openFilePicker();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);

          const droppedFile = event.dataTransfer?.files?.[0];
          if (droppedFile) {
            if (!String(droppedFile.type || '').startsWith('video/')) {
              setStatusMessage('Only video files are supported here.');
              return;
            }
            if (onDropPayload) {
              onDropPayload({ kind: 'file', file: droppedFile });
              setStatusMessage(`Loading local file: ${droppedFile.name}`);
            } else {
              handleFile(droppedFile);
            }
            return;
          }

          const droppedUrl = extractDroppedUrl(event);
          if (droppedUrl) {
            if (onDropPayload) {
              onDropPayload({ kind: 'url', url: droppedUrl });
            } else {
              onIngestUrl?.(droppedUrl);
            }
            setStatusMessage(`Loading URL source: ${droppedUrl}`);
            return;
          }

          setStatusMessage('Drop a video file or a valid URL.');
        }}
        className={`rounded-2xl border-2 border-dashed ${compact ? 'p-4' : 'p-5 lg:p-7'} transition-colors ${dragActive
          ? 'border-primary bg-primary/10'
          : 'border-primary/40 bg-primary/5 hover:bg-primary/10'
          }`}
      >
        <div className="flex items-center gap-3 text-slate-700 dark:text-slate-200">
          <span className={`material-symbols-outlined ${compact ? 'text-[24px]' : 'text-[28px]'}`}>add_circle</span>
          <div>
            <div className="font-semibold">{compact ? 'Upload or Drop Source' : 'Click to upload a video'}</div>
            <div className={`${compact ? 'text-xs' : 'text-sm'} text-slate-500 dark:text-slate-400`}>
              {compact ? 'file or URL' : 'or drag/drop a file or URL here'}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor={sourceUrlInputId} className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Source URL
        </label>
        <div className={`flex gap-2 ${compact ? 'flex-col' : 'flex-col md:flex-row'}`}>
          <input
            id={sourceUrlInputId}
            name="sourceUrl"
            ref={urlInputRef}
            type="text"
            value={urlInputValue}
            onChange={(event) => setUrlInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleUrlSubmit();
              }
            }}
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={handleUrlSubmit}
            className="inline-flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">link</span>
            Use URL
          </button>
        </div>
      </div>

      <div className="text-sm text-slate-600 dark:text-slate-300">
        {activeSourceLabel || statusMessage}
      </div>
    </section>
  );
});

IngestSurface.displayName = 'IngestSurface';

export default IngestSurface;
