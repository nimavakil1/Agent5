/**
 * RAG (Retrieval-Augmented Generation) System
 *
 * Provides context-aware knowledge retrieval for AI agents.
 */

const { EmbeddingService } = require('./EmbeddingService');
const { VectorStore } = require('./VectorStore');

/**
 * RAG Manager - Singleton for managing knowledge retrieval
 */
class RAGManager {
  constructor() {
    this.vectorStore = null;
    this.initialized = false;
  }

  /**
   * Initialize with database connection
   */
  async init(db) {
    this.vectorStore = new VectorStore({ db });
    this.initialized = true;

    // Index any pending items
    try {
      const result = await this.vectorStore.indexPending();
      console.log(`RAG: Indexed ${result.indexed} pending items`);
    } catch (e) {
      console.warn('RAG: Could not index pending items:', e.message);
    }
  }

  /**
   * Get relevant context for a query
   */
  async getContext(query, options = {}) {
    if (!this.initialized) {
      return null;
    }

    try {
      const results = await this.vectorStore.search(query, {
        limit: options.limit || 5,
        category: options.category,
        minScore: options.minScore || 0.7,
      });

      if (results.length === 0) {
        return null;
      }

      // Format results as context
      return results
        .map(r => `### ${r.title} (${r.category}) [Score: ${(r.score * 100).toFixed(0)}%]\n${r.content}`)
        .join('\n\n---\n\n');

    } catch (e) {
      console.warn('RAG retrieval failed:', e.message);
      return null;
    }
  }

  /**
   * Index a new knowledge item
   */
  async indexItem(item) {
    if (!this.initialized) {
      throw new Error('RAG not initialized');
    }
    return this.vectorStore.indexItem(item);
  }

  /**
   * Delete a knowledge item from index
   */
  async deleteItem(knowledgeId) {
    if (!this.initialized) {
      throw new Error('RAG not initialized');
    }
    return this.vectorStore.deleteItem(knowledgeId);
  }

  /**
   * Rebuild the entire index
   */
  async rebuildIndex() {
    if (!this.initialized) {
      throw new Error('RAG not initialized');
    }
    return this.vectorStore.rebuildIndex();
  }

  /**
   * Get index statistics
   */
  async getStats() {
    if (!this.initialized) {
      return { initialized: false };
    }
    return this.vectorStore.getStats();
  }
}

// Singleton instance
let ragManager = null;

function getRAGManager() {
  if (!ragManager) {
    ragManager = new RAGManager();
  }
  return ragManager;
}

module.exports = {
  EmbeddingService,
  VectorStore,
  RAGManager,
  getRAGManager,
};
