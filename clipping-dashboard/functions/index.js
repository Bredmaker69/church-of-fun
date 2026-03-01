const { onCall, HttpsError } = require("firebase-functions/v2/https");
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const TARGET_CLIP_COUNT = Number(process.env.CLIP_TARGET_COUNT || 3);
const MIN_CLIP_SECONDS = Number(process.env.CLIP_MIN_SECONDS || 8);
const MAX_CLIP_SECONDS = Number(process.env.CLIP_MAX_SECONDS || 45);
const DEFAULT_CLIP_SECONDS = Number(process.env.CLIP_DEFAULT_SECONDS || 20);
const MIN_CLIP_GAP_SECONDS = Number(process.env.CLIP_MIN_GAP_SECONDS || 1);

function parseTimestampToSeconds(value) {
    const text = String(value || "").trim();
    const parts = text.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) {
        return null;
    }
    if (parts.length === 2) {
        return Math.max(0, parts[0] * 60 + parts[1]);
    }
    if (parts.length === 3) {
        return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    }
    return null;
}

function formatSecondsToTimestamp(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
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
        startSeconds: baseStart,
        endSeconds: boundedEnd,
        startTimestamp: formatSecondsToTimestamp(baseStart),
        endTimestamp: formatSecondsToTimestamp(boundedEnd),
        description: String(clip.description || "").trim(),
        viralScore: Number.isFinite(viralScore) ? Math.max(1, Math.min(100, viralScore)) : 50,
    };
}

function validateClip(clip) {
    return (
        clip.title.length > 0 &&
        Number.isFinite(clip.startSeconds) &&
        Number.isFinite(clip.endSeconds) &&
        clip.endSeconds > clip.startSeconds &&
        clip.description.length > 0 &&
        Number.isFinite(clip.viralScore)
    );
}

function applyClipRules(clips) {
    const normalized = clips
        .map((clip, index) => normalizeClip(clip, index))
        .filter(validateClip)
        .sort((a, b) => {
            if (a.startSeconds !== b.startSeconds) return a.startSeconds - b.startSeconds;
            return b.viralScore - a.viralScore;
        });

    const deduped = [];
    let previousEnd = -Infinity;

    for (const clip of normalized) {
        let start = Math.max(clip.startSeconds, previousEnd + MIN_CLIP_GAP_SECONDS);
        let end = Math.max(clip.endSeconds, start + MIN_CLIP_SECONDS);
        if (end - start > MAX_CLIP_SECONDS) {
            end = start + MAX_CLIP_SECONDS;
        }

        const adjusted = {
            ...clip,
            startSeconds: start,
            endSeconds: end,
            startTimestamp: formatSecondsToTimestamp(start),
            endTimestamp: formatSecondsToTimestamp(end),
        };

        deduped.push(adjusted);
        previousEnd = end;
        if (deduped.length >= TARGET_CLIP_COUNT) break;
    }

    return deduped.map((clip) => ({
        title: clip.title,
        startTimestamp: clip.startTimestamp,
        endTimestamp: clip.endTimestamp,
        description: clip.description,
        viralScore: clip.viralScore,
    }));
}

async function requestClipSuggestions({ apiKey, prompt }) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: "You produce structured JSON output for clip extraction."
                },
                {
                    role: "user",
                    content: prompt
                }
            ]
        })
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

    return content;
}

exports.generateClips = onCall({ cors: true }, async (request) => {
    try {
        const { videoUrl, videoTitle } = request.data;

        if (!process.env.OPENAI_API_KEY) {
            throw new HttpsError("failed-precondition", "Missing OPENAI_API_KEY in Functions runtime.");
        }

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        console.log(`Starting processing for: ${videoTitle} at ${videoUrl}`);

        const prompt = [
            "You are an expert video editor and social media strategist.",
            `Video title: ${videoTitle || "Untitled Video"}.`,
            `Video reference URL: ${videoUrl}.`,
            "Analyze this video reference and identify the 3 most engaging clip moments.",
            "Return strict JSON only in this shape:",
            '{"clips":[{"title":"...","startTimestamp":"MM:SS","endTimestamp":"MM:SS","description":"...","viralScore":87}]}',
            "No markdown, no code fences, no extra keys."
        ].join("\n");

        const responseText = await requestClipSuggestions({
            apiKey: process.env.OPENAI_API_KEY,
            prompt
        });
        const parsed = JSON.parse(responseText);
        const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
        const clips = applyClipRules(rawClips);

        if (clips.length === 0) {
            throw new Error("No valid clips returned by model.");
        }

        console.log("Successfully generated clips:", clips.length);

        return {
            success: true,
            clips
        };

    } catch (error) {
        console.error("Error generating clips:", error);
        throw new HttpsError("internal", "An error occurred while generating clips.", error.message);
    }
});
