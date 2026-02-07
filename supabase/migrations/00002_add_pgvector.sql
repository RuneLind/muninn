-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column (384 dims = all-MiniLM-L6-v2)
ALTER TABLE memories ADD COLUMN embedding vector(384);

-- HNSW index for fast cosine similarity search
CREATE INDEX idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);
