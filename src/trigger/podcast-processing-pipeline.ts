import { task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

const VOICE_MAP: Record<string, string> = {
  "Spanish": "haaEg4BqiAAwDT7ahTxl",
  "default": "haaEg4BqiAAwDT7ahTxl",
};

function splitIntoChunks(text: string, maxChars: number): string[] {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      if (lastPeriod > start) end = lastPeriod + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

async function translateChunk(text: string, targetLanguage: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a professional translator. Return only the translated text." },
        { role: "user", content: "Translate this into " + targetLanguage + ":\n\n" + text },
      ],
      temperature: 0.2,
    }),
  });
  const json = await res.json();
  if (!json.choices?.[0]?.message?.content) {
    throw new Error("OpenAI chunk translation failed: " + JSON.stringify(json));
  }
  return json.choices[0].message.content.trim();
}

async function dubChunk(text: string, voiceId: string, apiKey: string): Promise<ArrayBuffer> {
  const res = await fetch(
    "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.3, similarity_boost: 0.85 },
      }),
    }
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error("ElevenLabs error: " + errorText);
  }
  return res.arrayBuffer();
}

export const podcastOrchestrator = task({
  id: "podcast-orchestrator",
  machine: "medium-1x",
  run: async (payload: any) => {
    const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY!;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    const ELEVENLABS_API_KEY = process.env.ELEVENLAB_API_KEY!;
    const SUPABASE_URL = process.env.SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const BUCKET = process.env.SUPABASE_BUCKET_NAME!;

    if (!ASSEMBLYAI_API_KEY) throw new Error("Missing ASSEMBLYAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
    if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLAB_API_KEY");
    if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
    if (!SUPABASE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    if (!BUCKET) throw new Error("Missing SUPABASE_BUCKET_NAME");

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    console.log("[STEP 1] ROOT TASK ENTERED", payload);

    const audioUrl = payload.audioUrl || "https://storage.googleapis.com/aai-docs-samples/espn.m4a";
    const targetLanguage = payload.targetLanguage || "Spanish";
    const voiceId = VOICE_MAP[targetLanguage] || VOICE_MAP["default"];
    const previewMode = payload.previewMode === true;

    console.log("[STEP 2] SUBMITTING AUDIO, TARGET:", targetLanguage, "VOICE:", voiceId, "PREVIEW:", previewMode);

    const transcriptBody: any = {
      audio_url: audioUrl,
      speech_models: ["universal-2"],
    };

    if (previewMode) {
      transcriptBody.audio_end_at = 180000;
      console.log("[STEP 2] PREVIEW MODE - limiting to first 3 minutes");
    }

    const submitResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        Authorization: ASSEMBLYAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transcriptBody),
    });

    const submitJson = await submitResponse.json();
    const transcriptId = submitJson.id;
    if (!transcriptId) {
      throw new Error("No transcript ID returned: " + JSON.stringify(submitJson));
    }

    console.log("[STEP 3] POLLING FOR TRANSCRIPT", transcriptId);
    let transcriptText = "";

    while (true) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResponse = await fetch(
        "https://api.assemblyai.com/v2/transcript/" + transcriptId,
        { headers: { Authorization: ASSEMBLYAI_API_KEY } }
      );
      const pollJson: any = await pollResponse.json();
      console.log("[STEP 3.1] POLL STATUS", pollJson.status);
      if (pollJson.status === "completed") {
        transcriptText = pollJson.text;
        console.log("[STEP 3.2] TRANSCRIPT DONE, LENGTH:", transcriptText.length);
        break;
      }
      if (pollJson.status === "error") {
        throw new Error("AssemblyAI error: " + pollJson.error);
      }
    }

    console.log("[STEP 4] TRANSLATING IN CHUNKS");
    const translateChunks = splitIntoChunks(transcriptText, 2000);
    console.log("[STEP 4.1] TRANSLATION CHUNKS:", translateChunks.length);

    const translatedParts: string[] = [];
    for (let i = 0; i < translateChunks.length; i++) {
      console.log("[STEP 4.2] TRANSLATING CHUNK " + (i + 1) + "/" + translateChunks.length);
      const translated = await translateChunk(translateChunks[i], targetLanguage, OPENAI_API_KEY);
      translatedParts.push(translated);
      await new Promise((r) => setTimeout(r, 500));
    }
    const translationText = translatedParts.join(" ");
    console.log("[STEP 4.3] TRANSLATION DONE, LENGTH:", translationText.length);

    console.log("[STEP 5] DUBBING AND UPLOADING CHUNKS");
    const dubChunks = splitIntoChunks(translationText, 5000);
    console.log("[STEP 5.1] DUB CHUNKS:", dubChunks.length);

    const chunkUrls: string[] = [];
    for (let i = 0; i < dubChunks.length; i++) {
      console.log("[STEP 5.2] DUBBING CHUNK " + (i + 1) + "/" + dubChunks.length);
      const buf = await dubChunk(dubChunks[i], voiceId, ELEVENLABS_API_KEY);

      const chunkFileName = "jobs/" + (payload.episodeId || "test") + "/chunks/chunk_" + i + "_" + Date.now() + ".mp3";
      const { error: chunkUploadError } = await supabase.storage
        .from(BUCKET)
        .upload(chunkFileName, new Uint8Array(buf), {
          contentType: "audio/mpeg",
          upsert: true,
        });

      if (chunkUploadError) {
        throw new Error("Supabase chunk upload error: " + chunkUploadError.message);
      }

      const { data: chunkPublicData } = supabase.storage.from(BUCKET).getPublicUrl(chunkFileName);
      chunkUrls.push(chunkPublicData.publicUrl);
      console.log("[STEP 5.3] CHUNK " + (i + 1) + " UPLOADED");

      await new Promise((r) => setTimeout(r, 500));
    }

    console.log("[STEP 6] ALL CHUNKS UPLOADED, TOTAL:", chunkUrls.length);
    console.log("[STEP 7] PIPELINE COMPLETE");

    return {
      transcript: transcriptText,
      translation: translationText,
      final_audio_url: chunkUrls[0],
      audio_chunks: chunkUrls,
    };
  },
});