const fs = require("node:fs");
const crypto = require("node:crypto");

const SPEECH_CLEANUP_PRESETS = new Set(["light", "medium", "strong"]);
const DEFAULT_SPEECH_CLEANUP_PRESET = "medium";

function normalizeSpeechCleanupPreset(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return SPEECH_CLEANUP_PRESETS.has(normalized) ? normalized : DEFAULT_SPEECH_CLEANUP_PRESET;
}

function buildSpeechCleanupAudioFilter({ preset, modelPath }) {
    const normalizedPreset = normalizeSpeechCleanupPreset(preset);
    const resolvedModelPath = String(modelPath || "").trim();
    if (resolvedModelPath && fs.existsSync(resolvedModelPath)) {
        const escapedModelPath = resolvedModelPath
            .replace(/\\/g, "\\\\")
            .replace(/:/g, "\\:")
            .replace(/'/g, "\\'");
        const mixByPreset = {
            light: "0.45",
            medium: "0.72",
            strong: "1.0",
        };
        return {
            filter: `highpass=f=70,lowpass=f=14000,arnndn=m='${escapedModelPath}':mix=${mixByPreset[normalizedPreset]},alimiter=limit=0.93`,
            engine: "arnndn",
        };
    }

    const nrByPreset = {
        light: 10,
        medium: 18,
        strong: 26,
    };
    const nfByPreset = {
        light: -28,
        medium: -24,
        strong: -20,
    };
    return {
        filter: `highpass=f=70,lowpass=f=14000,afftdn=nr=${nrByPreset[normalizedPreset]}:nf=${nfByPreset[normalizedPreset]}:tn=1,alimiter=limit=0.93`,
        engine: "afftdn",
    };
}

function buildSpeechCleanupCacheKey({ sourcePath, preset, engine, version = "v1" }) {
    return crypto
        .createHash("sha1")
        .update([String(sourcePath || ""), normalizeSpeechCleanupPreset(preset), String(engine || ""), version].join("|"))
        .digest("hex");
}

function getSpeechCleanupProxyFileName({ key, preset, extension = ".m4a" }) {
    return `speech-cleanup-${normalizeSpeechCleanupPreset(preset)}-${key}${extension}`;
}

function normalizeSpeechCleanupMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "on" || normalized === "off" || normalized === "inherit") return normalized;
    return "inherit";
}

module.exports = {
    DEFAULT_SPEECH_CLEANUP_PRESET,
    buildSpeechCleanupAudioFilter,
    buildSpeechCleanupCacheKey,
    getSpeechCleanupProxyFileName,
    normalizeSpeechCleanupMode,
    normalizeSpeechCleanupPreset,
};
