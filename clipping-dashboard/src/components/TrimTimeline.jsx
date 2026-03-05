import React, { useCallback, useEffect, useRef } from 'react';

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const TrimTimeline = ({
  onTrackElement = null,
  disabled = false,
  durationSeconds = 0,
  viewportStartSeconds = 0,
  viewportDurationSeconds = 1,
  rangeStartSeconds = 0,
  rangeEndSeconds = 0.1,
  currentSeconds = 0,
  minRangeSeconds = 0.1,
  hasWaveformShape = false,
  waveformFillPath = '',
  waveformTopStrokePoints = '',
  waveformBottomStrokePoints = '',
  onChangeStart,
  onChangeEnd,
  onDragStateChange,
}) => {
  const localTrackRef = useRef(null);
  const latestRef = useRef({
    durationSeconds,
    viewportStartSeconds,
    viewportDurationSeconds,
    rangeStartSeconds,
    rangeEndSeconds,
    minRangeSeconds,
  });
  const dragMoveHandlerRef = useRef(null);
  const dragUpHandlerRef = useRef(null);
  const dragModeRef = useRef(null);

  useEffect(() => {
    latestRef.current = {
      durationSeconds,
      viewportStartSeconds,
      viewportDurationSeconds,
      rangeStartSeconds,
      rangeEndSeconds,
      minRangeSeconds,
    };
  }, [
    durationSeconds,
    viewportStartSeconds,
    viewportDurationSeconds,
    rangeStartSeconds,
    rangeEndSeconds,
    minRangeSeconds,
  ]);

  const setCombinedTrackRef = useCallback((node) => {
    localTrackRef.current = node;
    if (typeof onTrackElement === 'function') onTrackElement(node);
  }, [onTrackElement]);

  const stopDrag = useCallback(() => {
    const onMove = dragMoveHandlerRef.current;
    const onUp = dragUpHandlerRef.current;
    if (onMove) {
      window.removeEventListener('mousemove', onMove);
      dragMoveHandlerRef.current = null;
    }
    if (onUp) {
      window.removeEventListener('mouseup', onUp);
      dragUpHandlerRef.current = null;
    }
    const previousMode = dragModeRef.current;
    if (previousMode && typeof onDragStateChange === 'function') {
      onDragStateChange(false, previousMode);
    }
    dragModeRef.current = null;
  }, [onDragStateChange]);

  useEffect(() => {
    return () => stopDrag();
  }, [stopDrag]);

  const getSecondsFromPointer = useCallback((clientX) => {
    const node = localTrackRef.current;
    if (!node) return null;
    const bounds = node.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const ratio = clampNumber((clientX - bounds.left) / bounds.width, 0, 1);
    return latestRef.current.viewportStartSeconds + (ratio * latestRef.current.viewportDurationSeconds);
  }, []);

  const startEdgeDrag = useCallback((mode, event) => {
    if (disabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stopDrag();

    dragModeRef.current = mode;
    if (typeof onDragStateChange === 'function') {
      onDragStateChange(true, mode);
    }

    const onMove = (moveEvent) => {
      const pointerSeconds = getSecondsFromPointer(moveEvent.clientX);
      if (!Number.isFinite(pointerSeconds)) return;
      const latest = latestRef.current;
      if (mode === 'start') {
        const maxStart = Math.max(0, latest.rangeEndSeconds - latest.minRangeSeconds);
        const nextStart = clampNumber(pointerSeconds, 0, maxStart);
        if (typeof onChangeStart === 'function') onChangeStart(nextStart);
        return;
      }
      const minEnd = Math.min(latest.durationSeconds, latest.rangeStartSeconds + latest.minRangeSeconds);
      const nextEnd = clampNumber(pointerSeconds, minEnd, latest.durationSeconds);
      if (typeof onChangeEnd === 'function') onChangeEnd(nextEnd);
    };

    const onUp = () => stopDrag();
    dragMoveHandlerRef.current = onMove;
    dragUpHandlerRef.current = onUp;

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    onMove(event);
  }, [disabled, getSecondsFromPointer, onChangeEnd, onChangeStart, onDragStateChange, stopDrag]);

  const safeViewportDuration = Math.max(0.001, viewportDurationSeconds);
  const trimStartPercent = clampNumber(((rangeStartSeconds - viewportStartSeconds) / safeViewportDuration) * 100, 0, 100);
  const trimEndPercent = clampNumber(((rangeEndSeconds - viewportStartSeconds) / safeViewportDuration) * 100, 0, 100);
  const clampedCurrentSeconds = clampNumber(currentSeconds, viewportStartSeconds, viewportStartSeconds + safeViewportDuration);
  const currentPercent = clampNumber(((clampedCurrentSeconds - viewportStartSeconds) / safeViewportDuration) * 100, 0, 100);

  return (
    <div
      ref={setCombinedTrackRef}
      data-trim-track
      className={`relative h-20 rounded-lg border border-slate-300/80 dark:border-slate-600/70 bg-white/90 dark:bg-slate-800/80 overflow-hidden select-none ${disabled ? 'opacity-70 pointer-events-none' : ''}`}
    >
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
        aria-valuemax={durationSeconds}
        aria-valuenow={rangeStartSeconds}
        className="absolute inset-y-0 z-30 w-6 -translate-x-1/2 cursor-ew-resize pointer-events-auto"
        style={{ left: `${trimStartPercent}%` }}
        onMouseDown={(event) => startEdgeDrag('start', event)}
        title="Drag In point"
      >
        <div className="mx-auto h-full w-[2px] bg-primary/95 shadow-[0_0_0_1px_rgba(255,255,255,0.18)]" />
      </div>

      <div
        role="slider"
        aria-label="Trim clip end"
        aria-valuemin={0}
        aria-valuemax={durationSeconds}
        aria-valuenow={rangeEndSeconds}
        className="absolute inset-y-0 z-30 w-6 -translate-x-1/2 cursor-ew-resize pointer-events-auto"
        style={{ left: `${trimEndPercent}%` }}
        onMouseDown={(event) => startEdgeDrag('end', event)}
        title="Drag Out point"
      >
        <div className="mx-auto h-full w-[2px] bg-primary/95 shadow-[0_0_0_1px_rgba(255,255,255,0.18)]" />
      </div>

      <div
        className="absolute top-0 bottom-0 z-40 w-[2px] bg-sky-500 pointer-events-none"
        style={{ left: `${currentPercent}%` }}
      />
    </div>
  );
};

export default TrimTimeline;
