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
  }),
});

const transcriptData: any = await transcriptResponse.json();
console.log("[STEP 3.1] TRANSCRIPT RESPONSE", transcriptData);
const transcriptId = transcriptData.id;
console.log("[STEP 3.15] TRANSCRIPT ID", transcriptId);
if (!transcriptId) {
  throw new Error("No transcript ID returned");
}

let transcriptText = "";

while (true) {
  await new Promise((r) => setTimeout(r, 3000));

 const pollResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
  headers: {
    Authorization: ASSEMBLYAI_API_KEY,
  },
});
const pollData: any = await pollResponse.json();
const pollJson: any = await pollResponse.json();
console.log("[STEP 3.2] POLL STATUS", pollJson.status);

if (pollData.status === "completed") {
  console.log("[STEP 3.3] TRANSCRIPTION DONE");
  break;
}

if (pollData.status === "error") {
  throw new Error(`AssemblyAI failed: ${pollData.error}`);
}

  if (pollJson.status === "completed") {
    transcriptText = pollJson.text;
    break;
  }

  if (pollJson.status === "error") {
    throw new Error(`AssemblyAI failed: ${pollJson.error}`);
  }
}

console.log("[STEP 3.3] TRANSCRIPTION DONE", transcriptText.length);

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
const translationText = openaiJson.choices?.[0]?.message?.content?.trim();

if (!translationText) {
  throw new Error("OpenAI returned empty translation");
}

console.log("[STEP 4.1] TRANSLATION DONE", translationText.length);

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
