import { task } from "@trigger.dev/sdk/v3";

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

    console.log("[STEP 1] ROOT TASK ENTERED", payload);
    console.log("[STEP 2] SUBMITTING AUDIO");

    const audioUrl = payload.audioUrl || "https://storage.googleapis.com/aai-docs-samples/espn.m4a";

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
      throw new Error(`No transcript ID returned: ${JSON.stringify(submitJson)}`);
    }

    console.log("[STEP 3] POLLING FOR TRANSCRIPT", transcriptId);
    let transcriptText = "";

    while (true) {
      await new Promise((r) => setTimeout(r, 3000));

      const pollResponse = await fetch(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
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
        throw new Error(`AssemblyAI transcription error: ${pollJson.error}`);
      }
    }

    console.log("[STEP 4] TRANSLATING");

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
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
            content: `Translate this into ${payload.targetLanguage || "Spanish"}:\n\n${transcriptText}`,
          },
        ],
        temperature: 0.2,
      }),
    });

    const openaiJson = await openaiRes.json();
    const translationText = openaiJson.choices?.[0]?.message?.content?.trim();
    if (!translationText) {
      throw new Error(`OpenAI returned empty translation. Full response: ${JSON.stringify(openaiJson)}`);
    }

    console.log("[STEP 4.2] TRANSLATION DONE, LENGTH:", translationText.length);

    console.log("[STEP 5] GENERATING DUBBED AUDIO");

    const elevenRes = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM",
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
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!elevenRes.ok) {
      const errorText = await elevenRes.text();
      throw new Error(`ElevenLabs error: ${errorText}`);
    }

    const audioArrayBuffer = await elevenRes.arrayBuffer();
    console.log("[STEP 5.1] DUBBED AUDIO GENERATED, SIZE:", audioArrayBuffer.byteLength);

    // STEP 6: UPLOAD TO SUPABASE
    console.log("[STEP 6] UPLOADING TO SUPABASE");

    const fileName = `dubbed_${Date.now()}.mp3`;
    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${fileName}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "audio/mpeg",
        },
        body: audioArrayBuffer,
      }
    );

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Supabase upload error: ${errorText}`);
    }

    const finalAudioUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${fileName}`;
    console.log("[STEP 6.1] UPLOADED TO SUPABASE:", finalAudioUrl);

    console.log("[STEP 7] PIPELINE COMPLETE");

    return {
      transcript: transcriptText,
      translation: translationText,
      final_audio_url: finalAudioUrl,
    };
  },
});