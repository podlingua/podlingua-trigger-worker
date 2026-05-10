import { task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import ffmpegStatic from "ffmpeg-static";

const VOICE_MAP: Record<string, string> = {
  "Spanish": "haaEg4BqiAAwDT7ahTxl",
  "French": "mVjOqyqTPfwlXPjV5sjX",
  "default": "haaEg4BqiAAwDT7ahTxl",
};

const TEST_MODE_AUDIO_URL = "https://storage.googleapis.com/aai-docs-samples/espn.m4a";

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

function isDirectAudioUrl(url: string): boolean {
  const audioExtensions = [".mp3", ".m4a", ".wav", ".ogg", ".aac", ".flac"];
  try {
    const parsed = new URL(url);
    return audioExtensions.some(ext => parsed.pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

function installYtDlp(): void {
  try {
    execSync("which yt-dlp", { stdio: "pipe" });
    console.log("[YT-DLP] Already installed");
    return;
  } catch {}

  console.log("[YT-DLP] Installing via wget...");
  try {
    execSync(
      "wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /tmp/yt-dlp && chmod a+rx /tmp/yt-dlp",
      { timeout: 60000, stdio: "pipe" }
    );
    console.log("[YT-DLP] Installed via wget");
    return;
  } catch {}

  console.log("[YT-DLP] Installing via pip3...");
  try {
    execSync("pip3 install yt-dlp", { timeout: 120000, stdio: "pipe" });
    console.log("[YT-DLP] Installed via pip3");
    return;
  } catch {}

  throw new Error("Failed to install yt-dlp — curl, wget, and pip3 all unavailable");
}

function getYtDlpPath(): string {
  try {
    return execSync("which yt-dlp", { stdio: "pipe" }).toString().trim();
  } catch {
    return "/tmp/yt-dlp";
  }
}

async function extractAudioWithYtDlp(url: string, supabase: any, bucket: string, episodeId: string): Promise<string> {
  installYtDlp();
  const ytDlpPath = getYtDlpPath();
  const tmpDir = "/tmp";
  const outputTemplate = join(tmpDir, "audio_" + episodeId + ".%(ext)s");

  console.log("[YT-DLP] Extracting audio from:", url);

  try {
    execSync(
      ytDlpPath + " --extract-audio --audio-format mp3 --audio-quality 0 --no-playlist -o " +
      JSON.stringify(outputTemplate) + " " + JSON.stringify(url),
      { timeout: 300000, stdio: "pipe" }
    );
  } catch (err: any) {
    throw new Error("yt-dlp failed to extract audio: " + (err.stderr?.toString() || err.message));
  }

  const outputPath = join(tmpDir, "audio_" + episodeId + ".mp3");
  if (!existsSync(outputPath)) {
    throw new Error("yt-dlp did not produce an output file at " + outputPath);
  }

  const audioBuffer = readFileSync(outputPath);
  console.log("[YT-DLP] Audio extracted, size:", audioBuffer.byteLength);

  const fileName = "jobs/" + episodeId + "/source/audio.mp3";
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(fileName, audioBuffer, { contentType: "audio/mpeg", upsert: true });

  if (uploadError) {
    throw new Error("Failed to upload extracted audio to Supabase: " + uploadError.message);
  }

  try { unlinkSync(outputPath); } catch {}

  const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(fileName);
  console.log("[YT-DLP] Audio uploaded to Supabase:", publicData.publicUrl);
  return publicData.publicUrl;
}

function mergeAudioChunks(chunkPaths: string[], outputPath: string): void {
  console.log("[FFMPEG] Merging", chunkPaths.length, "chunks into", outputPath);

  const listFilePath = "/tmp/chunks_list.txt";
  const listContent = chunkPaths.map(p => "file '" + p + "'").join("\n");
  writeFileSync(listFilePath, listContent);

  const ffmpegPath = ffmpegStatic as unknown as string;

  try {
    execSync(
      ffmpegPath + " -f concat -safe 0 -i " + listFilePath + " -c copy " + outputPath + " -y",
      { timeout: 300000, stdio: "pipe" }
    );
    console.log("[FFMPEG] Merge complete");
  } catch (err: any) {
    throw new Error("ffmpeg merge failed: " + (err.stderr?.toString() || err.message));
  } finally {
    try { unlinkSync(listFilePath); } catch {}
  }
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

    let audioUrl = payload.audioUrl || "https://storage.googleapis.com/aai-docs-samples/espn.m4a";
    const targetLanguage = payload.targetLanguage || "Spanish";
    const voiceId = VOICE_MAP[targetLanguage] || VOICE_MAP["default"];
    const previewMode = payload.previewMode === true;
    const testMode = payload.testMode === true;
    const episodeId = payload.episodeId || "test";

    console.log("[STEP 1] TEST MODE:", testMode, "PREVIEW MODE:", previewMode);

    console.log("[STEP 2] CHECKING AUDIO URL:", audioUrl);

    if (!isDirectAudioUrl(audioUrl)) {
      console.log("[STEP 2] NOT A DIRECT AUDIO URL - using yt-dlp to extract");
      audioUrl = await extractAudioWithYtDlp(audioUrl, supabase, BUCKET, episodeId);
    } else {
      console.log("[STEP 2] DIRECT AUDIO URL - skipping yt-dlp");
    }

    console.log("[STEP 3] SUBMITTING TO ASSEMBLYAI, TARGET:", targetLanguage, "VOICE:", voiceId, "PREVIEW:", previewMode);

    const transcriptBody: any = {
      audio_url: audioUrl,
      speech_models: ["universal-2"],
    };

    if (previewMode) {
      transcriptBody.audio_end_at = 180000;
      console.log("[STEP 3] PREVIEW MODE - limiting to first 3 minutes");
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

    console.log("[STEP 4] POLLING FOR TRANSCRIPT", transcriptId);
    let transcriptText = "";

    while (true) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResponse = await fetch(
        "https://api.assemblyai.com/v2/transcript/" + transcriptId,
        { headers: { Authorization: ASSEMBLYAI_API_KEY } }
      );
      const pollJson: any = await pollResponse.json();
      console.log("[STEP 4.1] POLL STATUS", pollJson.status);
      if (pollJson.status === "completed") {
        transcriptText = pollJson.text;
        console.log("[STEP 4.2] TRANSCRIPT DONE, LENGTH:", transcriptText.length);
        break;
      }
      if (pollJson.status === "error") {
        throw new Error("AssemblyAI error: " + pollJson.error);
      }
    }

    console.log("[STEP 5] TRANSLATING IN CHUNKS");
    const translateChunks = splitIntoChunks(transcriptText, 2000);
    console.log("[STEP 5.1] TRANSLATION CHUNKS:", translateChunks.length);

    const translatedParts: string[] = [];
    for (let i = 0; i < translateChunks.length; i++) {
      console.log("[STEP 5.2] TRANSLATING CHUNK " + (i + 1) + "/" + translateChunks.length);
      const translated = await translateChunk(translateChunks[i], targetLanguage, OPENAI_API_KEY);
      translatedParts.push(translated);
      await new Promise((r) => setTimeout(r, 500));
    }
    const translationText = translatedParts.join(" ");
    console.log("[STEP 5.3] TRANSLATION DONE, LENGTH:", translationText.length);

    if (testMode) {
      console.log("[STEP 6] TEST MODE — skipping ElevenLabs dubbing");
      console.log("[STEP 7] PIPELINE COMPLETE (TEST MODE)");
      return {
        transcript: transcriptText,
        translation: translationText,
        final_audio_url: TEST_MODE_AUDIO_URL,
        audio_chunks: [TEST_MODE_AUDIO_URL],
        test_mode: true,
      };
    }

    console.log("[STEP 6] DUBBING CHUNKS");
    const dubChunks = splitIntoChunks(translationText, 5000);
    console.log("[STEP 6.1] DUB CHUNKS:", dubChunks.length);

    const chunkPaths: string[] = [];
    for (let i = 0; i < dubChunks.length; i++) {
      console.log("[STEP 6.2] DUBBING CHUNK " + (i + 1) + "/" + dubChunks.length);
      const buf = await dubChunk(dubChunks[i], voiceId, ELEVENLABS_API_KEY);

      const chunkPath = "/tmp/chunk_" + episodeId + "_" + i + ".mp3";
      writeFileSync(chunkPath, Buffer.from(buf));
      chunkPaths.push(chunkPath);
      console.log("[STEP 6.3] CHUNK " + (i + 1) + " SAVED TO DISK");

      await new Promise((r) => setTimeout(r, 500));
    }

    console.log("[STEP 7] MERGING CHUNKS WITH FFMPEG");
    const mergedPath = "/tmp/merged_" + episodeId + ".mp3";
    mergeAudioChunks(chunkPaths, mergedPath);

    // Clean up chunk files
    for (const chunkPath of chunkPaths) {
      try { unlinkSync(chunkPath); } catch {}
    }

    console.log("[STEP 8] UPLOADING MERGED FILE TO SUPABASE");
    const mergedBuffer = readFileSync(mergedPath);
    const fileName = "jobs/" + episodeId + "/final/dubbed_" + Date.now() + ".mp3";

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, mergedBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new Error("Supabase upload error: " + uploadError.message);
    }

    try { unlinkSync(mergedPath); } catch {}

    const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
    const finalAudioUrl = publicData.publicUrl;
    console.log("[STEP 8.1] UPLOADED:", finalAudioUrl);
    console.log("[STEP 9] PIPELINE COMPLETE");

    return {
      transcript: transcriptText,
      translation: translationText,
      final_audio_url: finalAudioUrl,
      audio_chunks: [finalAudioUrl],
    };
  },
});