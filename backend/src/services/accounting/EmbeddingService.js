/**
 * EmbeddingService - Generates and manages vector embeddings for accounting knowledge
 *
 * Uses OpenAI text-embedding-3-small for generating embeddings.
 * Provides semantic search over AccountingKnowledge entries.
 */

const OpenAI = require('openai');
const AccountingKnowledge = require('../../models/AccountingKnowledge');

class EmbeddingService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.model = 'text-embedding-3-small';
    this.dimensions = 1536; // Default for text-embedding-3-small
  }

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Promise<number[]>} - Embedding vector
   */
  async generateEmbedding(text) {
    if (!text || text.trim().length === 0) {
      throw new Error('Cannot generate embedding for empty text');
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: text.slice(0, 8000), // Limit input size
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error.message);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts
   * @param {string[]} texts - Array of texts to embed
   * @returns {Promise<number[][]>} - Array of embedding vectors
   */
  async generateEmbeddings(texts) {
    if (!texts || texts.length === 0) {
      return [];
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: texts.map(t => t.slice(0, 8000)),
      });

      return response.data.map(d => d.embedding);
    } catch (error) {
      console.error('Error generating embeddings:', error.message);
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {number[]} a - First vector
   * @param {number[]} b - Second vector
   * @returns {number} - Similarity score (0-1)
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Search knowledge base using semantic similarity
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Array>} - Matching knowledge entries with scores
   */
  async semanticSearch(query, options = {}) {
    const {
      limit = 10,
      minScore = 0.5,
      categories = null,
      activeOnly = true,
    } = options;

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Build MongoDB query
    const dbQuery = {};
    if (activeOnly) {
      dbQuery.active = true;
    }
    if (categories && categories.length > 0) {
      dbQuery.category = { $in: categories };
    }
    // Only include entries with embeddings
    dbQuery.embedding = { $exists: true, $ne: [] };

    // Fetch all relevant entries
    // Note: For large datasets, consider using a vector database like Pinecone or Weaviate
    const entries = await AccountingKnowledge.find(dbQuery)
      .select('subject fact category tags priority embedding structuredData relatedOdooIds')
      .lean();

    // Calculate similarities
    const results = entries
      .map(entry => ({
        ...entry,
        _id: entry._id.toString(),
        score: this.cosineSimilarity(queryEmbedding, entry.embedding),
        embedding: undefined, // Don't return embedding in results
      }))
      .filter(entry => entry.score >= minScore)
      .sort((a, b) => {
        // Sort by score, then by priority
        if (Math.abs(a.score - b.score) < 0.01) {
          return (b.priority || 0) - (a.priority || 0);
        }
        return b.score - a.score;
      })
      .slice(0, limit);

    return results;
  }

  /**
   * Update embedding for a knowledge entry
   * @param {string} knowledgeId - MongoDB ID
   */
  async updateEmbedding(knowledgeId) {
    const knowledge = await AccountingKnowledge.findById(knowledgeId);
    if (!knowledge) {
      throw new Error(`Knowledge entry not found: ${knowledgeId}`);
    }

    const text = knowledge.embeddingText || `${knowledge.category}: ${knowledge.subject}. ${knowledge.fact}`;
    const embedding = await this.generateEmbedding(text);

    knowledge.embedding = embedding;
    await knowledge.save();

    return knowledge;
  }

  /**
   * Bulk update embeddings for entries missing them
   * @param {number} batchSize - Number of entries to process at once
   */
  async updateMissingEmbeddings(batchSize = 50) {
    let processed = 0;
    let hasMore = true;

    while (hasMore) {
      const entries = await AccountingKnowledge.find({
        $or: [
          { embedding: { $exists: false } },
          { embedding: { $size: 0 } },
        ],
        active: true,
      })
        .limit(batchSize);

      if (entries.length === 0) {
        hasMore = false;
        break;
      }

      // Generate embeddings in batch
      const texts = entries.map(e => e.embeddingText || `${e.category}: ${e.subject}. ${e.fact}`);
      const embeddings = await this.generateEmbeddings(texts);

      // Update entries
      for (let i = 0; i < entries.length; i++) {
        entries[i].embedding = embeddings[i];
        await entries[i].save();
      }

      processed += entries.length;
      console.log(`Updated embeddings for ${processed} entries`);
    }

    return processed;
  }

  /**
   * Search for relevant knowledge given a user message
   * This is the main method used by the AccountingAssistant
   * @param {string} userMessage - User's message/question
   * @param {Object} context - Additional context
   * @returns {Promise<Array>} - Relevant knowledge entries
   */
  async findRelevantKnowledge(userMessage, context = {}) {
    const {
      categories = null,
      supplierName = null,
      customerName = null,
      includeRules = true,
      includeFacts = true,
      limit = 15,
    } = context;

    // Build category filter
    let categoryFilter = [];

    if (includeRules) {
      categoryFilter.push('accounting_rule', 'tax_rule', 'country_vat', 'procedure', 'peppol');
    }
    if (includeFacts) {
      categoryFilter.push('supplier_fact', 'customer_fact', 'account_mapping', 'preference', 'correction', 'warehouse');
    }
    if (categories) {
      categoryFilter = categories;
    }

    // Semantic search
    const semanticResults = await this.semanticSearch(userMessage, {
      limit: limit,
      minScore: 0.45,
      categories: categoryFilter.length > 0 ? categoryFilter : null,
    });

    // If supplier/customer name mentioned, also fetch their specific knowledge
    const additionalResults = [];

    if (supplierName) {
      const supplierKnowledge = await AccountingKnowledge.find({
        category: 'supplier_fact',
        subject: { $regex: supplierName, $options: 'i' },
        active: true,
      }).limit(10).lean();

      additionalResults.push(...supplierKnowledge.map(k => ({
        ...k,
        _id: k._id.toString(),
        score: 1.0, // Direct match
        matchType: 'supplier_name',
      })));
    }

    if (customerName) {
      const customerKnowledge = await AccountingKnowledge.find({
        category: 'customer_fact',
        subject: { $regex: customerName, $options: 'i' },
        active: true,
      }).limit(10).lean();

      additionalResults.push(...customerKnowledge.map(k => ({
        ...k,
        _id: k._id.toString(),
        score: 1.0,
        matchType: 'customer_name',
      })));
    }

    // Merge and dedupe results
    const resultMap = new Map();
    for (const result of [...additionalResults, ...semanticResults]) {
      if (!resultMap.has(result._id)) {
        resultMap.set(result._id, result);
      }
    }

    // Sort by score and return
    return Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Add new knowledge with automatic embedding generation
   * @param {Object} knowledgeData - Knowledge data
   * @param {string} createdBy - User who created it
   * @returns {Promise<Object>} - Created knowledge entry
   */
  async addKnowledge(knowledgeData, createdBy) {
    const {
      category,
      subject,
      fact,
      structuredData,
      relatedOdooIds,
      tags,
      priority,
      source,
    } = knowledgeData;

    // Generate embedding text
    const embeddingText = `${category}: ${subject}. ${fact}`;
    const embedding = await this.generateEmbedding(embeddingText);

    // Create knowledge entry
    const knowledge = new AccountingKnowledge({
      category,
      subject,
      fact,
      structuredData,
      relatedOdooIds,
      tags,
      priority: priority || 0,
      source: {
        type: source?.type || 'user_training',
        userId: createdBy,
        timestamp: new Date(),
        context: source?.context,
      },
      embedding,
      embeddingText,
      createdBy,
      active: true,
    });

    await knowledge.save();
    return knowledge;
  }
}

// Singleton instance
let instance = null;

function getEmbeddingService() {
  if (!instance) {
    instance = new EmbeddingService();
  }
  return instance;
}

module.exports = {
  EmbeddingService,
  getEmbeddingService,
};
