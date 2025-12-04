/**
 * Embedding Service for RAG
 *
 * Generates embeddings for knowledge base items using:
 * - OpenAI text-embedding-3-large (default)
 * - Or local embeddings if configured
 */

const OpenAI = require('openai');

class EmbeddingService {
  constructor(config = {}) {
    this.provider = config.provider || 'openai';
    this.model = config.model || 'text-embedding-3-large';
    this.dimensions = config.dimensions || 1536;

    if (this.provider === 'openai') {
      this.client = new OpenAI({
        apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      });
    }
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text) {
    if (this.provider === 'openai') {
      return this._embedOpenAI(text);
    }
    throw new Error(`Unknown embedding provider: ${this.provider}`);
  }

  /**
   * Generate embeddings for multiple texts
   */
  async embedBatch(texts) {
    if (this.provider === 'openai') {
      return this._embedBatchOpenAI(texts);
    }
    throw new Error(`Unknown embedding provider: ${this.provider}`);
  }

  /**
   * OpenAI embedding
   */
  async _embedOpenAI(text) {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });

    return response.data[0].embedding;
  }

  /**
   * OpenAI batch embedding
   */
  async _embedBatchOpenAI(texts) {
    // OpenAI supports up to 2048 texts per request
    const batchSize = 100;
    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });

      results.push(...response.data.map(d => d.embedding));
    }

    return results;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

module.exports = { EmbeddingService };
