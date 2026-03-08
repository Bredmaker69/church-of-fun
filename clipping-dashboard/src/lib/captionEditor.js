export const normalizeCaptionEditorText = (value) => {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\[\s*_{2,}\s*\]/g, ' ')
    .replace(/[[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const normalizeCaptionEditorCues = (value, { fractionDigits = 3, maxCues = 800 } = {}) => {
  if (!Array.isArray(value)) return [];
  const safeDigits = Math.max(0, Math.min(3, Math.floor(Number(fractionDigits) || 0)));
  return value
    .map((cue, index) => {
      const text = normalizeCaptionEditorText(cue?.text || '');
      const startSeconds = Number(cue?.startSeconds);
      const endSeconds = Number(cue?.endSeconds);
      if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }

      const roundedStart = Number(startSeconds.toFixed(safeDigits));
      const roundedEnd = Number(endSeconds.toFixed(safeDigits));
      if (!(roundedEnd > roundedStart)) return null;

      return {
        id: String(cue?.id || `cue-${index + 1}`),
        text,
        startSeconds: roundedStart,
        endSeconds: roundedEnd,
        words: Array.isArray(cue?.words)
          ? cue.words
            .map((word, wordIndex) => {
              const wordText = normalizeCaptionEditorText(word?.text || '');
              const wordStart = Number(word?.startSeconds);
              const wordEnd = Number(word?.endSeconds);
              if (!wordText || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart) {
                return null;
              }
              return {
                id: String(word?.id || `${cue?.id || `cue-${index + 1}`}-word-${wordIndex + 1}`),
                text: wordText,
                startSeconds: Number(wordStart.toFixed(safeDigits)),
                endSeconds: Number(wordEnd.toFixed(safeDigits)),
              };
            })
            .filter(Boolean)
          : [],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .slice(0, Math.max(1, Math.floor(Number(maxCues) || 800)));
};

export const tokenizeCaptionEditorWords = (value) => {
  return normalizeCaptionEditorText(value)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
};

export const buildReflowedCaptionCues = ({
  sourceCues,
  editedText,
  rangeStartSeconds = null,
  rangeEndSeconds = null,
  idPrefix = 'edited',
}) => {
  const normalizedSourceCues = normalizeCaptionEditorCues(sourceCues);
  const editedWords = tokenizeCaptionEditorWords(editedText);
  if (editedWords.length === 0) return [];

  const minCueDurationSeconds = 0.02;

  if (normalizedSourceCues.length === 0) {
    const startSeconds = Number(rangeStartSeconds);
    const endSeconds = Number(rangeEndSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return [];
    }

    const totalDuration = Math.max(minCueDurationSeconds * editedWords.length, endSeconds - startSeconds);
    const slotDuration = totalDuration / editedWords.length;
    return editedWords.map((word, index) => {
      const cueStart = startSeconds + slotDuration * index;
      const cueEnd = index === editedWords.length - 1
        ? startSeconds + totalDuration
        : startSeconds + slotDuration * (index + 1);
      return {
        id: `${idPrefix}-${index + 1}`,
        text: word,
        startSeconds: Number(cueStart.toFixed(3)),
        endSeconds: Number(Math.max(cueStart + minCueDurationSeconds, cueEnd).toFixed(3)),
      };
    });
  }

  const sourceSlots = normalizedSourceCues.map((cue) => ({
    startSeconds: cue.startSeconds,
    endSeconds: cue.endSeconds,
    durationSeconds: Math.max(minCueDurationSeconds, cue.endSeconds - cue.startSeconds),
  }));
  const totalSpeechDuration = sourceSlots.reduce((sum, cue) => sum + cue.durationSeconds, 0);
  if (!(totalSpeechDuration > 0)) return [];

  const mapSpeechOffsetToTime = (offsetSeconds) => {
    const boundedOffset = Math.max(0, Math.min(totalSpeechDuration, Number(offsetSeconds) || 0));
    let elapsed = 0;
    for (let index = 0; index < sourceSlots.length; index += 1) {
      const cue = sourceSlots[index];
      const nextElapsed = elapsed + cue.durationSeconds;
      if (boundedOffset <= nextElapsed || index === sourceSlots.length - 1) {
        const localOffset = Math.max(0, Math.min(cue.durationSeconds, boundedOffset - elapsed));
        return cue.startSeconds + localOffset;
      }
      elapsed = nextElapsed;
    }
    return sourceSlots[sourceSlots.length - 1].endSeconds;
  };

  return editedWords.map((word, index) => {
    const cueStart = mapSpeechOffsetToTime((index / editedWords.length) * totalSpeechDuration);
    const cueEnd = mapSpeechOffsetToTime(((index + 1) / editedWords.length) * totalSpeechDuration);
    return {
      id: `${idPrefix}-${index + 1}`,
      text: word,
      startSeconds: Number(cueStart.toFixed(3)),
      endSeconds: Number(Math.max(cueStart + minCueDurationSeconds, cueEnd).toFixed(3)),
    };
  });
};

export const createDefaultPhraseSpans = (wordCues, maxWordsPerPhrase = 5) => {
  const normalizedWordCues = normalizeCaptionEditorCues(wordCues);
  const safeWindow = Math.max(1, Math.floor(Number(maxWordsPerPhrase) || 5));
  const spans = [];
  for (let startIndex = 0; startIndex < normalizedWordCues.length; startIndex += safeWindow) {
    const endIndex = Math.min(normalizedWordCues.length - 1, startIndex + safeWindow - 1);
    spans.push({
      id: `phrase-${startIndex + 1}-${endIndex + 1}`,
      startIndex,
      endIndex,
    });
  }
  return spans;
};

export const normalizePhraseSpans = (spans, wordCount) => {
  const safeWordCount = Math.max(0, Math.floor(Number(wordCount) || 0));
  if (safeWordCount === 0) return [];

  const normalized = (Array.isArray(spans) ? spans : [])
    .map((span, index) => {
      const startIndex = Math.max(0, Math.min(safeWordCount - 1, Math.floor(Number(span?.startIndex) || 0)));
      const endIndex = Math.max(startIndex, Math.min(safeWordCount - 1, Math.floor(Number(span?.endIndex) || startIndex)));
      return {
        id: String(span?.id || `phrase-${index + 1}`),
        startIndex,
        endIndex,
      };
    })
    .sort((left, right) => left.startIndex - right.startIndex);

  if (normalized.length === 0) {
    return createDefaultPhraseSpans(new Array(safeWordCount).fill({ text: 'x', startSeconds: 0, endSeconds: 0.1 }), 5)
      .map((span) => ({ ...span, id: span.id }));
  }

  const compacted = [];
  let cursor = 0;
  normalized.forEach((span, index) => {
    if (cursor > safeWordCount - 1) return;
    const startIndex = Math.max(cursor, span.startIndex);
    const endIndex = Math.max(startIndex, Math.min(safeWordCount - 1, span.endIndex));
    compacted.push({
      id: String(span.id || `phrase-${index + 1}`),
      startIndex,
      endIndex,
    });
    cursor = endIndex + 1;
  });
  if (cursor <= safeWordCount - 1) {
    compacted.push({
      id: `phrase-tail-${cursor + 1}-${safeWordCount}`,
      startIndex: cursor,
      endIndex: safeWordCount - 1,
    });
  }
  return compacted;
};

export const buildPhraseCuesFromWordCues = (wordCues, phraseSpans) => {
  const normalizedWordCues = normalizeCaptionEditorCues(wordCues);
  const normalizedSpans = normalizePhraseSpans(phraseSpans, normalizedWordCues.length);
  return normalizedSpans.map((span, index) => {
    const words = normalizedWordCues.slice(span.startIndex, span.endIndex + 1);
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    if (!firstWord || !lastWord) return null;
    return {
      id: String(span.id || `phrase-${index + 1}`),
      text: words.map((word) => word.text).join(' ').trim(),
      startSeconds: firstWord.startSeconds,
      endSeconds: lastWord.endSeconds,
      words,
      startIndex: span.startIndex,
      endIndex: span.endIndex,
    };
  }).filter(Boolean);
};
