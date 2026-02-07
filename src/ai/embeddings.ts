import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

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
    console.error("Embedding generation failed:", err);
    return null;
  }
}

export async function warmupEmbeddings(): Promise<void> {
  try {
    console.log("Loading embedding model...");
    await getExtractor();
    console.log("Embedding model ready");
  } catch (err) {
    console.error("Failed to load embedding model:", err);
  }
}
