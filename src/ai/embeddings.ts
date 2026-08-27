import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { getLog } from "../logging.ts";

const log = getLog("ai", "embeddings");

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (initPromise) return initPromise;

  initPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "q8",
  }).then((pipe) => {
    extractor = pipe;
    return pipe;
  }).catch((err) => {
    // Only clear on error so concurrent callers can retry
    initPromise = null;
    throw err;
  });

  return initPromise;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const pipe = await getExtractor();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (err) {
    log.error("Embedding generation failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * The THROWING load path — `getExtractor()` under a name callers can use.
 *
 * It exists for the image build (`--build-arg WITH_EMBEDDINGS=true`), which
 * must fail loudly when the model cannot be fetched. Neither exported helper
 * below can do that: `warmupEmbeddings` catches and logs, and
 * `generateEmbedding` catches and returns `null`, so a build driven by either
 * would have to infer the failure from a falsy value — and would print no
 * cause, since LogTape is an unconfigured no-op outside the server. Here the
 * real error, with its stack, reaches whoever asked for it, which is the
 * difference between "our egress blocks huggingface.co" and "retry and hope".
 */
export async function loadEmbeddingModel(): Promise<FeatureExtractionPipeline> {
  return getExtractor();
}

export async function warmupEmbeddings(): Promise<void> {
  try {
    log.info("Loading embedding model...");
    await getExtractor();
    log.info("Embedding model ready");
  } catch (err) {
    log.error("Failed to load embedding model: {error}", { error: err instanceof Error ? err.message : String(err) });
  }
}
