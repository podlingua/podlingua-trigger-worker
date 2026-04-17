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

      const pollResponse = await fetch(`https://api.assemblyai.com/v2/transcript/$