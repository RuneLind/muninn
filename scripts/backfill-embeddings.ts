import { loadConfig } from "../src/config.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import {
  getMemoriesWithoutEmbeddings,
  updateMemoryEmbedding,
} from "../src/db/memories.ts";
import { generateEmbedding } from "../src/ai/embeddings.ts";

const config = loadConfig();
initDb(config);

const memories = await getMemoriesWithoutEmbeddings();
console.log(`Found ${memories.length} memories without embeddings`);

let success = 0;
let failed = 0;

for (const memory of memories) {
  const embedding = await generateEmbedding(memory.summary);
  if (embedding) {
    await updateMemoryEmbedding(memory.id, embedding);
    success++;
    console.log(`  [${success + failed}/${memories.length}] ${memory.id} — OK`);
  } else {
    failed++;
    console.log(`  [${success + failed}/${memories.length}] ${memory.id} — FAILED`);
  }
}

console.log(`\nDone: ${success} updated, ${failed} failed`);
await closeDb();
