/**
 * Knowledge Base API Routes
 *
 * Manage company knowledge for AI training
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { getDb } = require('../../db');
const { ObjectId } = require('mongodb');
const { getRAGManager } = require('../../core/agents/rag');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/knowledge');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.docx', '.doc', '.txt', '.csv', '.xlsx', '.xls', '.json', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: ' + allowedTypes.join(', ')));
    }
  }
});

/**
 * @route GET /api/knowledge
 * @desc Get all knowledge items
 */
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const items = await db.collection('knowledge')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/knowledge/:id
 * @desc Get a single knowledge item
 */
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const item = await db.collection('knowledge').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!item) {
      return res.status(404).json({ error: 'Knowledge item not found' });
    }

    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/knowledge
 * @desc Create a text knowledge item
 */
router.post('/', async (req, res) => {
  try {
    const { type, title, category, content, tags, description } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: 'Title and category are required' });
    }

    const db = getDb();
    const item = {
      type: type || 'text',
      title,
      category,
      content: content || '',
      description: description || '',
      tags: tags || [],
      createdAt: new Date(),
      updatedAt: new Date(),
      indexed: false,
      createdBy: req.user?.email || 'system'
    };

    const result = await db.collection('knowledge').insertOne(item);
    item._id = result.insertedId;

    // Index in background (don't block response)
    const rag = getRAGManager();
    if (rag.initialized) {
      rag.indexItem(item).catch(e => console.warn('RAG indexing failed:', e.message));
    }

    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/knowledge/upload
 * @desc Upload a document
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { title, category, description } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: 'Title and category are required' });
    }

    // Extract text content based on file type
    let content = '';
    const ext = path.extname(req.file.originalname).toLowerCase();

    try {
      if (ext === '.txt' || ext === '.md') {
        content = await fs.readFile(req.file.path, 'utf-8');
      } else if (ext === '.json') {
        const json = await fs.readFile(req.file.path, 'utf-8');
        content = JSON.stringify(JSON.parse(json), null, 2);
      } else if (ext === '.csv') {
        content = await fs.readFile(req.file.path, 'utf-8');
      } else {
        // For PDF, DOCX, XLSX - we'll process later with proper libraries
        content = `[Document: ${req.file.originalname}] - Content extraction pending`;
      }
    } catch (e) {
      content = `[Document: ${req.file.originalname}] - Content extraction failed: ${e.message}`;
    }

    const db = getDb();
    const item = {
      type: 'document',
      title,
      category,
      content,
      description: description || '',
      tags: [],
      filePath: req.file.path,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      createdAt: new Date(),
      updatedAt: new Date(),
      indexed: false,
      createdBy: req.user?.email || 'system'
    };

    const result = await db.collection('knowledge').insertOne(item);
    item._id = result.insertedId;

    // Index in background (don't block response)
    const rag = getRAGManager();
    if (rag.initialized) {
      rag.indexItem(item).catch(e => console.warn('RAG indexing failed:', e.message));
    }

    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route PUT /api/knowledge/:id
 * @desc Update a knowledge item
 */
router.put('/:id', async (req, res) => {
  try {
    const { title, category, content, tags, description } = req.body;

    const db = getDb();
    const updateData = {
      updatedAt: new Date(),
      indexed: false // Mark for re-indexing
    };

    if (title !== undefined) updateData.title = title;
    if (category !== undefined) updateData.category = category;
    if (content !== undefined) updateData.content = content;
    if (tags !== undefined) updateData.tags = tags;
    if (description !== undefined) updateData.description = description;

    const result = await db.collection('knowledge').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Knowledge item not found' });
    }

    // TODO: Trigger re-embedding/indexing in background

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route DELETE /api/knowledge/:id
 * @desc Delete a knowledge item
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();

    // Get the item first to check for file
    const item = await db.collection('knowledge').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!item) {
      return res.status(404).json({ error: 'Knowledge item not found' });
    }

    // Delete file if exists
    if (item.filePath) {
      try {
        await fs.unlink(item.filePath);
      } catch (e) {
        // Ignore file deletion errors
      }
    }

    // Delete from database
    await db.collection('knowledge').deleteOne({
      _id: new ObjectId(req.params.id)
    });

    // Remove from vector index
    const rag = getRAGManager();
    if (rag.initialized) {
      rag.deleteItem(req.params.id).catch(e => console.warn('RAG delete failed:', e.message));
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/knowledge/rebuild-index
 * @desc Rebuild the entire knowledge index
 */
router.post('/rebuild-index', async (req, res) => {
  try {
    const rag = getRAGManager();

    if (!rag.initialized) {
      return res.status(503).json({ error: 'RAG system not initialized' });
    }

    // Rebuild in background
    rag.rebuildIndex()
      .then(result => console.log('RAG rebuild complete:', result))
      .catch(e => console.error('RAG rebuild failed:', e));

    res.json({
      success: true,
      message: 'Index rebuild initiated. This may take a few minutes.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/knowledge/search
 * @desc Search knowledge base (RAG query with vector similarity)
 */
router.get('/search', async (req, res) => {
  try {
    const { q, category, limit = 10, mode = 'hybrid' } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const rag = getRAGManager();
    let items = [];

    // Try vector search first if RAG is initialized
    if (rag.initialized && (mode === 'vector' || mode === 'hybrid')) {
      try {
        items = await rag.vectorStore.search(q, {
          limit: parseInt(limit),
          category,
          minScore: 0.6,
        });
      } catch (e) {
        console.warn('Vector search failed, falling back to text:', e.message);
      }
    }

    // Fall back to text search if no vector results or mode is text/hybrid
    if (items.length === 0 || mode === 'text') {
      const db = getDb();
      const query = {
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { content: { $regex: q, $options: 'i' } },
          { tags: { $in: [q.toLowerCase()] } }
        ]
      };

      if (category) {
        query.category = category;
      }

      const textItems = await db.collection('knowledge')
        .find(query)
        .limit(parseInt(limit))
        .toArray();

      // Merge with vector results (deduplicate)
      const existingIds = new Set(items.map(i => i._id.toString()));
      for (const item of textItems) {
        if (!existingIds.has(item._id.toString())) {
          items.push({ ...item, score: 0.5 }); // Text match score
        }
      }
    }

    res.json({
      query: q,
      mode: rag.initialized ? mode : 'text',
      count: items.length,
      items
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route GET /api/knowledge/stats
 * @desc Get knowledge base statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();

    const stats = await db.collection('knowledge').aggregate([
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          documents: {
            $sum: { $cond: [{ $eq: ['$type', 'document'] }, 1, 0] }
          },
          textEntries: {
            $sum: { $cond: [{ $eq: ['$type', 'text'] }, 1, 0] }
          }
        }
      }
    ]).toArray();

    const total = await db.collection('knowledge').countDocuments();
    const indexed = await db.collection('knowledge').countDocuments({ indexed: true });

    // Get RAG stats
    const rag = getRAGManager();
    let ragStats = { initialized: false };
    if (rag.initialized) {
      try {
        ragStats = await rag.getStats();
      } catch (e) {
        ragStats = { initialized: true, error: e.message };
      }
    }

    res.json({
      total,
      indexed,
      pendingIndex: total - indexed,
      byCategory: stats,
      rag: ragStats,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route POST /api/knowledge/ask
 * @desc Ask a question using RAG-enhanced AI
 */
router.post('/ask', async (req, res) => {
  try {
    const { question, category } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const rag = getRAGManager();

    // Get relevant context
    const context = await rag.getContext(question, { category, limit: 5 });

    // For now, just return the context
    // TODO: Pass to LLM agent for final answer
    res.json({
      question,
      context: context || 'No relevant knowledge found.',
      answer: 'AI answer generation coming soon. For now, review the context above.',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
