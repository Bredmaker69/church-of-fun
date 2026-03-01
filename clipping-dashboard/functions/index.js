const { onCall, HttpsError } = require("firebase-functions/v2/https");

const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const TARGET_CLIP_COUNT = Number(process.env.CLIP_TARGET_COUNT || 3);
const MIN_CLIP_SECONDS = Number(process.env.CLIP_MIN_SECONDS || 8);
const MAX_CLIP_SECONDS = Number(process.env.CLIP_MAX_SECONDS || 45);
const DEFAULT_CLIP_SECONDS = Number(process.env.CLIP_DEFAULT_SECONDS || 20);
const MIN_CLIP_GAP_SECONDS = Number(process.env.CLIP_MIN_GAP_SECONDS || 1);
const TRANSCRIPT_MIN_SEGMENT_SECONDS = Number(process.env.TRANSCRIPT_MIN_SEGMENT_SECONDS || 2);
const TRANSCRIPT_MAX_SEGMENT_SECONDS = Number(process.env.TRANSCRIPT_MAX_SEGMENT_SECONDS || 25);
const TRANSCRIPT_MAX_SEGMENTS = Number(process.env.TRANSCRIPT_MAX_SEGMENTS || 120);

const CONTENT_PROFILE_INSTRUCTIONS = {
    generic: "Prioritize engaging moments with clear hooks, emotional spikes, and concise standalone context.",
    sports: "Prioritize key plays, scoring moments, momentum swings, announcer hype, and crowd reaction energy.",
    gaming: "Prioritize clutch plays, wins/losses, surprising moments, strong reactions, and high-energy commentary.",
    podcast: "Prioritize quotable insights, controversial takes, emotional stories, and concise standalone ideas.",
};

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

function applyTranscriptRules(rawSegments) {
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

        if (shaped.length >= TRANSCRIPT_MAX_SEGMENTS) break;
    }

    return shaped;
}

function ensureOpenAiApiKey() {
    if (!process.env.OPENAI_API_KEY) {
        throw new HttpsError("failed-precondition", "Missing OPENAI_API_KEY in Functions runtime.");
    }
    return process.env.OPENAI_API_KEY;
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

exports.generateTranscript = onCall({ cors: true }, async (request) => {
    try {
        const { videoUrl, videoTitle, contentType } = request.data || {};
        const apiKey = ensureOpenAiApiKey();

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        const normalizedContentType = normalizeContentType(contentType);
        const profileInstruction = CONTENT_PROFILE_INSTRUCTIONS[normalizedContentType];

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
        const segments = applyTranscriptRules(rawSegments);

        if (segments.length === 0) {
            throw new Error("No valid transcript segments returned by model.");
        }

        console.log(`Generated ${segments.length} transcript segments for ${videoTitle || "Untitled"} (${normalizedContentType})`);

        return {
            success: true,
            contentType: normalizedContentType,
            segments,
        };
    } catch (error) {
        console.error("Error generating transcript:", error);
        throw new HttpsError("internal", "An error occurred while generating transcript.", error.message);
    }
});
