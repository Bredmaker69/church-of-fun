const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { YoutubeTranscript } = require("youtube-transcript");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

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
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function normalizeCaptionText(text) {
    return decodeHtmlEntities(String(text || ""))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
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

function toTranscriptResult(entries, meta) {
    const rawSegments = entries.map((entry) => ({
        startTimestamp: formatSecondsToTimestamp(entry.offset),
        endTimestamp: formatSecondsToTimestamp(entry.offset + entry.duration),
        speaker: "Caption",
        text: entry.text,
    }));

    const segments = applyTranscriptRules(rawSegments);
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
        : "en.*,en,all,-live_chat";

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-captions-"));
    try {
        const cookiesFromBrowser = String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
        const args = [
            "--no-update",
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

        await execFileAsync("yt-dlp", args, {
            cwd: tempDir,
            timeout: 45000,
            maxBuffer: 20 * 1024 * 1024,
        });

        const fileNames = await fs.readdir(tempDir);
        const vttFiles = rankSubtitleFiles(
            fileNames.filter((name) => name.toLowerCase().endsWith(".vtt")),
            preferredLanguage
        );

        if (vttFiles.length === 0) {
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

        throw new Error("yt-dlp subtitle files contained no transcript text.");
    } catch (error) {
        throw new Error(`yt-dlp provider failed: ${summarizeExecError(error)}`);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function tryGetYouTubeTranscript(videoUrl, preferredLanguage) {
    const videoId = extractYouTubeVideoId(videoUrl);
    if (!videoId) return null;
    if (process.env.ENABLE_YOUTUBE_TRANSCRIPT === "false") return null;

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
        { name: "youtube-transcript", run: (lang) => fetchYouTubeTranscriptWithLibrary(videoId, lang) },
        { name: "watch-page", run: (lang) => fetchYouTubeTranscriptViaWatchPage(videoId, lang) },
        { name: "yt-dlp", run: (lang) => fetchYouTubeTranscriptViaYtDlp(videoId, videoUrl, lang) },
    ];

    const errors = [];
    for (const provider of providerAttempts) {
        // yt-dlp already tries multiple language patterns in one call; avoid running it per language.
        const langsForProvider = provider.name === "yt-dlp"
            ? [langAttempts[0] || null]
            : langAttempts;

        for (const lang of langsForProvider) {
            try {
                const transcript = await provider.run(lang);
                return {
                    ...transcript,
                    providerUsed: transcript.providerUsed || provider.name,
                };
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
                segmentCount: transcript.segments.length,
                message: `YouTube captions are available via ${transcript.providerUsed} (${transcript.segments.length} segments, lang ${transcript.languageUsed}).`,
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

exports.generateTranscript = onCall({ cors: true }, async (request) => {
    try {
        const {
            videoUrl,
            videoTitle,
            contentType,
            transcriptLanguage,
            allowOpenAiFallback,
        } = request.data || {};

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        const normalizedContentType = normalizeContentType(contentType);
        const profileInstruction = CONTENT_PROFILE_INSTRUCTIONS[normalizedContentType];
        const canUseOpenAiFallback = allowOpenAiFallback !== false;
        let youtubeFailureReason = "";

        try {
            const youtubeTranscript = await tryGetYouTubeTranscript(videoUrl, transcriptLanguage);
            if (youtubeTranscript && youtubeTranscript.segments.length > 0) {
                console.log(
                    `Using YouTube transcript provider ${youtubeTranscript.providerUsed} (${youtubeTranscript.segments.length} segments, ${youtubeTranscript.languageUsed}) for ${videoTitle || "Untitled"}`
                );
                return {
                    success: true,
                    contentType: normalizedContentType,
                    transcriptSource: "youtube_caption",
                    transcriptProviderUsed: youtubeTranscript.providerUsed,
                    transcriptLanguageUsed: youtubeTranscript.languageUsed,
                    segments: youtubeTranscript.segments,
                };
            }
        } catch (youtubeError) {
            youtubeFailureReason = youtubeError.message || "Unknown YouTube caption error.";
            console.warn("YouTube transcript provider failed.", youtubeError.message);
        }

        if (!canUseOpenAiFallback && isLikelyYouTubeUrl(videoUrl)) {
            throw new HttpsError(
                "failed-precondition",
                `YouTube captions were not available and AI fallback is disabled. ${youtubeFailureReason}`.trim()
            );
        }

        if (isLikelyYouTubeUrl(videoUrl)) {
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
        const segments = applyTranscriptRules(rawSegments);

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
