import { task } from "@trigger.dev/sdk/v3";

export const podcastOrchestrator = task({
  id: "podcast-orchestrator",
  run: async (payload: any) => {
    const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY!;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;

    if (!ASSEMBLYAI_API_KEY) throw new Error("Missing ASSEMBLYAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
    if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");

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
        {
          headers: { Authorization: ASSEMBLYAI_API_KEY },
        }
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
    console.log("[STEP 4.1] OPENAI RESPONSE", JSON.stringify(openaiJson));

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
    const audioBase64 = Buffer.from(audioArrayBuffer).toString("base64");

    console.log("[STEP 5.1] DUBBED AUDIO GENERATED, SIZE:", audioArrayBuffer.byteLength);
    console.log("[STEP 5] PIPELINE COMPLETE");

    return {
      transcript: transcriptText,
      translation: translationText,
      dubbedAudioBase64: audioBase64,
    };
  },
});