const { onCall, HttpsError } = require("firebase-functions/v2/https");
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function normalizeClip(clip) {
    const viralScore = Number(clip.viralScore);
    return {
        title: String(clip.title || "").trim(),
        startTimestamp: String(clip.startTimestamp || "").trim(),
        endTimestamp: String(clip.endTimestamp || "").trim(),
        description: String(clip.description || "").trim(),
        viralScore: Number.isFinite(viralScore) ? Math.max(1, Math.min(100, viralScore)) : 50,
    };
}

function validateClip(clip) {
    return (
        clip.title.length > 0 &&
        /^\d{2}:\d{2}$/.test(clip.startTimestamp) &&
        /^\d{2}:\d{2}$/.test(clip.endTimestamp) &&
        clip.description.length > 0 &&
        Number.isFinite(clip.viralScore)
    );
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
        const clips = rawClips.map(normalizeClip).filter(validateClip).slice(0, 3);

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
