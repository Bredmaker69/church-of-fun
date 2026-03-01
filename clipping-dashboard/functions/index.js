const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { GoogleGenAI } = require("@google/genai");

// Initialize Gemini SDK. Note: You must ensure GEMINI_API_KEY is available in your deployment environment.
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

exports.generateClips = onCall({ cors: true }, async (request) => {
    try {
        const { videoUrl, videoTitle } = request.data;

        if (!videoUrl) {
            throw new HttpsError("invalid-argument", "The function must be called with a 'videoUrl'.");
        }

        console.log(`Starting processing for: ${videoTitle} at ${videoUrl}`);

        const prompt = `
            You are an expert video editor and social media manager.
            I am providing you with a video file: ${videoTitle}.

            Analyze this video and identify the top 3 most engaging, viral-worthy moments.
            For each moment, return:
            1. A catchy title.
            2. The start timestamp (in MM:SS format).
            3. The end timestamp (in MM:SS format).
            4. A short description of why it's engaging.
            5. A viral "score" from 1-100.

            You MUST strictly return the response as a valid JSON array of objects.
        `;

        // We use gemini-3.0-pro as the default powerful model for multimodal tasks
        const response = await ai.models.generateContent({
            model: "gemini-3.0-pro",
            contents: [
                prompt,
                // In a real scenario, we would download or pass the actual file bytes/URI to the model here.
                // For demonstration, we simulate passing the video via text reference.
                { text: `[Simulated Video Content Reference: ${videoUrl}]` }
            ],
            config: {
                responseMimeType: "application/json",
            }
        });

        const jsonString = response.text;
        const parsedClips = JSON.parse(jsonString);

        console.log("Successfully generated clips:", parsedClips.length);

        return {
            success: true,
            clips: parsedClips
        };

    } catch (error) {
        console.error("Error generating clips:", error);
        throw new HttpsError("internal", "An error occurred while generating clips.", error.message);
    }
});
