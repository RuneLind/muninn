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
    initPromise = null;
    return pipe;
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

export async function warmupEmbeddings(): Promise<void> {
  try {
    log.info("Loading embedding model...");
    await getExtractor();
    log.info("Embedding model ready");
  } catch (err) {
    log.error("Failed to load embedding model: {error}", { error: err instanceof Error ? err.message : String(err) });
  }
}
