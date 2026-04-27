cat > src/trigger/podcast-processing-pipeline.ts << 'ENDOFFILE'
import { task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

const VOICE_MAP: Record<string, string> = {
  "Spanish": "haaEg4BqiAAwDT7ahTxl",
  "default": "haaEg4BqiAAwDT7ahTxl",
};

async function translateChunk(text: string, targetLanguage: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a professional translator. Return only the translated text." },
        { role: "user", content: `Translate this into ${targetLanguage}:\n\n${text}` },
      ],
      temperature: 0.2,
    }),
  });
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || "";
}

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

export const podcastOrchestrator = task({
  id: "podcast-orchestrator",
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
    console.log("[STEP 2] SUBMITTING AUDIO");

    const audioUrl = payload.audioUrl || "https://storage.googleapis.com/aai-docs-samples/espn.m4a";
    const targetLanguage = payload.targetLanguage || "Spanish";
    const voiceId = VOICE_MAP[targetLanguage] || VOICE_MAP["default"];

    console.log("[STEP 2] TARGET LANGUAGE:", targetLanguage, "VOICE ID:", voiceId);

    const submitResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        Authorization: ASSEMBLYAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        speech_models: ["universal-2"],
      }),
    });

    const submitJson = await submitResponse.json();
    console.log("[STEP 2.1] ASSEMBLYAI SUBMIT RESPONSE", JSON.stringify(submitJson));

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
        throw new Error("AssemblyAI transcription error: " + pollJson.error);
      }
    }

    console.log("[STEP 4] TRANSLATING IN CHUNKS");
    const chunks = splitIntoChunks(transcriptText, 3000);
    console.log("[STEP 4.1] TOTAL CHUNKS:", chunks.length);

    const translatedChunks: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log("[STEP 4.2] TRANSLATING CHUNK " + (i + 1) + "/" + chunks.length);
      const translated = await translateChunk(chunks[i], targetLanguage, OPENAI_API_KEY);
      translatedChunks.push(translated);
      await new Promise((r) => setTimeout(r, 1000));
    }

    const translationText = translatedChunks.join(" ");
    console.log("[STEP 4.3] TRANSLATION DONE, LENGTH:", translationText.length);

    console.log("[STEP 5] GENERATING DUBBED AUDIO WITH VOICE:", voiceId);

    const elevenRes = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: translationText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.3,
            similarity_boost: 0.85,
          },
        }),
      }
    );

    if (!elevenRes.ok) {
      const errorText = await elevenRes.text();
      throw new Error("ElevenLabs error: " + errorText);
    }

    const audioArrayBuffer = await elevenRes.arrayBuffer();
    console.log("[STEP 5.1] DUBBED AUDIO GENERATED, SIZE:", audioArrayBuffer.byteLength);

    console.log("[STEP 6] UPLOADING TO SUPABASE");

    const fileName = "jobs/" + (payload.episodeId || "test") + "/final/dubbed_" + Date.now() + ".mp3";

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, audioArrayBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new Error("Supabase upload error: " + uploadError.message);
    }

    const { data: publicData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(fileName);

    const finalAudioUrl = publicData.publicUrl;
    console.log("[STEP 6.1] UPLOADED TO SUPABASE:", finalAudioUrl);
    console.log("[STEP 7] PIPELINE COMPLETE");

    return {
      transcript: transcriptText,
      translation: translationText,
      final_audio_url: finalAudioUrl,
    };
  },
});
ENDOFFILE