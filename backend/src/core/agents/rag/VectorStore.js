/**
 * Vector Store for RAG
 *
 * Stores and retrieves embeddings for semantic search.
 * Uses MongoDB with vector storage for simplicity.
 * Can be upgraded to Pinecone/Chroma for production scale.
 */

const { EmbeddingService } = require('./EmbeddingService');

class VectorStore {
  constructor(config = {}) {
    this.db = config.db;
    this.collectionName = config.collection || 'knowledge_vectors';
    this.embeddingService = new EmbeddingService(config.embedding || {});
  }

  /**
   * Set database connection
   */
  setDb(db) {
    this.db = db;
  }

  /**
   * Index a knowledge item
   */
  async indexItem(item) {
    if (!this.db) throw new Error('Database not connected');

    // Generate text for embedding
    const text = this._itemToText(item);

    // Generate embedding
    const embedding = await this.embeddingService.embed(text);

    // Store in vectors collection
    await this.db.collection(this.collectionName).updateOne(
      { knowledgeId: item._id.toString() },
      {
        $set: {
          knowledgeId: item._id.toString(),
          title: item.title,
          category: item.category,
          embedding,
          textLength: text.length,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Mark knowledge item as indexed
    await this.db.collection('knowledge').updateOne(
      { _id: item._id },
      { $set: { indexed: true, indexedAt: new Date() } }
    );

    return { success: true, knowledgeId: item._id.toString() };
  }

  /**
   * Index multiple items
   */
  async indexItems(items) {
    const results = [];
    for (const item of items) {
      try {
        const result = await this.indexItem(item);
        results.push({ ...result, success: true });
      } catch (error) {
        results.push({ knowledgeId: item._id?.toString(), success: false, error: error.message });
      }
    }
    return results;
  }

  /**
   * Index all unindexed items
   */
  async indexPending() {
    if (!this.db) throw new Error('Database not connected');

    const pending = await this.db.collection('knowledge')
      .find({ indexed: { $ne: true } })
      .toArray();

    if (pending.length === 0) {
      return { indexed: 0, message: 'No pending items' };
    }

    const results = await this.indexItems(pending);

    return {
      indexed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  }

  /**
   * Search for similar items
   */
  async search(query, options = {}) {
    if (!this.db) throw new Error('Database not connected');

    const limit = options.limit || 5;
    const category = options.category;
    const minScore = options.minScore || 0.7;

    // Generate query embedding
    const queryEmbedding = await this.embeddingService.embed(query);

    // Get all vectors (for small datasets)
    // TODO: Use MongoDB Atlas Vector Search or external vector DB for scale
    const filter = category ? { category } : {};
    const vectors = await this.db.collection(this.collectionName)
      .find(filter)
      .toArray();

    if (vectors.length === 0) {
      return [];
    }

    // Calculate similarities
    const scored = vectors.map(v => ({
      ...v,
      score: this.embeddingService.cosineSimilarity(queryEmbedding, v.embedding),
    }));

    // Sort by score and filter
    const results = scored
      .filter(s => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Fetch full knowledge items
    const knowledgeIds = results.map(r => r.knowledgeId);
    const { ObjectId } = require('mongodb');

    const items = await this.db.collection('knowledge')
      .find({ _id: { $in: knowledgeIds.map(id => new ObjectId(id)) } })
      .toArray();

    // Merge with scores
    return results.map(r => {
      const item = items.find(i => i._id.toString() === r.knowledgeId);
      return {
        ...item,
        score: r.score,
      };
    }).filter(r => r._id); // Filter out any missing items
  }

  /**
   * Delete vector for an item
   */
  async deleteItem(knowledgeId) {
    if (!this.db) throw new Error('Database not connected');

    await this.db.collection(this.collectionName).deleteOne({
      knowledgeId: knowledgeId.toString(),
    });

    return { success: true };
  }

  /**
   * Rebuild entire index
   */
  async rebuildIndex() {
    if (!this.db) throw new Error('Database not connected');

    // Clear existing vectors
    await this.db.collection(this.collectionName).deleteMany({});

    // Mark all knowledge as not indexed
    await this.db.collection('knowledge').updateMany(
      {},
      { $set: { indexed: false } }
    );

    // Index all items
    return this.indexPending();
  }

  /**
   * Get index stats
   */
  async getStats() {
    if (!this.db) throw new Error('Database not connected');

    const totalVectors = await this.db.collection(this.collectionName).countDocuments();
    const totalKnowledge = await this.db.collection('knowledge').countDocuments();
    const indexed = await this.db.collection('knowledge').countDocuments({ indexed: true });

    return {
      totalVectors,
      totalKnowledge,
      indexed,
      pending: totalKnowledge - indexed,
      coverage: totalKnowledge > 0 ? ((indexed / totalKnowledge) * 100).toFixed(1) + '%' : '0%',
    };
  }

  /**
   * Convert knowledge item to text for embedding
   */
  _itemToText(item) {
    const parts = [];

    if (item.title) parts.push(`Title: ${item.title}`);
    if (item.category) parts.push(`Category: ${item.category}`);
    if (item.description) parts.push(`Description: ${item.description}`);
    if (item.content) parts.push(`Content: ${item.content}`);
    if (item.tags && item.tags.length > 0) parts.push(`Tags: ${item.tags.join(', ')}`);

    return parts.join('\n\n');
  }
}

module.exports = { VectorStore };
