
import { createClient } from "@supabase/supabase-js";
import { task } from "@trigger.dev/sdk/v3";
// Config
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET_NAME!;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY!;
const ASSEMBLYAI_API = "https://api.assemblyai.com/v2";

const CHUNK_DURATION_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 144;

// ... (types, helpers, main task)
export const podcastProcessingPipeline = task({
  id: "podcast-processing-pipeline",
  maxDuration: 1800,
  run: async (payload: any, { ctx }) => {
    // Downloads audio, splits into chunks, transcribes via AssemblyAI,
    // translates via OpenAI, merges results, returns final transcript
  }
});