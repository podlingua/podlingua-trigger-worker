import { task } from "@trigger.dev/sdk";



const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

if (!ASSEMBLYAI_API_KEY) {
  throw new Error("Missing ASSEMBLYAI_API_KEY");
}
export const podcastProcessingPipeline = task({
  id: "podcast-processing-pipeline",
  run: async (payload) => {
    const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!ASSEMBLYAI_API_KEY) {
      throw new Error("Missing ASSEMBLYAI_API_KEY");
    }

    if (!OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    console.log("[STEP 1] ROOT TASK ENTERED");

    // rest of your code...
  },
});
export const podcastOrchestrator = task({
  id: "podcast-processing-pipeline",
  run: async (payload: any, { ctx }) => {
    console.log("[STEP 1] ROOT TASK ENTERED", payload);

    try {
      // =========================
      // STEP 2: DOWNLOAD AUDIO
      // =========================
      console.log("[STEP 2] START DOWNLOAD");

      const audioUrl = payload.audioUrl;

      const response = await fetch(audioUrl);
      console.log("[STEP 2.1] DOWNLOAD STATUS", response.status);

      const audioBuffer = await response.arrayBuffer();
      console.log("[STEP 2.2] AUDIO DOWNLOADED", audioBuffer.byteLength);

      // =========================
      // STEP 3: TRANSCRIPTION
      // =========================
     console.log("[STEP 3] START TRANSCRIPTION");

const transcriptResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
  method: "POST",
  headers: {
    Authorization: ASSEMBLYAI_API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    audio_url: audioUrl,
    speech_model: "best", // ✅ fixed field name
  }),
});

console.log("[STEP 3.0] TRANSCRIPT HTTP STATUS", transcriptResponse.status);

const transcriptText = await transcriptResponse.text(); // ✅ actually reads the response
console.log("[STEP 3.1] TRANSCRIPT RAW RESPONSE", transcriptText);

let transcriptData: any;
try {
  transcriptData = JSON.parse(transcriptText);
} catch {
  throw new Error(`AssemblyAI returned non-JSON: ${transcriptText}`);
}
      // =========================
      // STEP 4: TRANSLATION
      // =========================
      console.log("[STEP 4] START TRANSLATION");

const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  },
  body: JSON.stringify({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: "You are a professional translator. Return only the translated text.",
      },
      {
        role: "user",
        content: `Translate this into ${payload.dialect || payload.targetLanguage || "Spanish"}:\n\n${transcriptText}`,
      },
    ],
    temperature: 0.2,
  }),
});

const openaiJson = await openaiRes.json();
console.log("[STEP 4.0] OPENAI RAW RESPONSE", JSON.stringify(openaiJson)); // 👈 add this
const translationText = openaiJson.choices?.[0]?.message?.content?.trim();

if (!translationText) {
  throw new Error("OpenAI returned empty translation");
}

      // =========================
      // STEP 5: FINISH
      // =========================
      console.log("[STEP 5] PIPELINE COMPLETE");

return {
  transcript: transcriptText,
  translation: translationText,
};

    } catch (error) {
      console.error("[ERROR] PIPELINE FAILED", error);
      throw error;
    }
  },
});
