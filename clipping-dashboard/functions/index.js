const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { YoutubeTranscript } = require("youtube-transcript");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const execFileAsync = promisify(execFile);

const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const TARGET_CLIP_COUNT = Number(process.env.CLIP_TARGET_COUNT || 3);
const MIN_CLIP_SECONDS = Number(process.env.CLIP_MIN_SECONDS || 8);
const MAX_CLIP_SECONDS = Number(process.env.CLIP_MAX_SECONDS || 45);
const DEFAULT_CLIP_SECONDS = Number(process.env.CLIP_DEFAULT_SECONDS || 20);
const MIN_CLIP_GAP_SECONDS = Number(process.env.CLIP_MIN_GAP_SECONDS || 1);
const TRANSCRIPT_MIN_SEGMENT_SECONDS = Number(process.env.TRANSCRIPT_MIN_SEGMENT_SECONDS || 2);
const TRANSCRIPT_MAX_SEGMENT_SECONDS = Number(process.env.TRANSCRIPT_MAX_SEGMENT_SECONDS || 25);
const TRANSCRIPT_MAX_SEGMENTS = Number(process.env.TRANSCRIPT_MAX_SEGMENTS || 120);
const TRANSCRIPT_MAX_SEGMENTS_YOUTUBE = Number(process.env.TRANSCRIPT_MAX_SEGMENTS_YOUTUBE || 6000);
const TRANSCRIPT_MAX_SEGMENTS_OPENAI = Number(process.env.TRANSCRIPT_MAX_SEGMENTS_OPENAI || TRANSCRIPT_MAX_SEGMENTS);
const TRANSCRIPT_CACHE_TTL_SECONDS = Number(process.env.TRANSCRIPT_CACHE_TTL_SECONDS || 3600);
const TRANSCRIPT_CACHE_MAX_ENTRIES = Number(process.env.TRANSCRIPT_CACHE_MAX_ENTRIES || 200);
const RENDERED_CLIP_TTL_SECONDS = Number(process.env.RENDERED_CLIP_TTL_SECONDS || 1800);
const MAX_RENDER_CLIPS_PER_REQUEST = Number(process.env.MAX_RENDER_CLIPS_PER_REQUEST || 8);
const MAX_RENDER_SECONDS_PER_CLIP = Number(process.env.MAX_RENDER_SECONDS_PER_CLIP || 120);
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const OPENAI_TRANSCRIBE_TIMEOUT_MS = Number(process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS || 90000);
const STABLE_TS_LOCAL_ENABLED = String(process.env.STABLE_TS_LOCAL_ENABLED || "true").toLowerCase() === "true";
const STABLE_TS_PYTHON_BIN = String(process.env.STABLE_TS_PYTHON_BIN || "python3").trim() || "python3";
const STABLE_TS_MODEL = String(process.env.STABLE_TS_MODEL || "large-v3-turbo").trim() || "large-v3-turbo";
const STABLE_TS_TIMEOUT_MS = Number(process.env.STABLE_TS_TIMEOUT_MS || 420000);
const STABLE_TS_DEVICE = String(process.env.STABLE_TS_DEVICE || "").trim();
const STABLE_TS_COMPUTE_TYPE = String(process.env.STABLE_TS_COMPUTE_TYPE || "").trim();
const STABLE_TS_FORCE_ARM64 = String(process.env.STABLE_TS_FORCE_ARM64 || "true").toLowerCase() === "true";
const STABLE_TS_DISABLE_OPENAI_FALLBACK = String(process.env.STABLE_TS_DISABLE_OPENAI_FALLBACK || "true").toLowerCase() === "true";
const STABLE_TS_ALIGN_SCRIPT = String(
    process.env.STABLE_TS_ALIGN_SCRIPT || path.join(__dirname, "scripts", "stable_ts_align.py")
).trim();
const PRECISION_ALIGN_BUFFER_SECONDS = Number(process.env.PRECISION_ALIGN_BUFFER_SECONDS || 12);
const PRECISION_ALIGN_MAX_WINDOW_SECONDS = Number(process.env.PRECISION_ALIGN_MAX_WINDOW_SECONDS || 120);
const PRECISION_ALIGN_MIN_SELECTION_SECONDS = Number(process.env.PRECISION_ALIGN_MIN_SELECTION_SECONDS || 1);
const PRECISION_ALIGN_MAX_PROMPT_CHARS = Number(process.env.PRECISION_ALIGN_MAX_PROMPT_CHARS || 1000);
const PRECISION_ALIGN_RENDER_TIMEOUT_MS = Number(process.env.PRECISION_ALIGN_RENDER_TIMEOUT_MS || 180000);
const MAX_TIMELINE_RENDER_ITEMS = Number(process.env.MAX_TIMELINE_RENDER_ITEMS || 100);
const EDIT_RENDER_TARGET_WIDTH = Number(process.env.EDIT_RENDER_TARGET_WIDTH || 1280);
const EDIT_RENDER_TARGET_HEIGHT = Number(process.env.EDIT_RENDER_TARGET_HEIGHT || 720);
const MAX_CAPTION_CUES_PER_ITEM = Number(process.env.MAX_CAPTION_CUES_PER_ITEM || 320);
const ALIGNMENT_PROVIDER_OPENAI = "openai_fast";
const ALIGNMENT_PROVIDER_STABLE_TS_LOCAL = "stable_ts_local";
const ALIGNMENT_PROVIDER_AB_COMPARE = "ab_compare";
const ALIGNMENT_PROVIDER_DEFAULT = String(
    process.env.ALIGNMENT_PROVIDER_DEFAULT || ALIGNMENT_PROVIDER_STABLE_TS_LOCAL
).trim().toLowerCase();

const CONTENT_PROFILE_INSTRUCTIONS = {
    generic: "Prioritize engaging moments with clear hooks, emotional spikes, and concise standalone context.",
    sports: "Prioritize key plays, scoring moments, momentum swings, announcer hype, and crowd reaction energy.",
    gaming: "Prioritize clutch plays, wins/losses, surprising moments, strong reactions, and high-energy commentary.",
    podcast: "Prioritize quotable insights, controversial takes, emotional stories, and concise standalone ideas.",
};

// Local in-memory cache for repeated YouTube transcript checks in emulator/runtime process.
const youtubeTranscriptCache = new Map();
const renderedClipStore = new Map();
const renderedClipStorageDir = path.join(os.tmpdir(), "church-of-fun-rendered-clips");

let hostSupportsArm64 = false;
if (process.platform === "darwin") {
    try {
        const sysctlValue = String(execFileSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }) || "").trim();
        hostSupportsArm64 = sysctlValue === "1";
    } catch {
        hostSupportsArm64 = false;
    }
}
const STABLE_TS_USE_ARCH_ARM64 =
    STABLE_TS_FORCE_ARM64 &&
    process.platform === "darwin" &&
    hostSupportsArm64;

function normalizeContentType(value) {
    const text = String(value || "generic").toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(CONTENT_PROFILE_INSTRUCTIONS, text) ? text : "generic";
}

function parseTimestampToSeconds(value) {
    const text = String(value || "").trim();
    const parts = text.split(":").map(Number);
    if (parts.length < 2 || parts.length > 3) return null;
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;

    if (parts.length === 2) {
        const [minutes, seconds] = parts;
        return minutes * 60 + seconds;
    }

    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
}

function formatSecondsToTimestamp(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function parseModelJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        const match = String(text).match(/\{[\s\S]*\}/);
        if (!match) {
            throw new Error("Model response was not valid JSON.");
        }
        return JSON.parse(match[0]);
    }
}

function parseLastJsonObjectFromText(text) {
    const source = String(text || "").trim();
    if (!source) return null;

    const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index]);
            if (parsed && typeof parsed === "object") {
                return parsed;
            }
        } catch {
            // Continue searching for JSON payload lines.
        }
    }

    return null;
}

function summarizeStableTsStderr(text) {
    const source = String(text || "");
    if (!source) return "";

    const normalizedLines = source
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    const filtered = normalizedLines.filter((line) => {
        if (/^Transcribe:\s*/i.test(line)) return false;
        if (/^\d+%\|/.test(line)) return false;
        if (/FP16 is not supported on CPU/i.test(line)) return false;
        if (/Cannot clamp due to missing\/no word-timestamps/i.test(line)) return false;
        return true;
    });

    const chosen = filtered.length > 0 ? filtered : normalizedLines;
    return chosen.slice(-8).join(" | ").slice(0, 1200);
}

async function requestStructuredJson({ apiKey, systemPrompt, userPrompt, temperature = 0.3 }) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            temperature,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI request failed (${response.status}): ${errorText.slice(0, 500)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("OpenAI response did not include a message content payload.");
    }

    return parseModelJson(content);
}

function normalizeClip(clip, index) {
    const viralScore = Number(clip.viralScore);
    const startSeconds = parseTimestampToSeconds(clip.startTimestamp);
    const endSeconds = parseTimestampToSeconds(clip.endTimestamp);

    const baseStart = Number.isFinite(startSeconds) ? startSeconds : index * DEFAULT_CLIP_SECONDS;
    const rawEnd = Number.isFinite(endSeconds) ? endSeconds : baseStart + DEFAULT_CLIP_SECONDS;
    const minEnd = baseStart + MIN_CLIP_SECONDS;
    const maxEnd = baseStart + MAX_CLIP_SECONDS;
    const boundedEnd = Math.min(Math.max(rawEnd, minEnd), maxEnd);

    return {
        title: String(clip.title || "").trim() || `Clip ${index + 1}`,
        description: String(clip.description || "").trim() || "Generated highlight segment",
        viralScore: Number.isFinite(viralScore) ? Math.max(1, Math.min(100, viralScore)) : 50,
        startSeconds: baseStart,
        endSeconds: boundedEnd,
    };
}

function validateClip(clip) {
    return (
        clip.title.length > 0 &&
        clip.description.length > 0 &&
        Number.isFinite(clip.startSeconds) &&
        Number.isFinite(clip.endSeconds) &&
        clip.endSeconds > clip.startSeconds &&
        Number.isFinite(clip.viralScore)
    );
}

function applyClipRules(rawClips) {
    const normalized = rawClips
        .map((clip, index) => normalizeClip(clip, index))
        .filter(validateClip)
        .sort((a, b) => {
            if (a.startSeconds !== b.startSeconds) return a.startSeconds - b.startSeconds;
            return b.viralScore - a.viralScore;
        });

    const shaped = [];
    let previousEnd = -Infinity;

    for (const clip of normalized) {
        const start = Math.max(clip.startSeconds, previousEnd + MIN_CLIP_GAP_SECONDS);
        let end = Math.max(clip.endSeconds, start + MIN_CLIP_SECONDS);
        if (end - start > MAX_CLIP_SECONDS) {
            end = start + MAX_CLIP_SECONDS;
        }

        shaped.push({
            title: clip.title,
            startTimestamp: formatSecondsToTimestamp(start),
            endTimestamp: formatSecondsToTimestamp(end),
            description: clip.description,
            viralScore: clip.viralScore,
        });
        previousEnd = end;

        if (shaped.length >= TARGET_CLIP_COUNT) break;
    }

    return shaped;
}

function normalizeTranscriptSegment(segment, index) {
    const startSeconds = parseTimestampToSeconds(segment.startTimestamp);
    const endSeconds = parseTimestampToSeconds(segment.endTimestamp);
    const baseStart = Number.isFinite(startSeconds) ? startSeconds : index * 12;
    const rawEnd = Number.isFinite(endSeconds) ? endSeconds : baseStart + 8;
    const minEnd = baseStart + TRANSCRIPT_MIN_SEGMENT_SECONDS;
    const maxEnd = baseStart + TRANSCRIPT_MAX_SEGMENT_SECONDS;

    return {
        startSeconds: baseStart,
        endSeconds: Math.min(Math.max(rawEnd, minEnd), maxEnd),
        text: String(segment.text || segment.content || "").trim(),
        speaker: String(segment.speaker || "").trim() || "Speaker",
    };
}

function applyTranscriptRules(rawSegments, maxSegments = TRANSCRIPT_MAX_SEGMENTS) {
    const normalizedMaxSegments = Number.isFinite(Number(maxSegments)) && Number(maxSegments) > 0
        ? Math.floor(Number(maxSegments))
        : TRANSCRIPT_MAX_SEGMENTS;

    const normalized = rawSegments
        .map((segment, index) => normalizeTranscriptSegment(segment, index))
        .filter((segment) =>
            segment.text.length > 0 &&
            Number.isFinite(segment.startSeconds) &&
            Number.isFinite(segment.endSeconds) &&
            segment.endSeconds > segment.startSeconds
        )
        .sort((a, b) => a.startSeconds - b.startSeconds);

    const shaped = [];
    let previousEnd = -Infinity;

    for (const segment of normalized) {
        const start = Math.max(segment.startSeconds, previousEnd);
        let end = Math.max(segment.endSeconds, start + TRANSCRIPT_MIN_SEGMENT_SECONDS);
        if (end - start > TRANSCRIPT_MAX_SEGMENT_SECONDS) {
            end = start + TRANSCRIPT_MAX_SEGMENT_SECONDS;
        }

        shaped.push({
            startTimestamp: formatSecondsToTimestamp(start),
            endTimestamp: formatSecondsToTimestamp(end),
            speaker: segment.speaker,
            text: segment.text,
        });
        previousEnd = end;

        if (shaped.length >= normalizedMaxSegments) break;
    }

    return shaped;
}

function normalizeMatchText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/&nbsp;/gi, " ")
        .replace(/[^a-z0-9' ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizeForMatch(value) {
    return normalizeMatchText(value).split(" ").filter(Boolean);
}

function normalizeAlignmentProvider(value) {
    const text = String(value || ALIGNMENT_PROVIDER_DEFAULT).trim().toLowerCase();
    if (
        text === ALIGNMENT_PROVIDER_AB_COMPARE ||
        text === "ab" ||
        text === "a/b" ||
        text === "compare"
    ) {
        return ALIGNMENT_PROVIDER_AB_COMPARE;
    }
    if (
        text === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL ||
        text === "stable-local" ||
        text === "stable_ts" ||
        text === "stable-ts"
    ) {
        return ALIGNMENT_PROVIDER_STABLE_TS_LOCAL;
    }
    return ALIGNMENT_PROVIDER_OPENAI;
}

function normalizeTokenForSimilarity(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9']/g, "")
        .replace(/'+/g, "'")
        .trim();
}

function levenshteinDistance(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    if (!left) return right.length;
    if (!right) return left.length;

    const previous = new Array(right.length + 1);
    const current = new Array(right.length + 1);

    for (let index = 0; index <= right.length; index += 1) {
        previous[index] = index;
    }

    for (let i = 1; i <= left.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= right.length; j += 1) {
            const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1, // deletion
                current[j - 1] + 1, // insertion
                previous[j - 1] + substitutionCost // substitution
            );
        }
        for (let j = 0; j <= right.length; j += 1) {
            previous[j] = current[j];
        }
    }

    return previous[right.length];
}

function scoreTokenSimilarity(a, b) {
    const left = normalizeTokenForSimilarity(a);
    const right = normalizeTokenForSimilarity(b);
    if (!left || !right) return 0;
    if (left === right) return 1;

    const leftCompact = left.replace(/'/g, "");
    const rightCompact = right.replace(/'/g, "");
    if (leftCompact && rightCompact && leftCompact === rightCompact) return 0.96;
    if (left.startsWith(right) || right.startsWith(left)) return 0.82;
    if (left.includes(right) || right.includes(left)) return 0.72;

    const maxLength = Math.max(left.length, right.length);
    if (maxLength <= 1) return 0;

    const distance = levenshteinDistance(left, right);
    const ratio = 1 - distance / maxLength;
    if (ratio >= 0.92) return 0.92;
    if (ratio >= 0.82) return 0.84;
    if (ratio >= 0.72) return 0.74;
    if (ratio >= 0.62) return 0.62;
    return 0;
}

function extractTranscriptionWordTimeline(payload) {
    const timeline = [];

    const parseSeconds = (value, scale = 1) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return Number.NaN;
        return numeric * scale;
    };

    const pushWord = (wordText, startSeconds, endSeconds) => {
        const rawTokens = tokenizeForMatch(wordText);
        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return;
        if (rawTokens.length === 0) return;

        const slotDuration = Math.max(0.02, (endSeconds - startSeconds) / rawTokens.length);
        for (let index = 0; index < rawTokens.length; index += 1) {
            const tokenStart = startSeconds + slotDuration * index;
            const tokenEnd = index === rawTokens.length - 1
                ? endSeconds
                : startSeconds + slotDuration * (index + 1);
            timeline.push({
                token: rawTokens[index],
                startSeconds: tokenStart,
                endSeconds: Math.max(tokenStart + 0.02, tokenEnd),
            });
        }
    };

    if (Array.isArray(payload?.words)) {
        for (const entry of payload.words) {
            const startSeconds = Number.isFinite(parseSeconds(entry?.start))
                ? parseSeconds(entry?.start)
                : Number.isFinite(parseSeconds(entry?.startSeconds))
                    ? parseSeconds(entry?.startSeconds)
                    : parseSeconds(entry?.start_ms, 1 / 1000);
            const endSeconds = Number.isFinite(parseSeconds(entry?.end))
                ? parseSeconds(entry?.end)
                : Number.isFinite(parseSeconds(entry?.endSeconds))
                    ? parseSeconds(entry?.endSeconds)
                    : parseSeconds(entry?.end_ms, 1 / 1000);
            pushWord(entry?.word || entry?.text || entry?.token, startSeconds, endSeconds);
        }
    }

    if (timeline.length > 0) {
        timeline.sort((a, b) => a.startSeconds - b.startSeconds);
        return timeline;
    }

    if (Array.isArray(payload?.segments)) {
        for (const segment of payload.segments) {
            pushWord(segment?.text, Number(segment?.start), Number(segment?.end));
        }
    }

    timeline.sort((a, b) => a.startSeconds - b.startSeconds);
    return timeline;
}

function findNearestWordIndexByTime(wordTimeline, targetSeconds) {
    if (!Array.isArray(wordTimeline) || wordTimeline.length === 0) return -1;
    if (!Number.isFinite(targetSeconds)) return 0;

    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < wordTimeline.length; index += 1) {
        const entry = wordTimeline[index];
        const center = (entry.startSeconds + entry.endSeconds) / 2;
        const distance = Math.abs(center - targetSeconds);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function buildFallbackAlignment(words, safeStartIndex, safeEndIndex, confidence = 0.18) {
    const boundedStartIndex = Math.max(0, Math.min(words.length - 1, safeStartIndex));
    const boundedEndIndex = Math.max(
        boundedStartIndex,
        Math.min(words.length - 1, safeEndIndex >= boundedStartIndex ? safeEndIndex : boundedStartIndex + 1)
    );
    return {
        startSeconds: words[boundedStartIndex].startSeconds,
        endSeconds: words[boundedEndIndex].endSeconds,
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
        matchedText: words.slice(boundedStartIndex, boundedEndIndex + 1).map((entry) => entry.token).join(" "),
        coverage: 0,
        averageSimilarity: 0,
        proximity: 0,
        strategy: "fallback-window",
    };
}

function buildFocusedWordSearchWindow(words, fallbackStartSeconds, fallbackEndSeconds) {
    if (!Array.isArray(words) || words.length === 0) return null;
    if (!Number.isFinite(fallbackStartSeconds) || !Number.isFinite(fallbackEndSeconds)) return null;

    const selectionSpan = Math.max(1, fallbackEndSeconds - fallbackStartSeconds);
    const radiusSeconds = Math.max(20, Math.min(110, selectionSpan * 6));
    const windowStart = Math.max(0, fallbackStartSeconds - radiusSeconds);
    const windowEnd = fallbackEndSeconds + radiusSeconds;

    let startIndex = -1;
    let endIndex = -1;
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index];
        if (!Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds)) continue;
        if (startIndex < 0 && word.endSeconds >= windowStart) {
            startIndex = index;
        }
        if (word.startSeconds <= windowEnd) {
            endIndex = index;
        }
    }

    if (startIndex < 0 || endIndex < startIndex) return null;
    return { startIndex, endIndex };
}

function runSmithWatermanAlignment({
    words,
    selectedTokens,
    fallbackStartSeconds,
    strategy,
}) {
    if (!Array.isArray(words) || words.length === 0) return null;
    if (!Array.isArray(selectedTokens) || selectedTokens.length === 0) return null;

    const rowCount = selectedTokens.length + 1;
    const colCount = words.length + 1;
    const matrixSize = rowCount * colCount;

    const scores = new Float32Array(matrixSize);
    const directions = new Uint8Array(matrixSize); // 0 stop, 1 diag, 2 up, 3 left

    const getIndex = (row, col) => row * colCount + col;

    let bestScore = 0;
    let bestRow = 0;
    let bestCol = 0;

    for (let row = 1; row < rowCount; row += 1) {
        const token = selectedTokens[row - 1];
        for (let col = 1; col < colCount; col += 1) {
            const similarity = scoreTokenSimilarity(words[col - 1].token, token);
            const matchScore = similarity >= 0.58
                ? 2 + similarity * 2
                : -1.3 + similarity;
            const diagonal = scores[getIndex(row - 1, col - 1)] + matchScore;
            const up = scores[getIndex(row - 1, col)] - 0.85;
            const left = scores[getIndex(row, col - 1)] - 0.70;

            let cellScore = 0;
            let direction = 0;
            if (diagonal > cellScore) {
                cellScore = diagonal;
                direction = 1;
            }
            if (up > cellScore) {
                cellScore = up;
                direction = 2;
            }
            if (left > cellScore) {
                cellScore = left;
                direction = 3;
            }

            const matrixIndex = getIndex(row, col);
            scores[matrixIndex] = cellScore;
            directions[matrixIndex] = direction;

            if (cellScore > bestScore) {
                bestScore = cellScore;
                bestRow = row;
                bestCol = col;
            }
        }
    }

    if (bestScore <= 0 || bestRow === 0 || bestCol === 0) return null;

    let row = bestRow;
    let col = bestCol;
    let matchedTokenCount = 0;
    let similaritySum = 0;
    let minWordIndex = Infinity;
    let maxWordIndex = -1;

    while (row > 0 && col > 0) {
        const matrixIndex = getIndex(row, col);
        const score = scores[matrixIndex];
        const direction = directions[matrixIndex];
        if (score <= 0 || direction === 0) break;

        if (direction === 1) {
            const similarity = scoreTokenSimilarity(words[col - 1].token, selectedTokens[row - 1]);
            if (similarity >= 0.58) {
                matchedTokenCount += 1;
                similaritySum += similarity;
                minWordIndex = Math.min(minWordIndex, col - 1);
                maxWordIndex = Math.max(maxWordIndex, col - 1);
            }
            row -= 1;
            col -= 1;
            continue;
        }

        if (direction === 2) {
            row -= 1;
            continue;
        }

        col -= 1;
    }

    if (!Number.isFinite(minWordIndex) || maxWordIndex < minWordIndex) return null;

    const coverage = matchedTokenCount / selectedTokens.length;
    const averageSimilarity = matchedTokenCount > 0 ? similaritySum / matchedTokenCount : 0;
    const startSeconds = words[minWordIndex].startSeconds;
    const endSeconds = words[maxWordIndex].endSeconds;
    const proximity = Number.isFinite(fallbackStartSeconds)
        ? Math.max(0, 1 - Math.min(1, Math.abs(startSeconds - fallbackStartSeconds) / 30))
        : 0.8;
    const confidence = Math.max(
        0,
        Math.min(1, coverage * 0.62 + averageSimilarity * 0.28 + proximity * 0.10)
    );
    const qualityScore = bestScore + coverage * 4 + averageSimilarity * 2 + proximity;

    return {
        startSeconds,
        endSeconds,
        confidence,
        matchedText: words.slice(minWordIndex, maxWordIndex + 1).map((entry) => entry.token).join(" "),
        coverage,
        averageSimilarity,
        proximity,
        qualityScore,
        strategy,
    };
}

function findBestAlignmentWindow({
    wordTimeline,
    selectedText,
    fallbackStartSeconds,
    fallbackEndSeconds,
}) {
    const words = Array.isArray(wordTimeline) ? wordTimeline : [];
    if (words.length === 0) return null;

    const fallbackStartIndex = findNearestWordIndexByTime(words, fallbackStartSeconds);
    const fallbackEndIndex = findNearestWordIndexByTime(words, fallbackEndSeconds);
    const safeFallbackStartIndex = Math.max(0, fallbackStartIndex);
    const safeFallbackEndIndex = Math.max(
        safeFallbackStartIndex,
        Math.min(words.length - 1, fallbackEndIndex >= safeFallbackStartIndex ? fallbackEndIndex : safeFallbackStartIndex + 1)
    );

    const selectedTokens = tokenizeForMatch(selectedText);
    if (selectedTokens.length === 0) {
        return buildFallbackAlignment(words, safeFallbackStartIndex, safeFallbackEndIndex, 0.16);
    }

    const searchWindows = [{
        strategy: "global-search",
        startIndex: 0,
        endIndex: words.length - 1,
    }];
    const focusedWindow = buildFocusedWordSearchWindow(words, fallbackStartSeconds, fallbackEndSeconds);
    if (
        focusedWindow &&
        (focusedWindow.startIndex > 0 || focusedWindow.endIndex < words.length - 1)
    ) {
        searchWindows.unshift({
            strategy: "focused-search",
            startIndex: focusedWindow.startIndex,
            endIndex: focusedWindow.endIndex,
        });
    }

    const candidates = [];
    for (const window of searchWindows) {
        const slice = words.slice(window.startIndex, window.endIndex + 1);
        if (slice.length === 0) continue;
        const candidate = runSmithWatermanAlignment({
            words: slice,
            selectedTokens,
            fallbackStartSeconds,
            strategy: window.strategy,
        });
        if (!candidate) continue;

        candidates.push({
            ...candidate,
            startSeconds: candidate.startSeconds,
            endSeconds: candidate.endSeconds,
            matchedText: candidate.matchedText,
        });
    }

    if (candidates.length === 0) {
        return buildFallbackAlignment(words, safeFallbackStartIndex, safeFallbackEndIndex, 0.2);
    }

    candidates.sort((a, b) => b.qualityScore - a.qualityScore);
    const best = candidates[0];
    const minimumMatchedTokens = Math.max(2, Math.min(selectedTokens.length, 4));
    const matchedTokensEstimate = Math.round(best.coverage * selectedTokens.length);

    if (
        best.coverage < 0.38 ||
        best.averageSimilarity < 0.58 ||
        matchedTokensEstimate < minimumMatchedTokens ||
        !(best.endSeconds > best.startSeconds)
    ) {
        return buildFallbackAlignment(words, safeFallbackStartIndex, safeFallbackEndIndex, 0.24);
    }

    return {
        startSeconds: best.startSeconds,
        endSeconds: best.endSeconds,
        confidence: best.confidence,
        matchedText: best.matchedText,
        coverage: best.coverage,
        averageSimilarity: best.averageSimilarity,
        proximity: best.proximity,
        strategy: best.strategy,
    };
}

function buildAlignmentOutcomeFromTranscription({
    transcription,
    selectedText,
    fallbackStartSeconds,
    fallbackEndSeconds,
    providerId,
    providerLabel,
}) {
    const wordTimeline = extractTranscriptionWordTimeline(transcription);
    if (!Array.isArray(wordTimeline) || wordTimeline.length === 0) {
        throw new Error(`${providerLabel} transcription returned no usable word timeline.`);
    }

    const alignment = findBestAlignmentWindow({
        wordTimeline,
        selectedText,
        fallbackStartSeconds,
        fallbackEndSeconds,
    });
    if (!alignment) {
        throw new Error(`${providerLabel} alignment did not return a valid word window.`);
    }

    const confidence = Number(alignment.confidence || 0);
    const coverage = Number(alignment.coverage || 0);
    const similarity = Number(alignment.averageSimilarity || 0);
    const weightedScore = (
        (Number.isFinite(confidence) ? confidence : 0) * 0.62 +
        (Number.isFinite(coverage) ? coverage : 0) * 0.28 +
        (Number.isFinite(similarity) ? similarity : 0) * 0.10
    );

    return {
        providerId,
        providerLabel,
        transcription,
        wordTimeline,
        alignment,
        metrics: {
            confidence: Number.isFinite(confidence) ? confidence : 0,
            coverage: Number.isFinite(coverage) ? coverage : 0,
            similarity: Number.isFinite(similarity) ? similarity : 0,
            proximity: Number(alignment.proximity || 0),
            strategy: String(alignment.strategy || "unknown"),
            weightedScore,
        },
        timedWordCount: Number(transcription?._timedWordCount || countValidTimedWords(transcription)),
        modelUsed: String(transcription?._modelUsed || ""),
    };
}

async function extractAudioTrackForTranscription({ sourceVideoPath, tempDir }) {
    const outputPath = path.join(tempDir, `precision-audio-${Date.now()}.mp3`);
    await execFileAsync("ffmpeg", [
        "-y",
        "-i", sourceVideoPath,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "libmp3lame",
        "-b:a", "64k",
        outputPath,
    ], {
        timeout: 5 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
    });

    const stats = await fs.stat(outputPath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size <= 0) {
        throw new Error("Audio extraction failed for precision alignment.");
    }
    return outputPath;
}

async function extractWaveformPeaks({ audioFilePath, targetBins = 1400 }) {
    const durationSeconds = await getMediaDurationSeconds(audioFilePath);
    const sampleRate = 16000;
    const { stdout } = await execFileAsync("ffmpeg", [
        "-v", "error",
        "-i", audioFilePath,
        "-ac", "1",
        "-ar", String(sampleRate),
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "pipe:1",
    ], {
        encoding: "buffer",
        timeout: 2 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
    });

    const byteLength = Buffer.isBuffer(stdout) ? stdout.length : 0;
    const sampleCount = Math.floor(byteLength / 2);
    if (!sampleCount) {
        return {
            sampleRate,
            durationSeconds,
            binDurationSeconds: durationSeconds,
            bins: [],
        };
    }

    const samples = new Int16Array(stdout.buffer, stdout.byteOffset, sampleCount);
    const binCount = Math.max(64, Math.min(Number(targetBins) || 1400, sampleCount));
    const bins = [];

    for (let index = 0; index < binCount; index += 1) {
        const start = Math.floor((index * sampleCount) / binCount);
        const end = Math.max(start + 1, Math.floor(((index + 1) * sampleCount) / binCount));
        let peak = 0;
        for (let cursor = start; cursor < end && cursor < sampleCount; cursor += 1) {
            const normalized = Math.abs(samples[cursor]) / 32768;
            if (normalized > peak) peak = normalized;
        }
        bins.push(Number(peak.toFixed(4)));
    }

    return {
        sampleRate,
        durationSeconds: Number(durationSeconds.toFixed(3)),
        binDurationSeconds: Number((durationSeconds / binCount).toFixed(6)),
        bins,
    };
}

function parseTimedWordEntry(entry) {
    const text = String(entry?.word || entry?.text || entry?.token || "").trim();
    const parseCandidate = (candidate, scale = 1) => {
        const numeric = Number(candidate);
        return Number.isFinite(numeric) ? numeric * scale : Number.NaN;
    };

    const startCandidates = [entry?.start, entry?.startSeconds];
    const endCandidates = [entry?.end, entry?.endSeconds];

    let startSeconds = Number.NaN;
    let endSeconds = Number.NaN;

    for (const candidate of startCandidates) {
        const parsed = parseCandidate(candidate);
        if (Number.isFinite(parsed)) {
            startSeconds = parsed;
            break;
        }
    }
    if (!Number.isFinite(startSeconds)) {
        const parsedMs = parseCandidate(entry?.start_ms, 1 / 1000);
        if (Number.isFinite(parsedMs)) startSeconds = parsedMs;
    }

    for (const candidate of endCandidates) {
        const parsed = parseCandidate(candidate);
        if (Number.isFinite(parsed)) {
            endSeconds = parsed;
            break;
        }
    }
    if (!Number.isFinite(endSeconds)) {
        const parsedMs = parseCandidate(entry?.end_ms, 1 / 1000);
        if (Number.isFinite(parsedMs)) endSeconds = parsedMs;
    }

    return {
        text,
        startSeconds,
        endSeconds,
    };
}

function countValidTimedWords(payload) {
    if (!Array.isArray(payload?.words)) return 0;
    return payload.words.filter((entry) => {
        const parsed = parseTimedWordEntry(entry);
        return (
            parsed.text.length > 0 &&
            Number.isFinite(parsed.startSeconds) &&
            Number.isFinite(parsed.endSeconds) &&
            parsed.endSeconds > parsed.startSeconds
        );
    }).length;
}

async function requestOpenAiAudioTranscription({
    apiKey,
    audioFilePath,
    selectedText,
    language,
}) {
    const audioBuffer = await fs.readFile(audioFilePath);
    const fileName = path.basename(audioFilePath) || "audio.mp3";
    const normalizedPrompt = String(selectedText || "").trim().slice(0, Math.max(0, PRECISION_ALIGN_MAX_PROMPT_CHARS));
    const normalizedLanguage = String(language || "").trim();
    const modelCandidates = [...new Set([
        String(OPENAI_TRANSCRIBE_MODEL || "").trim(),
        "gpt-4o-transcribe",
        "gpt-4o-mini-transcribe",
        "whisper-1",
    ].filter(Boolean))];
    const requestedTokenCount = tokenizeForMatch(selectedText).length;
    const minimumTimedWords = requestedTokenCount > 0
        ? Math.max(2, Math.min(40, Math.floor(requestedTokenCount * 0.55)))
        : 6;

    const shouldRetryWithoutGranularity = (message) => {
        return /timestamp_granularities|verbose_json|word/i.test(String(message || ""));
    };

    const assertTranscriptionQuality = (payload, modelName) => {
        const timedWordCount = countValidTimedWords(payload);
        const transcriptTextLength = String(payload?.text || "").trim().length;
        if (timedWordCount < minimumTimedWords) {
            throw new Error(
                `${modelName} returned insufficient word timestamps (${timedWordCount}, expected at least ${minimumTimedWords}).`
            );
        }
        if (transcriptTextLength < 8) {
            throw new Error(`${modelName} returned empty transcript text.`);
        }
    };

    const runRequest = async ({ includeTimestampGranularity, modelName }) => {
        const form = new FormData();
        form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), fileName);
        form.append("model", modelName);
        form.append("response_format", "verbose_json");

        if (normalizedPrompt) {
            form.append("prompt", normalizedPrompt);
        }
        if (normalizedLanguage) {
            form.append("language", normalizedLanguage);
        }
        if (includeTimestampGranularity) {
            form.append("timestamp_granularities[]", "segment");
            form.append("timestamp_granularities[]", "word");
        }

        const controller = new AbortController();
        const timeoutMs = Math.max(10000, OPENAI_TRANSCRIBE_TIMEOUT_MS);
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: form,
            signal: controller.signal,
        }).catch((error) => {
            if (error?.name === "AbortError") {
                throw new Error(`OpenAI audio transcription timed out after ${timeoutMs}ms`);
            }
            throw error;
        }).finally(() => {
            clearTimeout(timeoutId);
        });

        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`OpenAI audio transcription failed (${response.status}): ${responseText.slice(0, 600)}`);
        }

        try {
            const parsed = JSON.parse(responseText);
            if (parsed && typeof parsed === "object") {
                parsed._modelUsed = modelName;
                parsed._timedWordCount = countValidTimedWords(parsed);
            }
            return parsed;
        } catch {
            throw new Error("OpenAI audio transcription returned non-JSON content.");
        }
    };

    const failures = [];
    for (const modelName of modelCandidates) {
        try {
            try {
                const withGranularity = await runRequest({ includeTimestampGranularity: true, modelName });
                assertTranscriptionQuality(withGranularity, modelName);
                return withGranularity;
            } catch (firstError) {
                const message = String(firstError?.message || "");
                if (!shouldRetryWithoutGranularity(message)) {
                    throw firstError;
                }
                const withoutGranularity = await runRequest({ includeTimestampGranularity: false, modelName });
                assertTranscriptionQuality(withoutGranularity, modelName);
                return withoutGranularity;
            }
        } catch (error) {
            failures.push(`${modelName}: ${String(error?.message || error).slice(0, 220)}`);
        }
    }

    throw new Error(`OpenAI audio transcription failed across models. Attempts: ${failures.join(" | ")}`.slice(0, 3000));
}

async function requestStableTsAudioTranscription({
    audioFilePath,
    language,
    selectedText,
}) {
    if (!STABLE_TS_LOCAL_ENABLED) {
        throw new Error("stable-ts local provider is disabled (STABLE_TS_LOCAL_ENABLED=false).");
    }

    const scriptPath = String(STABLE_TS_ALIGN_SCRIPT || "").trim();
    if (!scriptPath) {
        throw new Error("Missing stable-ts alignment script path.");
    }

    const scriptStats = await fs.stat(scriptPath).catch(() => null);
    if (!scriptStats || !scriptStats.isFile()) {
        throw new Error(`stable-ts alignment script not found at ${scriptPath}`);
    }

    const args = [
        scriptPath,
        "--audio-path", audioFilePath,
        "--model", STABLE_TS_MODEL,
    ];
    const normalizedLanguage = String(language || "").trim();
    if (normalizedLanguage) {
        args.push("--language", normalizedLanguage);
    }
    if (STABLE_TS_DEVICE) {
        args.push("--device", STABLE_TS_DEVICE);
    }
    if (STABLE_TS_COMPUTE_TYPE) {
        args.push("--compute-type", STABLE_TS_COMPUTE_TYPE);
    }
    const promptHint = String(selectedText || "").trim().slice(0, Math.max(0, PRECISION_ALIGN_MAX_PROMPT_CHARS));
    if (promptHint) {
        args.push("--prompt", promptHint);
    }

    const command = STABLE_TS_USE_ARCH_ARM64 ? "arch" : STABLE_TS_PYTHON_BIN;
    const commandArgs = STABLE_TS_USE_ARCH_ARM64
        ? ["-arm64", STABLE_TS_PYTHON_BIN, ...args]
        : args;

    let stdoutText = "";
    try {
        const result = await execFileAsync(command, commandArgs, {
            timeout: Math.max(30000, STABLE_TS_TIMEOUT_MS),
            maxBuffer: 12 * 1024 * 1024,
            cwd: __dirname,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
            },
        });
        stdoutText = String(result?.stdout || "").trim();
    } catch (error) {
        const stderrText = String(error?.stderr || "");
        const stdoutFallback = String(error?.stdout || "");
        const parsedStdoutPayload = parseLastJsonObjectFromText(stdoutFallback);
        const payloadError = String(parsedStdoutPayload?.error || "").trim();
        const stderrSummary = summarizeStableTsStderr(stderrText);
        const processMeta = [
            Number.isFinite(Number(error?.code)) ? `exit=${Number(error.code)}` : "",
            error?.signal ? `signal=${String(error.signal)}` : "",
            error?.killed ? "killed=true" : "",
        ].filter(Boolean).join(", ");

        let combined = (payloadError || stderrSummary || String(error?.message || "Unknown stable-ts error.")).trim();
        if (processMeta) {
            combined = `${combined} (${processMeta})`;
        }

        if (/killed=true/i.test(processMeta) || /signal=SIGKILL/i.test(processMeta)) {
            combined = `${combined} Likely memory pressure while running local model. Try STABLE_TS_MODEL=small or base, then restart emulator.`;
        }
        if (
            /stable_whisper import failed/i.test(combined) ||
            /no module named ['"]stable_whisper['"]/i.test(combined) ||
            /no module named ['"]torch['"]/i.test(combined)
        ) {
            combined = `${combined} Setup hint: run "npm run stable-ts:setup" from project root and restart the Functions emulator.`;
        }
        if (/spawn .* ENOENT/i.test(combined) || /no such file or directory/i.test(combined)) {
            combined = `${combined} Verify STABLE_TS_PYTHON_BIN points to a real Python executable.`;
        }
        if (/numpy C-extensions failed/i.test(combined) || /Importing the numpy C-extensions failed/i.test(combined)) {
            combined = `${combined} Setup hint: this is usually an architecture mismatch. On Apple Silicon, keep STABLE_TS_FORCE_ARM64=true and restart the Functions emulator.`;
        }
        throw new Error(`stable-ts alignment failed: ${combined.slice(0, 1800)}`);
    }

    if (!stdoutText) {
        throw new Error("stable-ts alignment produced no output.");
    }

    const candidateLines = stdoutText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let parsed = null;
    for (let index = candidateLines.length - 1; index >= 0; index -= 1) {
        const line = candidateLines[index];
        try {
            parsed = JSON.parse(line);
            break;
        } catch {
            // continue scanning lines for JSON payload.
        }
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error("stable-ts alignment returned non-JSON output.");
    }
    if (parsed.success === false) {
        throw new Error(String(parsed.error || "stable-ts alignment returned an error."));
    }

    const normalizedWords = Array.isArray(parsed.words)
        ? parsed.words
            .map((word) => {
                const parsedWord = parseTimedWordEntry(word);
                if (!parsedWord.text || !Number.isFinite(parsedWord.startSeconds) || !Number.isFinite(parsedWord.endSeconds)) {
                    return null;
                }
                if (parsedWord.endSeconds <= parsedWord.startSeconds) return null;
                return {
                    word: parsedWord.text,
                    start: Number(parsedWord.startSeconds.toFixed(4)),
                    end: Number(parsedWord.endSeconds.toFixed(4)),
                };
            })
            .filter(Boolean)
        : [];

    const transcriptText = String(parsed.text || "").trim();
    const response = {
        text: transcriptText,
        words: normalizedWords,
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        _modelUsed: String(parsed.modelUsed || STABLE_TS_MODEL),
        _timedWordCount: normalizedWords.length,
        _provider: ALIGNMENT_PROVIDER_STABLE_TS_LOCAL,
    };

    if (response._timedWordCount <= 0) {
        throw new Error("stable-ts alignment returned no valid timed words.");
    }
    return response;
}

function ensureOpenAiApiKey() {
    if (!process.env.OPENAI_API_KEY) {
        throw new HttpsError("failed-precondition", "Missing OPENAI_API_KEY in Functions runtime.");
    }
    return process.env.OPENAI_API_KEY;
}

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function extractYouTubeVideoId(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    if (YOUTUBE_VIDEO_ID_PATTERN.test(text)) return text;

    try {
        const url = new URL(text);
        const host = url.hostname.toLowerCase().replace(/^www\./, "");

        if (host === "youtu.be") {
            const directId = url.pathname.split("/").filter(Boolean)[0];
            if (YOUTUBE_VIDEO_ID_PATTERN.test(directId || "")) return directId;
        }

        if (
            host.endsWith("youtube.com") ||
            host === "youtube-nocookie.com" ||
            host.endsWith(".youtube-nocookie.com")
        ) {
            const watchId = url.searchParams.get("v");
            if (YOUTUBE_VIDEO_ID_PATTERN.test(watchId || "")) return watchId;

            const parts = url.pathname.split("/").filter(Boolean);
            if (parts.length >= 2) {
                const first = parts[0].toLowerCase();
                const second = parts[1];
                if (["shorts", "embed", "live", "v", "e"].includes(first) && YOUTUBE_VIDEO_ID_PATTERN.test(second || "")) {
                    return second;
                }
            }
        }
    } catch {
        // If URL parsing fails, fallback regex below.
    }

    const fallbackMatch = text.match(
        /(?:youtube\.com\/(?:shorts|embed|live|v|e)\/|youtube\.com\/.*[?&]v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i
    );
    return fallbackMatch ? fallbackMatch[1] : null;
}

function isLikelyYouTubeUrl(value) {
    return Boolean(extractYouTubeVideoId(value));
}

function normalizeLanguageKey(value) {
    const text = String(value || "").trim().toLowerCase();
    return text || "auto";
}

function buildYouTubeTranscriptCacheKey(videoId, preferredLanguage) {
    return `${videoId}::${normalizeLanguageKey(preferredLanguage)}`;
}

function getCachedYouTubeTranscript(cacheKey) {
    const cached = youtubeTranscriptCache.get(cacheKey);
    if (!cached) return null;

    if (cached.expiresAt <= Date.now()) {
        youtubeTranscriptCache.delete(cacheKey);
        return null;
    }

    return cached.value;
}

function setCachedYouTubeTranscript(cacheKey, value) {
    const ttlMs = Math.max(5, TRANSCRIPT_CACHE_TTL_SECONDS) * 1000;
    youtubeTranscriptCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        value,
    });

    if (youtubeTranscriptCache.size <= TRANSCRIPT_CACHE_MAX_ENTRIES) return;

    // Trim oldest entries when cache grows beyond cap.
    const entries = [...youtubeTranscriptCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const overflow = youtubeTranscriptCache.size - TRANSCRIPT_CACHE_MAX_ENTRIES;
    for (let index = 0; index < overflow; index += 1) {
        youtubeTranscriptCache.delete(entries[index][0]);
    }
}

function getProjectId() {
    if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
    if (process.env.FIREBASE_CONFIG) {
        try {
            const config = JSON.parse(process.env.FIREBASE_CONFIG);
            if (config?.projectId) return config.projectId;
        } catch {
            // ignore malformed FIREBASE_CONFIG
        }
    }
    return "church-of-fun-ai-clipping";
}

function sanitizeFileName(value, fallback) {
    const text = String(value || "").trim();
    const normalized = text
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!normalized) return fallback;
    return normalized.slice(0, 100);
}

function getMimeTypeFromExtension(filePath) {
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
    if (ext === ".webm") return "video/webm";
    if (ext === ".mkv") return "video/x-matroska";
    if (ext === ".mov") return "video/quicktime";
    return "application/octet-stream";
}

function formatSecondsForSection(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function extractRenderedClipToken(value) {
    const text = String(value || "").trim();
    if (!text) return "";

    try {
        const parsed = new URL(text);
        return String(parsed.searchParams.get("token") || "").trim();
    } catch {
        // not a URL
    }

    if (/^[0-9a-fA-F-]{36}$/.test(text)) {
        return text;
    }

    return "";
}

async function getMediaDurationSeconds(filePath) {
    const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
    ], {
        timeout: 60 * 1000,
        maxBuffer: 5 * 1024 * 1024,
    });

    const duration = Number(String(stdout || "").trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Unable to determine media duration.");
    }
    return duration;
}

function normalizeEffectsPreset(value) {
    const text = String(value || "none").toLowerCase().trim();
    if (["none", "cinematic", "vivid", "noir", "dream"].includes(text)) return text;
    return "none";
}

function normalizeCaptionStylePreset(value) {
    const text = String(value || "reel-bold").toLowerCase().trim();
    if (["reel-bold", "clean-lower", "minimal", "pop-punch", "paint-reveal"].includes(text)) return text;
    return "reel-bold";
}

function escapeDrawtextText(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/:/g, "\\:")
        .replace(/,/g, "\\,")
        .replace(/'/g, "\\'")
        .replace(/%/g, "\\%")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\n/g, "\\n")
        .trim();
}

function normalizeCaptionCuesForRender(cues, clipDurationSeconds) {
    if (!Array.isArray(cues)) return [];
    const maxDuration = Number.isFinite(clipDurationSeconds) && clipDurationSeconds > 0
        ? clipDurationSeconds
        : Infinity;

    return cues
        .slice(0, Math.max(1, MAX_CAPTION_CUES_PER_ITEM))
        .map((cue, index) => {
            const text = String(cue?.text || "").replace(/\s+/g, " ").trim();
            const startSeconds = Number(cue?.startSeconds);
            const endSeconds = Number(cue?.endSeconds);
            if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;

            const start = clampNumber(startSeconds, 0, maxDuration);
            const end = clampNumber(endSeconds, start + 0.05, maxDuration);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

            return {
                id: String(cue?.id || `cue-${index + 1}`),
                text,
                startSeconds: Number(start.toFixed(2)),
                endSeconds: Number(end.toFixed(2)),
            };
        })
        .filter(Boolean);
}

function splitCaptionWords(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
        .slice(0, 24);
}

function splitCaptionWindows(words, cueStart, cueEnd, maxWordsPerWindow = 5) {
    const safeWords = Array.isArray(words) ? words.filter(Boolean) : [];
    if (safeWords.length === 0) return [];
    if (!Number.isFinite(cueStart) || !Number.isFinite(cueEnd) || cueEnd <= cueStart) return [];

    const normalizedWindowSize = Math.max(1, Math.floor(Number(maxWordsPerWindow) || 5));
    const totalDuration = Math.max(0.12, cueEnd - cueStart);
    const perWordDuration = totalDuration / safeWords.length;
    const windows = [];

    for (let startIndex = 0; startIndex < safeWords.length; startIndex += normalizedWindowSize) {
        const endIndex = Math.min(safeWords.length, startIndex + normalizedWindowSize);
        const windowStart = cueStart + perWordDuration * startIndex;
        const rawWindowEnd = cueStart + perWordDuration * endIndex;
        const windowEnd = endIndex >= safeWords.length ? cueEnd : Math.min(cueEnd, Math.max(windowStart + 0.08, rawWindowEnd));
        windows.push({
            words: safeWords.slice(startIndex, endIndex),
            startSeconds: windowStart,
            endSeconds: windowEnd,
            perWordDuration,
        });
    }

    return windows;
}

function buildTwoRowCaptionText(words, maxWords = 5) {
    const safeWords = Array.isArray(words)
        ? words.filter(Boolean).slice(0, Math.max(1, Math.floor(Number(maxWords) || 5)))
        : [];
    if (safeWords.length === 0) return "";
    const splitIndex = Math.ceil(safeWords.length / 2);
    const topRow = safeWords.slice(0, splitIndex).join(" ");
    const bottomRow = safeWords.slice(splitIndex).join(" ");
    return bottomRow ? `${topRow}\n${bottomRow}` : topRow;
}

function buildEffectFilters({ effectsPreset, effectsIntensity }) {
    const preset = normalizeEffectsPreset(effectsPreset);
    if (preset === "none") return [];

    const intensity = clampNumber(Number(effectsIntensity) || 100, 0, 100) / 100;
    if (preset === "cinematic") {
        return [
            `eq=contrast=${(1 + 0.16 * intensity).toFixed(3)}:saturation=${(1 + 0.12 * intensity).toFixed(3)}:brightness=${(0.015 * intensity).toFixed(3)}`,
            `unsharp=5:5:${(0.35 + 0.55 * intensity).toFixed(3)}:5:5:0.000`,
        ];
    }
    if (preset === "vivid") {
        return [
            `eq=contrast=${(1 + 0.12 * intensity).toFixed(3)}:saturation=${(1 + 0.28 * intensity).toFixed(3)}:gamma=${(1 + 0.04 * intensity).toFixed(3)}`,
        ];
    }
    if (preset === "noir") {
        return [
            "hue=s=0",
            `eq=contrast=${(1 + 0.2 * intensity).toFixed(3)}:brightness=${(0.02 * intensity).toFixed(3)}`,
        ];
    }
    if (preset === "dream") {
        return [
            `gblur=sigma=${(0.4 + 1.6 * intensity).toFixed(3)}`,
            `eq=brightness=${(0.025 * intensity).toFixed(3)}:saturation=${(1 + 0.08 * intensity).toFixed(3)}`,
        ];
    }
    return [];
}

function buildCaptionDrawtextFilters({ captionCues, captionStylePreset }) {
    const normalizedStyle = normalizeCaptionStylePreset(captionStylePreset);
    let styleArgs = "fontcolor=white:fontsize=42:x=(w-text_w)/2:y=h-(text_h*2.2):line_spacing=8:box=1:boxcolor=black@0.58:boxborderw=16";
    if (normalizedStyle === "clean-lower") {
        styleArgs = "fontcolor=white:fontsize=34:x=(w-text_w)/2:y=h-(text_h*1.8):line_spacing=7:box=1:boxcolor=black@0.45:boxborderw=10";
    } else if (normalizedStyle === "minimal") {
        styleArgs = "fontcolor=white:fontsize=30:x=(w-text_w)/2:y=h-(text_h*1.6):line_spacing=6:box=1:boxcolor=black@0.3:boxborderw=6";
    }
    if (normalizedStyle === "pop-punch") {
        const popStyleArgs = "fontcolor=white:fontsize=46:x=(w-text_w)/2:y=h-(text_h*2.1):line_spacing=8:box=1:boxcolor=0x7c3aed@0.78:boxborderw=14:borderw=2:bordercolor=white@0.95";
        const settleStyleArgs = "fontcolor=white:fontsize=38:x=(w-text_w)/2:y=h-(text_h*2.1):line_spacing=8:box=1:boxcolor=black@0.62:boxborderw=12:borderw=1:bordercolor=white@0.42";
        return captionCues
            .flatMap((cue) => {
                const cueStart = Number(cue.startSeconds);
                const cueEnd = Number(cue.endSeconds);
                const words = splitCaptionWords(cue.text);
                const windows = splitCaptionWindows(words, cueStart, cueEnd, 5);
                const filters = [];

                for (const window of windows) {
                    const localPerWord = window.perWordDuration;
                    for (let index = 0; index < window.words.length; index += 1) {
                        const stepStart = window.startSeconds + localPerWord * index;
                        const rawStepEnd = index === window.words.length - 1
                            ? window.endSeconds
                            : window.startSeconds + localPerWord * (index + 1);
                        const stepEnd = Math.min(window.endSeconds, Math.max(stepStart + 0.06, rawStepEnd));
                        if (stepEnd <= stepStart) continue;

                        const progressiveText = escapeDrawtextText(
                            buildTwoRowCaptionText(window.words.slice(0, index + 1), 5)
                        );
                        if (!progressiveText) continue;

                        const popEnd = Math.min(stepEnd, stepStart + Math.min(0.16, Math.max(0.08, (stepEnd - stepStart) * 0.8)));
                        const settleStart = Math.min(stepEnd, stepStart + 0.05);
                        filters.push(
                            `drawtext=text='${progressiveText}':${popStyleArgs}:enable='between(t,${stepStart.toFixed(2)},${popEnd.toFixed(2)})'`
                        );
                        if (stepEnd - settleStart > 0.03) {
                            filters.push(
                                `drawtext=text='${progressiveText}':${settleStyleArgs}:enable='between(t,${settleStart.toFixed(2)},${stepEnd.toFixed(2)})'`
                            );
                        }
                    }
                }
                return filters;
            })
            .filter(Boolean);
    }
    if (normalizedStyle === "paint-reveal") {
        const paintStyleArgs = "fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-(text_h*2.1):line_spacing=8:box=1:boxcolor=0x111827@0.62:boxborderw=12:borderw=1:bordercolor=0x22d3ee@0.78";
        return captionCues
            .flatMap((cue) => {
                const cueStart = Number(cue.startSeconds);
                const cueEnd = Number(cue.endSeconds);
                const words = splitCaptionWords(cue.text);
                const windows = splitCaptionWindows(words, cueStart, cueEnd, 5);
                const filters = [];

                for (const window of windows) {
                    const localPerWord = window.perWordDuration;
                    for (let index = 0; index < window.words.length; index += 1) {
                        const stepStart = window.startSeconds + localPerWord * index;
                        const rawStepEnd = index === window.words.length - 1
                            ? window.endSeconds
                            : window.startSeconds + localPerWord * (index + 1);
                        const stepEnd = Math.min(window.endSeconds, Math.max(stepStart + 0.06, rawStepEnd));
                        if (stepEnd <= stepStart) continue;

                        const progressiveText = escapeDrawtextText(
                            buildTwoRowCaptionText(window.words.slice(0, index + 1), 5)
                        );
                        if (!progressiveText) continue;
                        filters.push(
                            `drawtext=text='${progressiveText}':${paintStyleArgs}:enable='between(t,${stepStart.toFixed(2)},${stepEnd.toFixed(2)})'`
                        );
                    }
                }
                return filters;
            })
            .filter(Boolean);
    }

    return captionCues
        .map((cue) => {
            const text = escapeDrawtextText(cue.text);
            if (!text) return null;
            return `drawtext=text='${text}':${styleArgs}:enable='between(t,${Number(cue.startSeconds).toFixed(2)},${Number(cue.endSeconds).toFixed(2)})'`;
        })
        .filter(Boolean);
}

function buildEditVideoFilter({ effectsPreset, effectsIntensity, captionCues, captionStylePreset }) {
    const filters = [
        `scale=${EDIT_RENDER_TARGET_WIDTH}:${EDIT_RENDER_TARGET_HEIGHT}:force_original_aspect_ratio=decrease`,
        `pad=${EDIT_RENDER_TARGET_WIDTH}:${EDIT_RENDER_TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
        ...buildEffectFilters({ effectsPreset, effectsIntensity }),
        ...buildCaptionDrawtextFilters({
            captionCues: Array.isArray(captionCues) ? captionCues : [],
            captionStylePreset,
        }),
        "format=yuv420p",
    ];
    return filters.join(",");
}

async function renderEditedClipSegment({
    sourcePath,
    trimStartSeconds,
    trimEndSeconds,
    tempDir,
    index,
    effectsPreset,
    effectsIntensity,
    captionCues,
    captionStylePreset,
}) {
    const sourceDuration = await getMediaDurationSeconds(sourcePath);
    const maxStart = Math.max(0, sourceDuration - 0.1);
    const start = clampNumber(Number(trimStartSeconds) || 0, 0, maxStart);
    const requestedEnd = Number(trimEndSeconds);
    const end = Number.isFinite(requestedEnd)
        ? clampNumber(requestedEnd, start + 0.1, sourceDuration)
        : sourceDuration;
    const clipDurationSeconds = Math.max(0.1, end - start);
    const normalizedCaptionCues = normalizeCaptionCuesForRender(captionCues, clipDurationSeconds);

    const outputPath = path.join(tempDir, `timeline-edit-${index + 1}.mp4`);
    const args = [
        "-y",
        "-ss", start.toFixed(3),
        "-to", end.toFixed(3),
        "-i", sourcePath,
        "-vf", buildEditVideoFilter({
            effectsPreset,
            effectsIntensity,
            captionCues: normalizedCaptionCues,
            captionStylePreset,
        }),
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "22",
        "-c:a", "aac",
        "-ac", "2",
        "-ar", "48000",
        "-movflags", "+faststart",
        outputPath,
    ];

    await execFileAsync("ffmpeg", args, {
        timeout: 10 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
    });

    const stats = await fs.stat(outputPath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size <= 0) {
        throw new Error("Edited clip render produced no output file.");
    }

    return {
        filePath: outputPath,
        startSeconds: start,
        endSeconds: end,
    };
}

async function concatEditedClipFiles({ clipPaths, tempDir }) {
    const validPaths = clipPaths.filter(Boolean);
    if (validPaths.length === 0) {
        throw new Error("No clip files available for montage rendering.");
    }

    if (validPaths.length === 1) {
        return validPaths[0];
    }

    const concatListPath = path.join(tempDir, "timeline-concat-list.txt");
    const concatListContents = validPaths
        .map((clipPath) => `file '${clipPath.replace(/'/g, "'\\''")}'`)
        .join("\n");
    await fs.writeFile(concatListPath, concatListContents, "utf8");

    const outputPath = path.join(tempDir, "timeline-montage.mp4");
    await execFileAsync("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatListPath,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "22",
        "-c:a", "aac",
        "-ac", "2",
        "-ar", "48000",
        "-movflags", "+faststart",
        outputPath,
    ], {
        timeout: 12 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
    });

    const stats = await fs.stat(outputPath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size <= 0) {
        throw new Error("Montage render produced no output file.");
    }

    return outputPath;
}

function normalizeClipForRender(rawClip, index) {
    const start = parseTimestampToSeconds(rawClip?.startTimestamp);
    const end = parseTimestampToSeconds(rawClip?.endTimestamp);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error(`Clip ${index + 1} has invalid timestamps.`);
    }

    const boundedDuration = Math.min(MAX_RENDER_SECONDS_PER_CLIP, Math.max(1, end - start));
    const boundedEnd = start + boundedDuration;
    return {
        title: String(rawClip?.title || `clip-${index + 1}`),
        startSeconds: start,
        endSeconds: boundedEnd,
        startTimestamp: formatSecondsToTimestamp(start),
        endTimestamp: formatSecondsToTimestamp(boundedEnd),
    };
}

function getRenderedClipMetadataPath(token) {
    return path.join(renderedClipStorageDir, `${token}.json`);
}

function normalizeRenderedClipEntry(value) {
    if (!value || typeof value !== "object") return null;

    const filePath = String(value.filePath || "").trim();
    const fileName = String(value.fileName || "").trim();
    const mimeType = String(value.mimeType || "").trim() || getMimeTypeFromExtension(filePath);
    const expiresAt = Number(value.expiresAt);

    if (!filePath || !fileName || !Number.isFinite(expiresAt)) {
        return null;
    }

    return {
        filePath,
        fileName,
        mimeType,
        expiresAt,
    };
}

async function removeRenderedClipArtifacts(token, entry = null) {
    renderedClipStore.delete(token);

    const normalized = normalizeRenderedClipEntry(entry);
    if (normalized?.filePath) {
        await fs.rm(normalized.filePath, { force: true }).catch(() => {});
    }

    const metadataPath = getRenderedClipMetadataPath(token);
    await fs.rm(metadataPath, { force: true }).catch(() => {});
}

async function writeRenderedClipMetadata(token, entry) {
    await fs.mkdir(renderedClipStorageDir, { recursive: true });
    const metadataPath = getRenderedClipMetadataPath(token);
    const payload = JSON.stringify({ token, ...entry });
    await fs.writeFile(metadataPath, payload, "utf8");
}

async function loadRenderedClipEntry(token) {
    const now = Date.now();
    const cached = renderedClipStore.get(token);
    if (cached && cached.expiresAt > now) {
        return cached;
    }

    const metadataPath = getRenderedClipMetadataPath(token);
    const rawMetadata = await fs.readFile(metadataPath, "utf8").catch(() => null);
    if (!rawMetadata) {
        renderedClipStore.delete(token);
        return null;
    }

    let parsedMetadata;
    try {
        parsedMetadata = JSON.parse(rawMetadata);
    } catch {
        await removeRenderedClipArtifacts(token, null);
        return null;
    }

    const entry = normalizeRenderedClipEntry(parsedMetadata);
    if (!entry) {
        await removeRenderedClipArtifacts(token, null);
        return null;
    }

    if (entry.expiresAt <= now) {
        await removeRenderedClipArtifacts(token, entry);
        return null;
    }

    const stats = await fs.stat(entry.filePath).catch(() => null);
    if (!stats || !stats.isFile()) {
        await removeRenderedClipArtifacts(token, entry);
        return null;
    }

    renderedClipStore.set(token, entry);
    return entry;
}

async function cleanupExpiredRenderedClips() {
    const now = Date.now();
    const entries = [...renderedClipStore.entries()];
    for (const [token, entry] of entries) {
        if (entry.expiresAt > now) continue;
        await removeRenderedClipArtifacts(token, entry);
    }

    const metadataNames = await fs.readdir(renderedClipStorageDir).catch(() => []);
    for (const metadataName of metadataNames) {
        if (!metadataName.endsWith(".json")) continue;

        const metadataPath = path.join(renderedClipStorageDir, metadataName);
        const token = metadataName.replace(/\.json$/, "");
        const rawMetadata = await fs.readFile(metadataPath, "utf8").catch(() => null);
        if (!rawMetadata) continue;

        let parsedMetadata;
        try {
            parsedMetadata = JSON.parse(rawMetadata);
        } catch {
            await removeRenderedClipArtifacts(token, null);
            continue;
        }

        const entry = normalizeRenderedClipEntry(parsedMetadata);
        if (!entry || entry.expiresAt <= now) {
            await removeRenderedClipArtifacts(token, entry);
        }
    }
}

function buildDownloadUrlForRequest(request, token) {
    const host = request?.rawRequest?.get?.("host");
    if (!host) return "";

    const isLocal = /localhost|127\.0\.0\.1/.test(host);
    const protocol = isLocal ? "http" : "https";
    const encodedToken = encodeURIComponent(token);

    if (isLocal) {
        return `${protocol}://${host}/${getProjectId()}/us-central1/downloadRenderedClip?token=${encodedToken}`;
    }
    return `${protocol}://${host}/downloadRenderedClip?token=${encodedToken}`;
}

const YOUTUBE_USER_AGENT = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    "Chrome/125.0.0.0 Safari/537.36",
].join(" ");

const YOUTUBE_PLAYER_RESPONSE_MARKERS = [
    "var ytInitialPlayerResponse = ",
    "ytInitialPlayerResponse = ",
    "window['ytInitialPlayerResponse'] = ",
    "window[\"ytInitialPlayerResponse\"] = ",
    "\"ytInitialPlayerResponse\":",
];

function cleanYouTubeErrorMessage(error) {
    return String(error?.message || "Unknown caption lookup error.")
        .replace(/^\[YoutubeTranscript\]\s*🚨\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

function summarizeExecError(error) {
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    const base = String(error?.message || "process failed");
    const details = `${stderr}\n${stdout}`.trim();
    if (!details) return base;

    const lines = details.split("\n").map((line) => line.trim()).filter(Boolean);
    const tail = lines.slice(-18).join(" | ");
    return `${base} :: ${tail.slice(0, 4000)}`;
}

function decodeHtmlEntities(text) {
    return String(text || "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\u00a0/g, " ");
}

function normalizeCaptionText(text) {
    return decodeHtmlEntities(String(text || ""))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function splitWords(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function findPrefixOverlap(contextWords, currentWords, maxOverlap = 40) {
    const max = Math.min(contextWords.length, currentWords.length, maxOverlap);
    for (let size = max; size > 0; size -= 1) {
        let matched = true;
        for (let index = 0; index < size; index += 1) {
            if (contextWords[contextWords.length - size + index] !== currentWords[index]) {
                matched = false;
                break;
            }
        }
        if (matched) return size;
    }
    return 0;
}

function dedupeSequentialCaptionEntries(entries) {
    const deduped = [];
    const contextWords = [];
    const maxContextWords = 160;

    for (const entry of entries) {
        const normalizedText = normalizeCaptionText(entry.text);
        const displayWords = splitWords(normalizedText);
        if (displayWords.length === 0) continue;

        const compareWords = displayWords.map((word) => word.toLowerCase());
        const overlap = findPrefixOverlap(contextWords, compareWords);
        const remainingWords = displayWords.slice(overlap);
        if (remainingWords.length === 0) continue;

        const text = remainingWords.join(" ");
        deduped.push({
            ...entry,
            text,
        });

        const remainingCompareWords = compareWords.slice(overlap);
        contextWords.push(...remainingCompareWords);
        if (contextWords.length > maxContextWords) {
            contextWords.splice(0, contextWords.length - maxContextWords);
        }
    }

    return deduped;
}

function extractJsonObjectFromText(text, startAt) {
    let start = startAt;
    while (start < text.length && /\s/.test(text[start])) {
        start += 1;
    }
    if (text[start] !== "{") return null;

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let i = start; i < text.length; i += 1) {
        const char = text[i];

        if (inString) {
            if (escaping) {
                escaping = false;
                continue;
            }
            if (char === "\\") {
                escaping = true;
                continue;
            }
            if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }
        if (char === "{") {
            depth += 1;
            continue;
        }
        if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
}

function extractPlayerResponseJson(html) {
    for (const marker of YOUTUBE_PLAYER_RESPONSE_MARKERS) {
        const index = html.indexOf(marker);
        if (index < 0) continue;

        const start = index + marker.length;
        const candidate = extractJsonObjectFromText(html, start);
        if (!candidate) continue;

        try {
            return JSON.parse(candidate);
        } catch {
            // Try next marker/candidate.
        }
    }
    return null;
}

function pickCaptionTrack(captionTracks, preferredLanguage) {
    const requested = String(preferredLanguage || "").trim().toLowerCase();
    if (requested) {
        const exact = captionTracks.find((track) => String(track.languageCode || "").toLowerCase() === requested);
        if (exact) return exact;

        const requestedRoot = requested.split("-")[0];
        const rootMatch = captionTracks.find((track) => String(track.languageCode || "").toLowerCase().startsWith(requestedRoot));
        if (rootMatch) return rootMatch;
    }

    const english = captionTracks.find((track) => String(track.languageCode || "").toLowerCase().startsWith("en"));
    if (english) return english;

    return captionTracks[0];
}

function parseJson3Transcript(payload, fallbackLanguage) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const entries = [];

    for (const event of events) {
        const text = Array.isArray(event?.segs)
            ? normalizeCaptionText(event.segs.map((seg) => seg?.utf8 || "").join(" "))
            : "";
        if (!text) continue;

        const startMs = Number(event?.tStartMs);
        const durationMs = Number(event?.dDurationMs);
        const offset = Number.isFinite(startMs) ? startMs / 1000 : 0;
        const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 2;

        entries.push({
            text,
            offset,
            duration,
            lang: fallbackLanguage || "auto",
        });
    }

    return entries;
}

function parseSecondsOrMilliseconds(rawValue) {
    const text = String(rawValue ?? "").trim();
    if (!text) return null;
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;
    if (text.includes(".")) return numeric;
    return numeric / 1000;
}

function parseXmlTranscript(xml, fallbackLanguage) {
    const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    const entries = [];
    let match;

    while ((match = pattern.exec(xml)) !== null) {
        const attrs = match[1] || "";
        const text = normalizeCaptionText(match[2]);
        if (!text) continue;

        const startMatch = attrs.match(/\bstart="([^"]+)"/);
        const durMatch = attrs.match(/\bdur="([^"]+)"/);
        const offset = Number(startMatch?.[1]);
        const duration = Number(durMatch?.[1]);

        entries.push({
            text,
            offset: Number.isFinite(offset) ? offset : 0,
            duration: Number.isFinite(duration) && duration > 0 ? duration : 2,
            lang: fallbackLanguage || "auto",
        });
    }

    return entries;
}

function parseSrv3Transcript(xml, fallbackLanguage) {
    const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    const entries = [];
    let match;

    while ((match = pattern.exec(xml)) !== null) {
        const attrs = match[1] || "";
        const text = normalizeCaptionText(match[2]);
        if (!text) continue;

        const startMatch = attrs.match(/\bt="([^"]+)"/);
        const durMatch = attrs.match(/\bd="([^"]+)"/);
        const offset = parseSecondsOrMilliseconds(startMatch?.[1]);
        const duration = parseSecondsOrMilliseconds(durMatch?.[1]);

        entries.push({
            text,
            offset: Number.isFinite(offset) ? offset : 0,
            duration: Number.isFinite(duration) && duration > 0 ? duration : 2,
            lang: fallbackLanguage || "auto",
        });
    }

    return entries;
}

function parseVttTimeToSeconds(value) {
    const text = String(value || "").trim();
    const parts = text.split(":");
    if (parts.length < 2 || parts.length > 3) return null;

    const secondsPart = parts[parts.length - 1].replace(",", ".");
    const seconds = Number(secondsPart);
    if (!Number.isFinite(seconds)) return null;

    let total = seconds;
    if (parts.length === 2) {
        const minutes = Number(parts[0]);
        if (!Number.isFinite(minutes)) return null;
        total += minutes * 60;
    } else {
        const hours = Number(parts[0]);
        const minutes = Number(parts[1]);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
        total += hours * 3600 + minutes * 60;
    }
    return total;
}

function parseVttTranscript(vtt, fallbackLanguage) {
    const normalized = String(vtt || "").replace(/\r\n/g, "\n");
    const chunks = normalized.split("\n\n");
    const entries = [];

    for (const chunk of chunks) {
        const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        if (lines[0].toUpperCase() === "WEBVTT") continue;

        let timingLineIndex = lines.findIndex((line) => line.includes("-->"));
        if (timingLineIndex < 0) continue;

        const timingLine = lines[timingLineIndex];
        const [rawStart, rawEndWithSettings] = timingLine.split("-->").map((part) => part.trim());
        const rawEnd = rawEndWithSettings?.split(/\s+/)[0];

        const start = parseVttTimeToSeconds(rawStart);
        const end = parseVttTimeToSeconds(rawEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

        const textLines = lines.slice(timingLineIndex + 1);
        const text = normalizeCaptionText(textLines.join(" "));
        if (!text) continue;

        entries.push({
            text,
            offset: start,
            duration: Math.max(0.2, end - start),
            lang: fallbackLanguage || "auto",
        });
    }

    return entries;
}

function languageScore(candidate, preferredLanguage) {
    const preferred = String(preferredLanguage || "").toLowerCase().trim();
    const value = String(candidate || "").toLowerCase().trim();
    if (!value) return 0;
    if (preferred && value === preferred) return 100;
    const preferredRoot = preferred.split("-")[0];
    if (preferredRoot && value.startsWith(preferredRoot)) return 80;
    if (value.startsWith("en")) return 60;
    return 10;
}

function inferLanguageFromSubtitleFileName(fileName) {
    const withoutExt = String(fileName || "").replace(/\.vtt$/i, "");
    const parts = withoutExt.split(".");
    if (parts.length < 2) return "auto";
    const languagePart = parts[parts.length - 1];
    return languagePart.replace(/-orig$/i, "");
}

function rankSubtitleFiles(fileNames, preferredLanguage) {
    return [...fileNames].sort((a, b) => {
        const aLang = inferLanguageFromSubtitleFileName(a);
        const bLang = inferLanguageFromSubtitleFileName(b);
        const aScore = languageScore(aLang, preferredLanguage);
        const bScore = languageScore(bLang, preferredLanguage);
        if (aScore !== bScore) return bScore - aScore;
        return a.localeCompare(b);
    });
}

async function findRenderedVideoFile(tempDir, prefix) {
    const names = await fs.readdir(tempDir);
    const candidates = names.filter((name) => {
        if (!name.startsWith(prefix)) return false;
        if (name.endsWith(".part") || name.endsWith(".ytdl")) return false;
        if (name.endsWith(".info.json") || name.endsWith(".description")) return false;
        return /\.(mp4|m4v|mkv|webm|mov)$/i.test(name);
    });

    if (candidates.length === 0) {
        return null;
    }

    const filesWithSize = await Promise.all(
        candidates.map(async (name) => {
            const fullPath = path.join(tempDir, name);
            const stats = await fs.stat(fullPath);
            return { name, fullPath, size: stats.size };
        })
    );

    filesWithSize.sort((a, b) => b.size - a.size);
    return filesWithSize[0];
}

async function storeRenderedClipFile({ sourcePath, clipTitle, index }) {
    await fs.mkdir(renderedClipStorageDir, { recursive: true });

    const token = randomUUID();
    const extension = path.extname(sourcePath).toLowerCase() || ".mp4";
    const safeTitle = sanitizeFileName(clipTitle, `clip-${index + 1}`);
    const fileName = sanitizeFileName(`${safeTitle}-${index + 1}${extension}`, `clip-${index + 1}${extension}`);
    const destinationPath = path.join(renderedClipStorageDir, `${token}${extension}`);

    await fs.rename(sourcePath, destinationPath);

    const entry = {
        filePath: destinationPath,
        fileName,
        mimeType: getMimeTypeFromExtension(destinationPath),
        expiresAt: Date.now() + Math.max(60, RENDERED_CLIP_TTL_SECONDS) * 1000,
    };

    renderedClipStore.set(token, entry);
    await writeRenderedClipMetadata(token, entry);
    await cleanupExpiredRenderedClips();

    return { token, ...entry };
}

function toTranscriptResult(entries, meta) {
    const normalizedEntries = entries.map((entry) => ({
        ...entry,
        text: normalizeCaptionText(entry.text),
    }));
    const dedupedEntries = dedupeSequentialCaptionEntries(normalizedEntries);
    const sourceEntries = dedupedEntries.length > 0 ? dedupedEntries : normalizedEntries;

    const rawSegments = sourceEntries.map((entry) => ({
        startTimestamp: formatSecondsToTimestamp(entry.offset),
        endTimestamp: formatSecondsToTimestamp(entry.offset + entry.duration),
        speaker: "Caption",
        text: entry.text,
    }));

    const segments = applyTranscriptRules(rawSegments, TRANSCRIPT_MAX_SEGMENTS_YOUTUBE);
    if (segments.length === 0) {
        throw new Error("Caption track returned no valid segments.");
    }

    return {
        segments,
        videoId: meta.videoId,
        languageUsed: meta.languageUsed || entries[0]?.lang || "auto",
        providerUsed: meta.provider,
        attemptMode: meta.attemptMode,
    };
}

async function fetchYouTubeTranscriptWithLibrary(videoId, language) {
    const transcript = language
        ? await YoutubeTranscript.fetchTranscript(videoId, { lang: language })
        : await YoutubeTranscript.fetchTranscript(videoId);

    return toTranscriptResult(transcript, {
        videoId,
        languageUsed: transcript[0]?.lang || language || "auto",
        provider: "youtube-transcript",
        attemptMode: language ? "language" : "auto",
    });
}

async function fetchYouTubeTranscriptViaWatchPage(videoId, language) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=${encodeURIComponent(language || "en")}`;
    const watchResponse = await fetch(watchUrl, {
        headers: {
            "Accept-Language": language || "en-US,en;q=0.9",
            "User-Agent": YOUTUBE_USER_AGENT,
        },
    });
    if (!watchResponse.ok) {
        throw new Error(`Failed to load watch page (${watchResponse.status}).`);
    }

    const watchHtml = await watchResponse.text();
    if (watchHtml.includes("g-recaptcha") || watchHtml.includes("consent.youtube.com")) {
        throw new Error("YouTube requires captcha/consent before captions can be fetched from this IP.");
    }

    const playerResponse = extractPlayerResponseJson(watchHtml);
    const tracklist = playerResponse?.captions?.playerCaptionsTracklistRenderer;
    const captionTracks = Array.isArray(tracklist?.captionTracks) ? tracklist.captionTracks : [];

    if (captionTracks.length === 0) {
        throw new Error("No caption tracks found in watch page player response.");
    }

    const selectedTrack = pickCaptionTrack(captionTracks, language);
    const trackUrl = selectedTrack?.baseUrl;
    if (!trackUrl) {
        throw new Error("Caption track was found but did not provide a transcript URL.");
    }

    const jsonUrl = new URL(trackUrl);
    jsonUrl.searchParams.set("fmt", "json3");

    const transcriptJsonResponse = await fetch(jsonUrl.toString(), {
        headers: {
            "Accept-Language": language || selectedTrack.languageCode || "en-US,en;q=0.9",
            "User-Agent": YOUTUBE_USER_AGENT,
        },
    });

    if (transcriptJsonResponse.ok) {
        const transcriptJsonText = await transcriptJsonResponse.text();
        if (transcriptJsonText.trim().length > 0) {
            try {
                const normalizedJsonText = transcriptJsonText.replace(/^\)\]\}'\s*/, "");
                const transcriptJson = JSON.parse(normalizedJsonText);
                const jsonEntries = parseJson3Transcript(transcriptJson, selectedTrack.languageCode);
                if (jsonEntries.length > 0) {
                    return toTranscriptResult(jsonEntries, {
                        videoId,
                        languageUsed: selectedTrack.languageCode || language || "auto",
                        provider: "watch-page-json3",
                        attemptMode: language ? "language" : "auto",
                    });
                }
            } catch {
                // Continue to XML fallback below.
            }
        }
    }

    const srv3Url = new URL(trackUrl);
    srv3Url.searchParams.set("fmt", "srv3");
    const transcriptXmlResponse = await fetch(srv3Url.toString(), {
        headers: {
            "Accept-Language": language || selectedTrack.languageCode || "en-US,en;q=0.9",
            "User-Agent": YOUTUBE_USER_AGENT,
        },
    });
    if (!transcriptXmlResponse.ok) {
        throw new Error(`Caption track request failed (${transcriptXmlResponse.status}).`);
    }

    const transcriptXml = await transcriptXmlResponse.text();
    const xmlEntries = parseXmlTranscript(transcriptXml, selectedTrack.languageCode);
    if (xmlEntries.length > 0) {
        return toTranscriptResult(xmlEntries, {
            videoId,
            languageUsed: selectedTrack.languageCode || language || "auto",
            provider: "watch-page-xml",
            attemptMode: language ? "language" : "auto",
        });
    }

    const srv3Entries = parseSrv3Transcript(transcriptXml, selectedTrack.languageCode);
    if (srv3Entries.length > 0) {
        return toTranscriptResult(srv3Entries, {
            videoId,
            languageUsed: selectedTrack.languageCode || language || "auto",
            provider: "watch-page-srv3",
            attemptMode: language ? "language" : "auto",
        });
    }

    const vttEntries = parseVttTranscript(transcriptXml, selectedTrack.languageCode);
    if (vttEntries.length > 0) {
        return toTranscriptResult(vttEntries, {
            videoId,
            languageUsed: selectedTrack.languageCode || language || "auto",
            provider: "watch-page-vtt",
            attemptMode: language ? "language" : "auto",
        });
    }

    try {
        return await fetchYouTubeTranscriptViaNoFmtTrack(
            videoId,
            language,
            trackUrl,
            selectedTrack.languageCode
        );
    } catch (noFmtError) {
        const sample = transcriptXml.slice(0, 120).replace(/\s+/g, " ").trim();
        throw new Error(
            `Caption track returned no transcript text. Sample: ${sample}. No-fmt fallback: ${cleanYouTubeErrorMessage(noFmtError)}`
        );
    }

}

async function fetchYouTubeTranscriptViaNoFmtTrack(videoId, language, trackUrl, trackLanguage) {
    const rawUrl = new URL(trackUrl);
    rawUrl.searchParams.delete("fmt");

    const response = await fetch(rawUrl.toString(), {
        headers: {
            "Accept-Language": language || trackLanguage || "en-US,en;q=0.9",
            "User-Agent": YOUTUBE_USER_AGENT,
        },
    });

    if (!response.ok) {
        throw new Error(`No-fmt track request failed (${response.status}).`);
    }

    const body = await response.text();

    const xmlEntries = parseXmlTranscript(body, trackLanguage);
    if (xmlEntries.length > 0) {
        return toTranscriptResult(xmlEntries, {
            videoId,
            languageUsed: trackLanguage || language || "auto",
            provider: "watch-page-nofmt-xml",
            attemptMode: language ? "language" : "auto",
        });
    }

    const srv3Entries = parseSrv3Transcript(body, trackLanguage);
    if (srv3Entries.length > 0) {
        return toTranscriptResult(srv3Entries, {
            videoId,
            languageUsed: trackLanguage || language || "auto",
            provider: "watch-page-nofmt-srv3",
            attemptMode: language ? "language" : "auto",
        });
    }

    const vttEntries = parseVttTranscript(body, trackLanguage);
    if (vttEntries.length > 0) {
        return toTranscriptResult(vttEntries, {
            videoId,
            languageUsed: trackLanguage || language || "auto",
            provider: "watch-page-nofmt-vtt",
            attemptMode: language ? "language" : "auto",
        });
    }

    const sample = body.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new Error(`No-fmt track returned no transcript text. Sample: ${sample}`);
}

async function fetchYouTubeTranscriptViaYtDlp(videoId, videoUrl, language) {
    if (process.env.ENABLE_YTDLP_TRANSCRIPT === "false") {
        throw new Error("yt-dlp transcript provider disabled by environment configuration.");
    }

    const targetUrl = String(videoUrl || "").trim() || `https://www.youtube.com/watch?v=${videoId}`;
    const preferredLanguage = String(language || "").trim();
    const langSpec = preferredLanguage
        ? `${preferredLanguage}.*,${preferredLanguage},en.*,en,-live_chat`
        : "en.*,en,-live_chat";

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-captions-"));
    try {
        const cookiesFromBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
        const args = [
            "--no-update",
            "--ignore-errors",
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-format",
            "vtt",
            "--sub-langs",
            langSpec,
            "--output",
            "%(id)s.%(ext)s",
        ];

        if (cookiesFromBrowser) {
            args.push("--cookies-from-browser", cookiesFromBrowser);
        }

        args.push(targetUrl);

        let execError = null;
        try {
            await execFileAsync("yt-dlp", args, {
                cwd: tempDir,
                timeout: 45000,
                maxBuffer: 20 * 1024 * 1024,
            });
        } catch (error) {
            // Some subtitle downloads can fail (e.g., rate-limited language variants) while desired files are still written.
            execError = error;
        }

        const fileNames = await fs.readdir(tempDir);
        const vttFiles = rankSubtitleFiles(
            fileNames.filter((name) => name.toLowerCase().endsWith(".vtt")),
            preferredLanguage
        );

        if (vttFiles.length === 0) {
            if (execError) {
                throw new Error(`yt-dlp did not produce subtitle files. ${summarizeExecError(execError)}`);
            }
            throw new Error("yt-dlp did not produce subtitle files.");
        }

        for (const fileName of vttFiles) {
            const body = await fs.readFile(path.join(tempDir, fileName), "utf8");
            const entries = parseVttTranscript(body, inferLanguageFromSubtitleFileName(fileName));
            if (entries.length > 0) {
                return toTranscriptResult(entries, {
                    videoId,
                    languageUsed: inferLanguageFromSubtitleFileName(fileName),
                    provider: "yt-dlp-vtt",
                    attemptMode: preferredLanguage ? "language" : "auto",
                });
            }
        }

        if (execError) {
            throw new Error(`yt-dlp subtitle files were unreadable. ${summarizeExecError(execError)}`);
        }
        throw new Error("yt-dlp subtitle files contained no transcript text.");
    } catch (error) {
        throw new Error(`yt-dlp provider failed: ${summarizeExecError(error)}`);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function renderYouTubeClipSegment({ videoUrl, clip, tempDir, index, timeoutMs = 300000 }) {
    const cookiesFromBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
    const clipPrefix = `render-${Date.now()}-${index + 1}`;
    const outputTemplate = path.join(tempDir, `${clipPrefix}.%(ext)s`);
    const sectionRange = `${formatSecondsForSection(clip.startSeconds)}-${formatSecondsForSection(clip.endSeconds)}`;
    const formatSelection = String(process.env.YTDLP_CLIP_FORMAT || "bv*[height<=720]+ba/b[height<=720]/best");

    const args = [
        "--no-update",
        "--ignore-errors",
        "--no-playlist",
        "--download-sections",
        `*${sectionRange}`,
        "--force-keyframes-at-cuts",
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "-f",
        formatSelection,
        "--output",
        outputTemplate,
    ];

    if (cookiesFromBrowser) {
        args.push("--cookies-from-browser", cookiesFromBrowser);
    }

    args.push(videoUrl);

    let execError = null;
    try {
        await execFileAsync("yt-dlp", args, {
            cwd: tempDir,
            timeout: Math.max(20000, Number(timeoutMs) || 300000),
            maxBuffer: 20 * 1024 * 1024,
        });
    } catch (error) {
        execError = error;
    }

    const renderedFile = await findRenderedVideoFile(tempDir, clipPrefix);
    if (!renderedFile) {
        if (execError) {
            throw new Error(`Clip render command failed. ${summarizeExecError(execError)}`);
        }
        throw new Error("Clip render command finished without producing a video file.");
    }

    return {
        filePath: renderedFile.fullPath,
        warning: execError ? summarizeExecError(execError) : "",
    };
}

async function tryGetYouTubeTranscript(videoUrl, preferredLanguage) {
    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) return null;
    if (process.env.ENABLE_YOUTUBE_TRANSCRIPT === "false") return null;

    const cacheKey = buildYouTubeTranscriptCacheKey(videoId, preferredLanguage);
    const cached = getCachedYouTubeTranscript(cacheKey);
    if (cached) {
        return {
            ...cached,
            cacheHit: true,
        };
    }

    const explicitLangs = [preferredLanguage, process.env.YOUTUBE_TRANSCRIPT_LANG]
        .map((value) => String(value || "").trim())
        .filter(Boolean);

    const langAttempts = [];
    for (const lang of explicitLangs) {
        if (!langAttempts.includes(lang)) {
            langAttempts.push(lang);
        }
    }
    langAttempts.push(null);
    if (!langAttempts.includes("en")) {
        langAttempts.push("en");
    }

    const providerAttempts = [
        { name: "yt-dlp", run: (lang) => fetchYouTubeTranscriptViaYtDlp(videoId, videoUrl, lang) },
    ];

    // Optional legacy providers if yt-dlp fails and this flag is explicitly enabled.
    if (process.env.ENABLE_LEGACY_YOUTUBE_PROVIDERS === "true") {
        providerAttempts.push(
            { name: "youtube-transcript", run: (lang) => fetchYouTubeTranscriptWithLibrary(videoId, lang) },
            { name: "watch-page", run: (lang) => fetchYouTubeTranscriptViaWatchPage(videoId, lang) }
        );
    }

    const errors = [];
    for (const provider of providerAttempts) {
        // yt-dlp already tries multiple language patterns in one call; avoid rerunning it per language.
        const langsForProvider = provider.name === "yt-dlp"
            ? [langAttempts[0] || null]
            : langAttempts;

        for (const lang of langsForProvider) {
            try {
                const transcript = await provider.run(lang);
                const result = {
                    ...transcript,
                    providerUsed: transcript.providerUsed || provider.name,
                    cacheHit: false,
                };
                setCachedYouTubeTranscript(cacheKey, result);
                return result;
            } catch (error) {
                errors.push(`${provider.name}:${lang || "auto"}: ${cleanYouTubeErrorMessage(error)}`);
            }
        }
    }

    throw new Error(`No usable YouTube captions found. Attempts: ${errors.join(" | ")}`.slice(0, 3000));
}

exports.generateClips = onCall({ cors: true }, async (request) => {
    try {
        const { videoUrl, videoTitle, contentType } = request.data || {};
        const apiKey = ensureOpenAiApiKey();

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        const normalizedContentType = normalizeContentType(contentType);
        const profileInstruction = CONTENT_PROFILE_INSTRUCTIONS[normalizedContentType];

        const userPrompt = [
            "You are an expert short-form video editor.",
            `Content profile: ${normalizedContentType}.`,
            profileInstruction,
            `Video title: ${videoTitle || "Untitled Video"}.`,
            `Video reference URL: ${videoUrl}.`,
            `Return exactly ${TARGET_CLIP_COUNT} top highlight clips if possible.`,
            "Each clip must include title, startTimestamp, endTimestamp, description, viralScore.",
            "Timestamp format must be MM:SS.",
            "Return strict JSON in this shape only:",
            '{"clips":[{"title":"...","startTimestamp":"MM:SS","endTimestamp":"MM:SS","description":"...","viralScore":87}]}',
        ].join("\n");

        const parsed = await requestStructuredJson({
            apiKey,
            systemPrompt: "You produce structured highlight recommendations for clip extraction.",
            userPrompt,
            temperature: 0.3,
        });

        const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
        const clips = applyClipRules(rawClips);

        if (clips.length === 0) {
            throw new Error("No valid clips returned by model.");
        }

        console.log(`Generated ${clips.length} clips for ${videoTitle || "Untitled"} (${normalizedContentType})`);

        return {
            success: true,
            contentType: normalizedContentType,
            clips,
        };
    } catch (error) {
        console.error("Error generating clips:", error);
        throw new HttpsError("internal", "An error occurred while generating clips.", error.message);
    }
});

exports.checkTranscriptAvailability = onCall(
    { cors: true, timeoutSeconds: 300, memory: "1GiB" },
    async (request) => {
    try {
        const { videoUrl, transcriptLanguage } = request.data || {};

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        if (!isLikelyYouTubeUrl(videoUrl)) {
            return {
                success: true,
                provider: "openai_only",
                isYouTube: false,
                hasCaptions: false,
                message: "URL is not a YouTube link. Transcript generation will use OpenAI.",
            };
        }

        if (process.env.ENABLE_YOUTUBE_TRANSCRIPT === "false") {
            return {
                success: true,
                provider: "youtube_caption",
                isYouTube: true,
                hasCaptions: false,
                message: "YouTube caption provider is disabled by environment configuration.",
            };
        }

        try {
            const transcript = await tryGetYouTubeTranscript(videoUrl, transcriptLanguage);
            return {
                success: true,
                provider: "youtube_caption",
                isYouTube: true,
                hasCaptions: true,
                videoId: transcript.videoId,
                providerUsed: transcript.providerUsed,
                languageUsed: transcript.languageUsed,
                cacheHit: Boolean(transcript.cacheHit),
                segmentCount: transcript.segments.length,
                message: `YouTube captions are available via ${transcript.providerUsed} (${transcript.segments.length} segments, lang ${transcript.languageUsed}${transcript.cacheHit ? ", cache hit" : ""}).`,
            };
        } catch (error) {
            return {
                success: true,
                provider: "youtube_caption",
                isYouTube: true,
                hasCaptions: false,
                message: `YouTube captions unavailable: ${error.message}`,
            };
        }
    } catch (error) {
        console.error("Error checking transcript availability:", error);
        throw new HttpsError("internal", "An error occurred while checking transcript availability.", error.message);
    }
});

exports.downloadRenderedClip = onRequest(
    { cors: true, timeoutSeconds: 300, memory: "1GiB" },
    async (request, response) => {
        try {
            await cleanupExpiredRenderedClips();

            const token = String(request.query?.token || "").trim();
            if (!token) {
                response.status(400).json({ error: "Missing token." });
                return;
            }

            const entry = await loadRenderedClipEntry(token);
            if (!entry) {
                response.status(404).json({ error: "Clip not found or expired." });
                return;
            }

            const stats = await fs.stat(entry.filePath).catch(() => null);
            if (!stats || !stats.isFile()) {
                await removeRenderedClipArtifacts(token, entry);
                response.status(404).json({ error: "Clip file is unavailable." });
                return;
            }

            response.setHeader("Content-Type", entry.mimeType);
            response.setHeader("Content-Disposition", `attachment; filename="${entry.fileName}"`);
            response.setHeader("Content-Length", String(stats.size));
            response.setHeader("Cache-Control", "private, max-age=0, no-store");

            const stream = createReadStream(entry.filePath);
            stream.on("error", (error) => {
                console.error("Error streaming rendered clip:", error);
                if (!response.headersSent) {
                    response.status(500).json({ error: "Failed to read clip file." });
                } else {
                    response.end();
                }
            });
            stream.pipe(response);
        } catch (error) {
            console.error("Error downloading rendered clip:", error);
            response.status(500).json({ error: "Failed to download rendered clip." });
        }
    }
);

exports.renderYouTubeClips = onCall(
    { cors: true, timeoutSeconds: 540, memory: "2GiB" },
    async (request) => {
        try {
            await cleanupExpiredRenderedClips();

            const { videoUrl, clips } = request.data || {};
            if (!videoUrl || !isLikelyYouTubeUrl(videoUrl)) {
                throw new HttpsError("invalid-argument", "A valid YouTube videoUrl is required.");
            }

            if (!Array.isArray(clips) || clips.length === 0) {
                throw new HttpsError("invalid-argument", "At least one clip range is required.");
            }

            const limitedRawClips = clips.slice(0, Math.max(1, MAX_RENDER_CLIPS_PER_REQUEST));
            const normalizedClips = limitedRawClips.map((clip, index) => normalizeClipForRender(clip, index));

            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-render-"));
            const rendered = [];
            const failures = [];

            try {
                for (let index = 0; index < normalizedClips.length; index += 1) {
                    const clip = normalizedClips[index];
                    try {
                        const result = await renderYouTubeClipSegment({
                            videoUrl,
                            clip,
                            tempDir,
                            index,
                        });

                        const storedClip = await storeRenderedClipFile({
                            sourcePath: result.filePath,
                            clipTitle: clip.title,
                            index,
                        });

                        rendered.push({
                            title: clip.title,
                            startTimestamp: clip.startTimestamp,
                            endTimestamp: clip.endTimestamp,
                            fileName: storedClip.fileName,
                            downloadUrl: buildDownloadUrlForRequest(request, storedClip.token),
                            renderSource: "youtube_section_download",
                            expiresAt: new Date(storedClip.expiresAt).toISOString(),
                            warning: result.warning || "",
                        });
                    } catch (error) {
                        failures.push({
                            clipIndex: index + 1,
                            title: clip.title,
                            error: cleanYouTubeErrorMessage(error),
                        });
                    }
                }
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }

            if (rendered.length === 0) {
                const detail = failures[0]?.error || "All clip renders failed.";
                throw new HttpsError("internal", `Unable to render clips. ${detail}`);
            }

            return {
                success: true,
                renderedCount: rendered.length,
                failureCount: failures.length,
                clips: rendered,
                failures,
                clipsTruncated: clips.length > limitedRawClips.length,
                maxRenderClips: Math.max(1, MAX_RENDER_CLIPS_PER_REQUEST),
            };
        } catch (error) {
            console.error("Error rendering YouTube clips:", error);
            if (error instanceof HttpsError) throw error;
            throw new HttpsError("internal", "An error occurred while rendering YouTube clips.", error.message);
        }
    }
);

exports.alignTranscriptSelection = onCall(
    { cors: true, timeoutSeconds: 540, memory: "2GiB" },
    async (request) => {
        try {
            const {
                videoUrl,
                startTimestamp,
                endTimestamp,
                selectedText,
                transcriptLanguage,
                bufferSeconds,
                alignmentProvider,
            } = request.data || {};

            if (!videoUrl || !isLikelyYouTubeUrl(videoUrl)) {
                throw new HttpsError("invalid-argument", "A valid YouTube videoUrl is required for precision alignment.");
            }

            const startSeconds = parseTimestampToSeconds(startTimestamp);
            const endSeconds = parseTimestampToSeconds(endTimestamp);
            if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
                throw new HttpsError("invalid-argument", "Valid startTimestamp and endTimestamp are required.");
            }

            const alignmentProviderRequested = normalizeAlignmentProvider(alignmentProvider);
            let alignmentProviderUsed = ALIGNMENT_PROVIDER_OPENAI;
            let alignmentProviderFallbackMessage = "";
            const normalizedBuffer = clampNumber(
                Number.isFinite(Number(bufferSeconds)) ? Number(bufferSeconds) : PRECISION_ALIGN_BUFFER_SECONDS,
                3,
                45
            );
            const maxWindowSeconds = Math.max(
                20,
                Math.min(PRECISION_ALIGN_MAX_WINDOW_SECONDS, MAX_RENDER_SECONDS_PER_CLIP)
            );
            const minSelectionLength = Math.max(0.5, PRECISION_ALIGN_MIN_SELECTION_SECONDS);

            const selectionStart = Math.max(0, startSeconds);
            const selectionEnd = Math.max(selectionStart + minSelectionLength, endSeconds);
            const selectionDuration = selectionEnd - selectionStart;

            let windowStart = Math.max(0, selectionStart - normalizedBuffer);
            let windowEnd = selectionEnd + normalizedBuffer;
            if (windowEnd - windowStart > maxWindowSeconds) {
                const center = (selectionStart + selectionEnd) / 2;
                const halfWindow = maxWindowSeconds / 2;
                windowStart = Math.max(0, center - halfWindow);
                windowEnd = windowStart + maxWindowSeconds;
            }
            if (windowEnd - windowStart < selectionDuration + 1) {
                windowEnd = windowStart + selectionDuration + 1;
            }

            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "precision-align-"));
            try {
                const clip = normalizeClipForRender({
                    title: "precision-align",
                    startTimestamp: formatSecondsToTimestamp(windowStart),
                    endTimestamp: formatSecondsToTimestamp(windowEnd),
                }, 0);

                const renderedWindow = await renderYouTubeClipSegment({
                    videoUrl,
                    clip,
                    tempDir,
                    index: 0,
                    timeoutMs: PRECISION_ALIGN_RENDER_TIMEOUT_MS,
                });
                const audioPath = await extractAudioTrackForTranscription({
                    sourceVideoPath: renderedWindow.filePath,
                    tempDir,
                });
                let waveform = null;
                try {
                    const waveformPeaks = await extractWaveformPeaks({
                        audioFilePath: audioPath,
                        targetBins: 1400,
                    });
                    waveform = {
                        ...waveformPeaks,
                        windowStartSeconds: Number(clip.startSeconds.toFixed(3)),
                        windowEndSeconds: Number(clip.endSeconds.toFixed(3)),
                        windowStartTimestamp: formatSecondsToTimestamp(clip.startSeconds),
                        windowEndTimestamp: formatSecondsToTimestamp(clip.endSeconds),
                    };
                } catch (waveformError) {
                    console.warn("Unable to compute waveform peaks for precision alignment:", cleanYouTubeErrorMessage(waveformError));
                }
                const fallbackStartInWindow = Math.max(0, selectionStart - clip.startSeconds);
                const fallbackEndInWindow = Math.max(
                    fallbackStartInWindow + minSelectionLength,
                    selectionEnd - clip.startSeconds
                );
                let stableOutcome = null;
                let stableFailureReason = "";
                const shouldTryStable = (
                    alignmentProviderRequested === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL ||
                    alignmentProviderRequested === ALIGNMENT_PROVIDER_AB_COMPARE
                );
                if (shouldTryStable) {
                    try {
                        const stableTranscription = await requestStableTsAudioTranscription({
                            audioFilePath: audioPath,
                            language: transcriptLanguage,
                            selectedText,
                        });
                        stableOutcome = buildAlignmentOutcomeFromTranscription({
                            transcription: stableTranscription,
                            selectedText,
                            fallbackStartSeconds: fallbackStartInWindow,
                            fallbackEndSeconds: fallbackEndInWindow,
                            providerId: ALIGNMENT_PROVIDER_STABLE_TS_LOCAL,
                            providerLabel: "stable-ts local",
                        });
                    } catch (stableError) {
                        stableFailureReason = String(stableError?.message || stableError || "").trim();
                        console.warn("stable-ts local alignment attempt failed:", stableFailureReason);
                    }
                }

                let baselineOpenAiOutcome = null;
                const strictStableOnlyMode = (
                    alignmentProviderRequested === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL &&
                    STABLE_TS_DISABLE_OPENAI_FALLBACK
                );
                const shouldRunOpenAi = (
                    alignmentProviderRequested === ALIGNMENT_PROVIDER_OPENAI ||
                    alignmentProviderRequested === ALIGNMENT_PROVIDER_AB_COMPARE ||
                    (!stableOutcome && !strictStableOnlyMode)
                );
                if (shouldRunOpenAi) {
                    const apiKey = ensureOpenAiApiKey();
                    const openAiTranscription = await requestOpenAiAudioTranscription({
                        apiKey,
                        audioFilePath: audioPath,
                        selectedText,
                        language: transcriptLanguage,
                    });
                    baselineOpenAiOutcome = buildAlignmentOutcomeFromTranscription({
                        transcription: openAiTranscription,
                        selectedText,
                        fallbackStartSeconds: fallbackStartInWindow,
                        fallbackEndSeconds: fallbackEndInWindow,
                        providerId: ALIGNMENT_PROVIDER_OPENAI,
                        providerLabel: "OpenAI fast",
                    });
                }

                if (strictStableOnlyMode && !stableOutcome) {
                    const reason = stableFailureReason || "stable-ts local runtime unavailable.";
                    throw new Error(`High Accuracy (Local) failed with no OpenAI fallback. Reason: ${reason}`.slice(0, 1800));
                }

                if (!baselineOpenAiOutcome && !stableOutcome) {
                    throw new Error("No alignment provider produced a valid result.");
                }

                let selectedOutcome = baselineOpenAiOutcome || stableOutcome;
                if (alignmentProviderRequested === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL) {
                    if (stableOutcome) {
                        selectedOutcome = stableOutcome;
                        alignmentProviderUsed = ALIGNMENT_PROVIDER_STABLE_TS_LOCAL;
                    } else if (baselineOpenAiOutcome) {
                        selectedOutcome = baselineOpenAiOutcome;
                        alignmentProviderUsed = ALIGNMENT_PROVIDER_OPENAI;
                        const reason = stableFailureReason || "stable-ts local runtime unavailable.";
                        alignmentProviderFallbackMessage = `High Accuracy (Local) unavailable. Used Fast OpenAI alignment instead. Reason: ${reason}`.slice(0, 600);
                    }
                } else if (alignmentProviderRequested === ALIGNMENT_PROVIDER_AB_COMPARE) {
                    if (baselineOpenAiOutcome && stableOutcome) {
                        selectedOutcome = stableOutcome.metrics.weightedScore >= baselineOpenAiOutcome.metrics.weightedScore
                            ? stableOutcome
                            : baselineOpenAiOutcome;
                        alignmentProviderUsed = selectedOutcome.providerId;
                    } else if (baselineOpenAiOutcome) {
                        selectedOutcome = baselineOpenAiOutcome;
                        alignmentProviderUsed = ALIGNMENT_PROVIDER_OPENAI;
                        const reason = stableFailureReason || "stable-ts local runtime unavailable.";
                        alignmentProviderFallbackMessage = `A/B compare used Fast OpenAI baseline only. High Accuracy local unavailable. Reason: ${reason}`.slice(0, 600);
                    } else if (stableOutcome) {
                        selectedOutcome = stableOutcome;
                        alignmentProviderUsed = ALIGNMENT_PROVIDER_STABLE_TS_LOCAL;
                    }
                } else {
                    selectedOutcome = baselineOpenAiOutcome || stableOutcome;
                    alignmentProviderUsed = selectedOutcome?.providerId || ALIGNMENT_PROVIDER_OPENAI;
                    if (alignmentProviderUsed === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL && !baselineOpenAiOutcome) {
                        alignmentProviderFallbackMessage = "Fast OpenAI alignment unavailable. Used local stable-ts output.";
                    }
                }

                if (!selectedOutcome || !selectedOutcome.alignment || !Array.isArray(selectedOutcome.wordTimeline)) {
                    throw new Error("Selected alignment outcome is invalid.");
                }
                const alignment = selectedOutcome.alignment;
                const wordTimeline = selectedOutcome.wordTimeline;

                const alignedStartSeconds = clampNumber(
                    clip.startSeconds + alignment.startSeconds,
                    clip.startSeconds,
                    clip.endSeconds - minSelectionLength
                );
                const alignedEndSeconds = clampNumber(
                    clip.startSeconds + alignment.endSeconds,
                    alignedStartSeconds + minSelectionLength,
                    clip.endSeconds
                );
                const alignedStartInWindow = Math.max(0, alignedStartSeconds - clip.startSeconds);
                const alignedEndInWindow = Math.max(alignedStartInWindow + 0.02, alignedEndSeconds - clip.startSeconds);

                const alignedWordCues = wordTimeline
                    .map((word, index) => {
                        const text = String(word?.token || "").trim();
                        if (!text) return null;

                        const rawWordStart = Number(word?.startSeconds);
                        const rawWordEnd = Number(word?.endSeconds);
                        if (!Number.isFinite(rawWordStart) || !Number.isFinite(rawWordEnd)) return null;

                        const windowStart = Math.max(alignedStartInWindow, rawWordStart);
                        const windowEnd = Math.min(alignedEndInWindow, rawWordEnd);
                        if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) return null;

                        const sourceStartSeconds = clip.startSeconds + windowStart;
                        const sourceEndSeconds = clip.startSeconds + windowEnd;
                        const relativeStart = sourceStartSeconds - alignedStartSeconds;
                        const relativeEnd = sourceEndSeconds - alignedStartSeconds;
                        if (!Number.isFinite(relativeStart) || !Number.isFinite(relativeEnd) || relativeEnd <= relativeStart) return null;

                        return {
                            id: `word-${index + 1}`,
                            text,
                            startSeconds: Number(relativeStart.toFixed(3)),
                            endSeconds: Number(relativeEnd.toFixed(3)),
                            sourceStartSeconds: Number(sourceStartSeconds.toFixed(3)),
                            sourceEndSeconds: Number(sourceEndSeconds.toFixed(3)),
                        };
                    })
                    .filter(Boolean)
                    .slice(0, Math.max(50, MAX_CAPTION_CUES_PER_ITEM));

                const alignmentComparison = {
                    mode: alignmentProviderRequested,
                    baseline: baselineOpenAiOutcome
                        ? {
                            provider: ALIGNMENT_PROVIDER_OPENAI,
                            confidence: Number(baselineOpenAiOutcome.metrics.confidence || 0),
                            coverage: Number(baselineOpenAiOutcome.metrics.coverage || 0),
                            similarity: Number(baselineOpenAiOutcome.metrics.similarity || 0),
                            strategy: String(baselineOpenAiOutcome.metrics.strategy || "unknown"),
                            model: String(baselineOpenAiOutcome.modelUsed || OPENAI_TRANSCRIBE_MODEL),
                            timedWordCount: Number(baselineOpenAiOutcome.timedWordCount || 0),
                        }
                        : null,
                    candidate: alignmentProviderRequested === ALIGNMENT_PROVIDER_AB_COMPARE
                        ? (
                            stableOutcome
                                ? {
                                    provider: ALIGNMENT_PROVIDER_STABLE_TS_LOCAL,
                                    available: true,
                                    confidence: Number(stableOutcome.metrics.confidence || 0),
                                    coverage: Number(stableOutcome.metrics.coverage || 0),
                                    similarity: Number(stableOutcome.metrics.similarity || 0),
                                    strategy: String(stableOutcome.metrics.strategy || "unknown"),
                                    model: String(stableOutcome.modelUsed || STABLE_TS_MODEL),
                                    timedWordCount: Number(stableOutcome.timedWordCount || 0),
                                }
                                : {
                                    provider: ALIGNMENT_PROVIDER_STABLE_TS_LOCAL,
                                    available: false,
                                    reason: stableFailureReason ? "stable_ts_local_error" : "stable_ts_local_not_configured",
                                    message: String(stableFailureReason || "stable-ts local unavailable"),
                                }
                        )
                        : null,
                    bestProvider: String(selectedOutcome.providerId || ALIGNMENT_PROVIDER_OPENAI),
                };

                return {
                    success: true,
                    provider: selectedOutcome.providerId === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL
                        ? "stable_ts_local_transcription"
                        : "openai_audio_transcription",
                    model: String(
                        selectedOutcome.modelUsed ||
                        (selectedOutcome.providerId === ALIGNMENT_PROVIDER_STABLE_TS_LOCAL ? STABLE_TS_MODEL : OPENAI_TRANSCRIBE_MODEL)
                    ),
                    timedWordCount: Number(selectedOutcome.timedWordCount || 0),
                    alignmentProviderRequested,
                    alignmentProviderUsed,
                    alignmentProviderFallbackMessage,
                    alignmentComparison,
                    alignedStartSeconds,
                    alignedEndSeconds,
                    alignedStartTimestamp: formatSecondsToTimestamp(alignedStartSeconds),
                    alignedEndTimestamp: formatSecondsToTimestamp(alignedEndSeconds),
                    matchConfidence: Number(selectedOutcome.metrics.confidence || 0),
                    matchCoverage: Number(selectedOutcome.metrics.coverage || 0),
                    matchAverageSimilarity: Number(selectedOutcome.metrics.similarity || 0),
                    matchProximity: Number(selectedOutcome.metrics.proximity || 0),
                    matchStrategy: String(selectedOutcome.metrics.strategy || "unknown"),
                    matchedText: String(alignment.matchedText || "").slice(0, 400),
                    wordCount: wordTimeline.length,
                    windowStartSeconds: clip.startSeconds,
                    windowEndSeconds: clip.endSeconds,
                    windowStartTimestamp: formatSecondsToTimestamp(clip.startSeconds),
                    windowEndTimestamp: formatSecondsToTimestamp(clip.endSeconds),
                    alignedWordCues,
                    alignedWordCount: alignedWordCues.length,
                    waveform,
                };
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }
        } catch (error) {
            console.error("Error aligning transcript selection:", error);
            if (error instanceof HttpsError) throw error;
            throw new HttpsError("internal", "An error occurred while aligning transcript selection.", error.message);
        }
    }
);

exports.renderTimelineEdits = onCall(
    { cors: true, timeoutSeconds: 540, memory: "2GiB" },
    async (request) => {
        try {
            await cleanupExpiredRenderedClips();

            const { mode, items, montageTitle } = request.data || {};
            const normalizedMode = String(mode || "individual").toLowerCase() === "group" ? "group" : "individual";

            if (!Array.isArray(items) || items.length === 0) {
                throw new HttpsError("invalid-argument", "At least one timeline clip item is required.");
            }

            const limitedItems = items.slice(0, Math.max(1, MAX_TIMELINE_RENDER_ITEMS));
            if (normalizedMode === "group" && limitedItems.length < 2) {
                throw new HttpsError("invalid-argument", "At least 2 timeline clip items are required for group render.");
            }
            const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "timeline-edit-"));
            const failures = [];
            const renderedSegments = [];

            try {
                for (let index = 0; index < limitedItems.length; index += 1) {
                    const item = limitedItems[index];
                    const clipTitle = String(item?.title || `Edited Clip ${index + 1}`).trim() || `Edited Clip ${index + 1}`;

                    try {
                        const token = extractRenderedClipToken(item?.token || item?.downloadUrl || item?.url);
                        if (!token) {
                            throw new Error("Item does not reference a valid rendered clip token.");
                        }

                        const sourceEntry = await loadRenderedClipEntry(token);
                        if (!sourceEntry) {
                            throw new Error("Source clip not found or expired. Re-render the source clip first.");
                        }

                        const rendered = await renderEditedClipSegment({
                            sourcePath: sourceEntry.filePath,
                            trimStartSeconds: Number(item?.trimStartSeconds) || 0,
                            trimEndSeconds: item?.trimEndSeconds,
                            effectsPreset: item?.effectsPreset,
                            effectsIntensity: item?.effectsIntensity,
                            captionCues: item?.captionEnabled === false ? [] : item?.captionCues,
                            captionStylePreset: item?.captionStylePreset,
                            tempDir,
                            index,
                        });

                        renderedSegments.push({
                            ...rendered,
                            title: clipTitle,
                        });
                    } catch (error) {
                        failures.push({
                            clipIndex: index + 1,
                            title: clipTitle,
                            error: String(error?.message || "Timeline render item failed."),
                        });
                    }
                }

                if (renderedSegments.length === 0) {
                    const detail = failures[0]?.error || "No clips could be rendered.";
                    throw new HttpsError("internal", `Unable to render edits. ${detail}`);
                }

                if (normalizedMode === "group") {
                    const montagePath = await concatEditedClipFiles({
                        clipPaths: renderedSegments.map((entry) => entry.filePath),
                        tempDir,
                    });

                    const storedMontage = await storeRenderedClipFile({
                        sourcePath: montagePath,
                        clipTitle: String(montageTitle || "Montage").trim() || "Montage",
                        index: 0,
                    });

                    return {
                        success: true,
                        mode: "group",
                        montage: {
                            fileName: storedMontage.fileName,
                            downloadUrl: buildDownloadUrlForRequest(request, storedMontage.token),
                            expiresAt: new Date(storedMontage.expiresAt).toISOString(),
                            clipCount: renderedSegments.length,
                        },
                        renderedCount: renderedSegments.length,
                        failureCount: failures.length,
                        failures,
                        clipsTruncated: items.length > limitedItems.length,
                        maxTimelineRenderItems: Math.max(1, MAX_TIMELINE_RENDER_ITEMS),
                    };
                }

                const clips = [];
                for (let index = 0; index < renderedSegments.length; index += 1) {
                    const segment = renderedSegments[index];
                    const storedClip = await storeRenderedClipFile({
                        sourcePath: segment.filePath,
                        clipTitle: `${segment.title}-edited`,
                        index,
                    });

                    clips.push({
                        title: segment.title,
                        startTimestamp: formatSecondsToTimestamp(segment.startSeconds),
                        endTimestamp: formatSecondsToTimestamp(segment.endSeconds),
                        fileName: storedClip.fileName,
                        downloadUrl: buildDownloadUrlForRequest(request, storedClip.token),
                        renderSource: "timeline_edit",
                        expiresAt: new Date(storedClip.expiresAt).toISOString(),
                    });
                }

                return {
                    success: true,
                    mode: "individual",
                    clips,
                    renderedCount: clips.length,
                    failureCount: failures.length,
                    failures,
                    clipsTruncated: items.length > limitedItems.length,
                    maxTimelineRenderItems: Math.max(1, MAX_TIMELINE_RENDER_ITEMS),
                };
            } finally {
                await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }
        } catch (error) {
            console.error("Error rendering timeline edits:", error);
            if (error instanceof HttpsError) throw error;
            throw new HttpsError("internal", "An error occurred while rendering timeline edits.", error.message);
        }
    }
);

exports.generateTranscript = onCall({ cors: true }, async (request) => {
    try {
        const {
            videoUrl,
            videoTitle,
            contentType,
            transcriptLanguage,
            allowOpenAiFallback,
            forceOpenAiTranscript,
        } = request.data || {};

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        const normalizedContentType = normalizeContentType(contentType);
        const profileInstruction = CONTENT_PROFILE_INSTRUCTIONS[normalizedContentType];
        const canUseOpenAiFallback = allowOpenAiFallback !== false;
        const shouldForceOpenAiTranscript = forceOpenAiTranscript === true;
        let youtubeFailureReason = "";

        if (!shouldForceOpenAiTranscript) {
            try {
                const youtubeTranscript = await tryGetYouTubeTranscript(videoUrl, transcriptLanguage);
                if (youtubeTranscript && youtubeTranscript.segments.length > 0) {
                    console.log(
                        `Using YouTube transcript provider ${youtubeTranscript.providerUsed} (${youtubeTranscript.segments.length} segments, ${youtubeTranscript.languageUsed}${youtubeTranscript.cacheHit ? ", cache hit" : ""}) for ${videoTitle || "Untitled"}`
                    );
                    return {
                        success: true,
                        contentType: normalizedContentType,
                        transcriptSource: "youtube_caption",
                        transcriptProviderUsed: youtubeTranscript.providerUsed,
                        transcriptLanguageUsed: youtubeTranscript.languageUsed,
                        cacheHit: Boolean(youtubeTranscript.cacheHit),
                        segments: youtubeTranscript.segments,
                    };
                }
            } catch (youtubeError) {
                youtubeFailureReason = youtubeError.message || "Unknown YouTube caption error.";
                console.warn("YouTube transcript provider failed.", youtubeError.message);
            }
        }

        if (!canUseOpenAiFallback && isLikelyYouTubeUrl(videoUrl) && !shouldForceOpenAiTranscript) {
            throw new HttpsError(
                "failed-precondition",
                `YouTube captions were not available and AI fallback is disabled. ${youtubeFailureReason}`.trim()
            );
        }

        if (shouldForceOpenAiTranscript) {
            console.log(`Using forced OpenAI transcript mode for ${videoTitle || "Untitled"}.`);
        } else if (isLikelyYouTubeUrl(videoUrl)) {
            console.log(`Falling back to OpenAI transcript for ${videoTitle || "Untitled"} because YouTube captions were unavailable.`);
        }

        const apiKey = ensureOpenAiApiKey();

        const userPrompt = [
            "You are creating a timestamped transcript index for highlight editing.",
            `Content profile: ${normalizedContentType}.`,
            profileInstruction,
            `Video title: ${videoTitle || "Untitled Video"}.`,
            `Video reference URL: ${videoUrl}.`,
            "Produce a concise transcript timeline with many short timestamped segments.",
            "Each segment must include: startTimestamp, endTimestamp, speaker, text.",
            "Timestamp format must be MM:SS.",
            "Return strict JSON in this shape only:",
            '{"segments":[{"startTimestamp":"MM:SS","endTimestamp":"MM:SS","speaker":"Host","text":"..."}]}',
        ].join("\n");

        const parsed = await requestStructuredJson({
            apiKey,
            systemPrompt: "You generate structured transcript segments with accurate timestamp ordering.",
            userPrompt,
            temperature: 0.2,
        });

        const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
        const segments = applyTranscriptRules(rawSegments, TRANSCRIPT_MAX_SEGMENTS_OPENAI);

        if (segments.length === 0) {
            throw new Error("No valid transcript segments returned by model.");
        }

        console.log(`Generated ${segments.length} transcript segments for ${videoTitle || "Untitled"} (${normalizedContentType})`);

        return {
            success: true,
            contentType: normalizedContentType,
            transcriptSource: "openai_fallback",
            segments,
        };
    } catch (error) {
        console.error("Error generating transcript:", error);
        throw new HttpsError("internal", "An error occurred while generating transcript.", error.message);
    }
});
