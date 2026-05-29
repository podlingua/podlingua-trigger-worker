import { task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Voice Pools ─────────────────────────────────────────────────────────────

const SPANISH_VOICE_POOL = [
  "MQOw6rAjjxLeifjqjuCo", // El Faraon - M
  "DVckUv1C6yTiOFMjZW4e", // Dora Lanarra - F
  "p7AwDmKvTdoHTBuueGvP", // Malena - F
  "haaEg4BqiAAwDT7ahTxl", // Roderick - M
];

const FRENCH_VOICE_POOL = [
  "mVjOqyqTPfwlXPjV5sjX",
];

const CHINESE_VOICE_POOL = [
  "agczkAUlHLowaNnL72Cc", // Adrian
];

const GERMAN_VOICE_POOL = [
  "VHYWoxffK1pFlM1dtRb0",
];

const ENGLISH_VOICE_POOL = [
  "TYKLc7ViOIGE13dSZYlK", // Rachel - F
  "BuaKXS4Sv1Mccaw3flfU", // Christina - F
  "nzFihrBIvB34imQBuxub", // Josh - M
  "7WggD3IoWTIPT19PNyrW", // Jarnathan - M
];

function getVoicePool(targetLanguage: string): string[] {
  if (targetLanguage === "Spanish") return SPANISH_VOICE_POOL;
  if (targetLanguage === "French") return FRENCH_VOICE_POOL;
  if (targetLanguage === "Chinese") return CHINESE_VOICE_POOL;
  if (targetLanguage === "German") return GERMAN_VOICE_POOL;
  if (targetLanguage === "English") return ENGLISH_VOICE_POOL;
  return SPANISH_VOICE_POOL;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_MODE_AUDIO_URL = "https://storage.googleapis.com/aai-docs-samples/espn.m4a";
const TRANSLATION_BATCH_SIZE = 5;
const DUB_BATCH_SIZE = 5;
const MAX_CHARS_PER_CHUNK = 2000;

// ─── Types ───────────────────────────────────────────────────────────────────

type SpeakerChunk = { speaker: string; text: string; start: number };

// ─── Text Chunking ───────────────────────────────────────────────────────────

function splitTextIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
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

function buildSpeakerChunks(utterances: any[], maxChars: number): SpeakerChunk[] {
  if (!utterances || utterances.length === 0) return [];

  const chunks: SpeakerChunk[] = [];
  let currentSpeaker = utterances[0].speaker;
  let currentText = "";
  let currentStart = utterances[0].start;

  const flush = () => {
    const trimmed = currentText.trim();
    if (!trimmed) return;
    if (trimmed.length <= maxChars) {
      chunks.push({ speaker: currentSpeaker, text: trimmed, start: currentStart });
    } else {
      const subChunks = splitTextIntoChunks(trimmed, maxChars);
      for (const sub of subChunks) {
        chunks.push({ speaker: currentSpeaker, text: sub, start: currentStart });
      }
    }
  };

  for (const u of utterances) {
    if (u.speaker === currentSpeaker) {
      currentText += (currentText ? " " : "") + u.text;
    } else {
      flush();
      currentSpeaker = u.speaker;
      currentText = u.text;
      currentStart = u.start;
    }
  }
  flush();

  return chunks;
}

// ─── Translation ─────────────────────────────────────────────────────────────

async function translateChunk(
  text: string,
  targetLanguage: string,
  apiKey: string,
  detectedLanguageCode?: string
): Promise<string> {
  if (targetLanguage === "English" && detectedLanguageCode === "en") {
    return text;
  }

  const prompt =
    targetLanguage === "English"
      ? `Translate this into English. Preserve speaker tone and natural speech patterns:\n\n${text}`
      : `Translate this into ${targetLanguage}:\n\n${text}`;

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
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  const json = await res.json();
  if (!json.choices?.[0]?.message?.content) {
    throw new Error("OpenAI translation failed: " + JSON.stringify(json));
  }
  return json.choices[0].message.content.trim();
}

// ─── Dubbing ─────────────────────────────────────────────────────────────────

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

// ─── Audio URL Detection ─────────────────────────────────────────────────────

function isDirectAudioUrl(url: string): boolean {
  const audioExtensions = [".mp3", ".m4a", ".wav", ".ogg", ".aac", ".flac"];
  try {
    const parsed = new URL(url);
    if (audioExtensions.some(ext => parsed.pathname.toLowerCase().endsWith(ext))) return true;
    if (url.includes("audio%2Fmpeg") || url.includes("audio/mpeg") || url.includes("content-type=audio")) return true;
    if (url.includes("storage.filebin.net") || url.includes("storage.googleapis.com")) return true;
    if (url.includes("X-Amz-Algorithm") && url.includes("audio")) return true;
    return false;
  } catch {
    return false;
  }
}

// ─── yt-dlp ──────────────────────────────────────────────────────────────────

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

async function extractAudioWithYtDlp(
  url: string,
  supabase: any,
  bucket: string,
  episodeId: string
): Promise<string> {
  installYtDlp();
  const ytDlpPath = getYtDlpPath();
  const tmpDir = "/tmp";
  const outputTemplate = join(tmpDir, "audio_" + episodeId + ".%(ext)s");

  console.log("[YT-DLP] Extracting audio from:", url);

  try {
    execSync(
      ytDlpPath +
        " --extract-audio --audio-format mp3 --audio-quality 0 --no-playlist -o " +
        JSON.stringify(outputTemplate) +
        " " +
        JSON.stringify(url),
      { timeout: 300000, stdio: "pipe" }
    );
  } catch (err: any) {
    throw new Error("yt-dlp failed: " + (err.stderr?.toString() || err.message));
  }

  const outputPath = join(tmpDir, "audio_" + episodeId + ".mp3");
  if (!existsSync(outputPath)) {
    throw new Error("yt-dlp did not produce output at " + outputPath);
  }

  const audioBuffer = readFileSync(outputPath);
  console.log("[YT-DLP] Extracted, size:", audioBuffer.byteLength);

  const fileName = "jobs/" + episodeId + "/source/audio.mp3";
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(fileName, audioBuffer, { contentType: "audio/mpeg", upsert: true });

  if (uploadError) {
    throw new Error("Failed to upload extracted audio: " + uploadError.message);
  }

  try { unlinkSync(outputPath); } catch {}

  const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(fileName);
  console.log("[YT-DLP] Uploaded to Supabase:", publicData.publicUrl);
  return publicData.publicUrl;
}

// ─── Supabase Helpers ────────────────────────────────────────────────────────

async function uploadChunkToSupabase(
  supabase: any,
  bucket: string,
  chunkPath: string,
  episodeId: string,
  index: number
): Promise<string> {
  const chunkBuffer = readFileSync(chunkPath);
  const fileName = "jobs/" + episodeId + "/chunks/chunk_" + String(index).padStart(4, "0") + ".mp3";

  const { error } = await supabase.storage
    .from(bucket)
    .upload(fileName, chunkBuffer, { contentType: "audio/mpeg", upsert: true });

  if (error) {
    throw new Error("Chunk upload error (chunk " + index + "): " + error.message);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}

// ─── Main Task ───────────────────────────────────────────────────────────────

export const podcastOrchestrator = task({
  id: "podcast-orchestrator",
  machine: "medium-1x",
  run: async (payload: any) => {

    // ── Env Vars ──────────────────────────────────────────────────────────────
    const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY!;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
    const ELEVENLABS_API_KEY = process.env.ELEVENLAB_API_KEY!;
    const SUPABASE_URL = process.env.SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const BUCKET = process.env.SUPABASE_BUCKET_NAME!;

    if (!ASSEMBLYAI_API_KEY) throw new Error("Missing ASSEMBLYAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
    if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLAB_API_KEY (no S)");
    if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
    if (!SUPABASE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    if (!BUCKET) throw new Error("Missing SUPABASE_BUCKET_NAME");

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // ── Payload ───────────────────────────────────────────────────────────────
    let audioUrl: string = payload.audioUrl || "https://storage.googleapis.com/aai-docs-samples/espn.m4a";
    const targetLanguage: string = payload.targetLanguage || "Spanish";
    const previewMode: boolean = payload.previewMode === true;
    const testMode: boolean = payload.testMode === true;
    const episodeId: string = payload.episodeId || "test";
    const voicePool = getVoicePool(targetLanguage);

    console.log("[STEP 1] PIPELINE START");
    console.log("  episodeId:", episodeId);
    console.log("  targetLanguage:", targetLanguage);
    console.log("  testMode:", testMode, "| previewMode:", previewMode);
    console.log("  voicePool size:", voicePool.length);

    // ── STEP 2: Resolve Audio URL ─────────────────────────────────────────────
    console.log("[STEP 2] RESOLVING AUDIO URL:", audioUrl);

    if (!isDirectAudioUrl(audioUrl)) {
      console.log("[STEP 2] Not a direct audio URL — extracting with yt-dlp");
      audioUrl = await extractAudioWithYtDlp(audioUrl, supabase, BUCKET, episodeId);
    } else {
      console.log("[STEP 2] Direct audio URL confirmed");
    }

    // ── STEP 3: Transcribe ────────────────────────────────────────────────────
    console.log("[STEP 3] SUBMITTING TO ASSEMBLYAI");

    const transcriptBody: any = {
      audio_url: audioUrl,
      speech_models: ["universal-2"],
      speaker_labels: true,
      language_detection: true,
    };

    if (previewMode) {
      transcriptBody.audio_end_at = 180000;
      console.log("[STEP 3] Preview mode — limiting to first 3 minutes");
    }

    const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        Authorization: ASSEMBLYAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(transcriptBody),
    });

    const submitJson = await submitRes.json();
    const transcriptId = submitJson.id;
    if (!transcriptId) {
      throw new Error("No transcript ID returned: " + JSON.stringify(submitJson));
    }

    // ── STEP 4: Poll for Transcript ───────────────────────────────────────────
    console.log("[STEP 4] POLLING ASSEMBLYAI, ID:", transcriptId);

    let transcriptText = "";
    let utterances: any[] = [];
    let detectedLanguageCode = "en";

    while (true) {
      await new Promise((r) => setTimeout(r, 3000));

      const pollRes = await fetch(
        "https://api.assemblyai.com/v2/transcript/" + transcriptId,
        { headers: { Authorization: ASSEMBLYAI_API_KEY } }
      );
      const pollJson: any = await pollRes.json();
      console.log("[STEP 4] Poll status:", pollJson.status);

      if (pollJson.status === "completed") {
        transcriptText = pollJson.text;
        utterances = pollJson.utterances || [];
        detectedLanguageCode = pollJson.language_code || "en";
        console.log("[STEP 4] Transcript complete");
        console.log("  length:", transcriptText.length, "chars");
        console.log("  utterances:", utterances.length);
        console.log("  detected language:", detectedLanguageCode);
        break;
      }

      if (pollJson.status === "error") {
        throw new Error("AssemblyAI error: " + pollJson.error);
      }
    }

    // ── STEP 5: Build Speaker Chunks ──────────────────────────────────────────
    console.log("[STEP 5] BUILDING SPEAKER CHUNKS");

    let speakerChunks: SpeakerChunk[];

    if (utterances.length > 0) {
      speakerChunks = buildSpeakerChunks(utterances, MAX_CHARS_PER_CHUNK);
      console.log("[STEP 5] Built", speakerChunks.length, "speaker-aware chunks");
    } else {
      console.log("[STEP 5] No utterances — falling back to single-speaker chunking");
      const fallbackChunks = splitTextIntoChunks(transcriptText, MAX_CHARS_PER_CHUNK);
      speakerChunks = fallbackChunks.map((text, i) => ({ speaker: "A", text, start: i }));
    }

    // Assign each unique speaker a voice from the pool
    const speakerToVoice: Record<string, string> = {};
    let voiceIndex = 0;
    for (const chunk of speakerChunks) {
      if (!speakerToVoice[chunk.speaker]) {
        speakerToVoice[chunk.speaker] = voicePool[voiceIndex % voicePool.length];
        voiceIndex++;
      }
    }
    console.log("[STEP 5] Speaker → Voice assignments:", speakerToVoice);

    // ── STEP 6: Translate ─────────────────────────────────────────────────────
    console.log("[STEP 6] TRANSLATING", speakerChunks.length, "chunks (batches of", TRANSLATION_BATCH_SIZE + ")");

    const translatedChunks: SpeakerChunk[] = new Array(speakerChunks.length);

    for (let i = 0; i < speakerChunks.length; i += TRANSLATION_BATCH_SIZE) {
      const batch = speakerChunks.slice(i, i + TRANSLATION_BATCH_SIZE);
      const batchNum = Math.floor(i / TRANSLATION_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(speakerChunks.length / TRANSLATION_BATCH_SIZE);
      console.log("[STEP 6] Translating batch", batchNum + "/" + totalBatches);

      const results = await Promise.all(
        batch.map(async (chunk, batchIdx) => {
          const translated = await translateChunk(
            chunk.text,
            targetLanguage,
            OPENAI_API_KEY,
            detectedLanguageCode
          );
          return { index: i + batchIdx, chunk: { speaker: chunk.speaker, text: translated, start: chunk.start } };
        })
      );

      for (const r of results) {
        translatedChunks[r.index] = r.chunk;
      }
    }

    const translationText = translatedChunks.map(c => "[" + c.speaker + "] " + c.text).join("\n\n");
    console.log("[STEP 6] Translation complete,", translatedChunks.length, "chunks");

    // ── TEST MODE: Skip dubbing ───────────────────────────────────────────────
    if (testMode) {
      console.log("[TEST MODE] Skipping ElevenLabs — returning test audio URL");

      // ✅ FIX: Save test audio URL back to Supabase
      const { error: testUpdateError } = await supabase
        .from("podcasts")
        .update({
          status: "completed",
          audio_url: TEST_MODE_AUDIO_URL,
          audio_chunks: [TEST_MODE_AUDIO_URL],
          transcript: transcriptText,
          translation: translationText,
          detected_language: detectedLanguageCode,
        })
        .eq("id", episodeId);

      if (testUpdateError) {
        console.error("[TEST MODE] Failed to update Supabase row:", testUpdateError.message);
      } else {
        console.log("[TEST MODE] Supabase row updated with test audio URL");
      }

      return {
        transcript: transcriptText,
        translation: translationText,
        speaker_assignments: speakerToVoice,
        detected_language: detectedLanguageCode,
        final_audio_url: TEST_MODE_AUDIO_URL,
        audio_chunks: [TEST_MODE_AUDIO_URL],
        test_mode: true,
      };
    }

    // ── STEP 7: Dub Each Chunk ────────────────────────────────────────────────
    console.log("[STEP 7] DUBBING", translatedChunks.length, "chunks (batches of", DUB_BATCH_SIZE + ")");

    const localChunkPaths: string[] = new Array(translatedChunks.length);

    for (let i = 0; i < translatedChunks.length; i += DUB_BATCH_SIZE) {
      const batch = translatedChunks.slice(i, i + DUB_BATCH_SIZE);
      const batchNum = Math.floor(i / DUB_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(translatedChunks.length / DUB_BATCH_SIZE);
      console.log("[STEP 7] Dubbing batch", batchNum + "/" + totalBatches);

      const results = await Promise.all(
        batch.map(async (chunk, batchIdx) => {
          const absoluteIndex = i + batchIdx;
          const voiceId = speakerToVoice[chunk.speaker];
          console.log("  Chunk", (absoluteIndex + 1) + "/" + translatedChunks.length, "| speaker:", chunk.speaker, "→ voice:", voiceId);
          const buf = await dubChunk(chunk.text, voiceId, ELEVENLABS_API_KEY);
          const chunkPath = "/tmp/chunk_" + episodeId + "_" + absoluteIndex + ".mp3";
          writeFileSync(chunkPath, Buffer.from(buf));
          return { index: absoluteIndex, path: chunkPath };
        })
      );

      for (const r of results) {
        localChunkPaths[r.index] = r.path;
      }
    }

    console.log("[STEP 7] All", localChunkPaths.length, "chunks dubbed");

    // ── STEP 8: Upload Each Chunk to Supabase ─────────────────────────────────
    console.log("[STEP 8] UPLOADING", localChunkPaths.length, "chunks to Supabase");

    const supabaseChunkUrls: string[] = [];

    for (let i = 0; i < localChunkPaths.length; i++) {
      const url = await uploadChunkToSupabase(supabase, BUCKET, localChunkPaths[i], episodeId, i);
      supabaseChunkUrls.push(url);
      console.log("[STEP 8] Uploaded chunk", (i + 1) + "/" + localChunkPaths.length);
      try { unlinkSync(localChunkPaths[i]); } catch {}
    }

    // ── STEP 9: Save Results to Supabase ──────────────────────────────────────
    // ✅ FIX: This is what was missing — the pipeline never wrote results back
    console.log("[STEP 9] SAVING RESULTS TO SUPABASE");

    const { error: updateError } = await supabase
      .from("podcasts")
      .update({
        status: "completed",
        audio_url: supabaseChunkUrls[0],        // first chunk as the playable URL
        audio_chunks: supabaseChunkUrls,         // all chunks for client-side merge
        transcript: transcriptText,
        translation: translationText,
        detected_language: detectedLanguageCode,
      })
      .eq("id", episodeId);

    if (updateError) {
      // Don't throw — the audio is uploaded, just log the failure
      console.error("[STEP 9] Failed to update Supabase row:", updateError.message);
    } else {
      console.log("[STEP 9] Supabase row updated successfully");
    }

    // ── DONE ─────────────────────────────────────────────────────────────────
    console.log("[DONE] PIPELINE COMPLETE —", supabaseChunkUrls.length, "chunks ready");

    return {
      transcript: transcriptText,
      translation: translationText,
      speaker_assignments: speakerToVoice,
      detected_language: detectedLanguageCode,
      final_audio_url: supabaseChunkUrls[0],
      audio_chunks: supabaseChunkUrls,
    };
  },
});