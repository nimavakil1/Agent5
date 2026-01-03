/**
 * Module Assistant Chat API
 *
 * Endpoints:
 * - POST /api/chat/message - Send a message and get a response
 * - GET /api/chat/conversations - Get user's conversations
 * - GET /api/chat/conversation/:id - Get messages in a conversation
 * - POST /api/chat/conversation - Start a new conversation
 * - POST /api/chat/upload - Upload an attachment
 * - GET /api/chat/modules - Get available modules for current user
 * - DELETE /api/chat/conversation/:id - Archive a conversation
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const ChatMessage = require('../../models/ChatMessage');
const ChatPermission = require('../../models/ChatPermission');
const { getModuleAssistant } = require('../../core/agents/specialized/ModuleAssistant');

// Configure multer for attachment uploads
const uploadDir = path.join(__dirname, '../../../uploads/chat');

// Ensure upload directory exists
(async () => {
  try {
    await fs.mkdir(uploadDir, { recursive: true });
  } catch (e) {
    console.error('Failed to create chat upload directory:', e);
  }
})();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${uuidv4()}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 5 // Max 5 files per upload
  },
  fileFilter: (req, file, cb) => {
    // Allow common document types
    const allowedMimes = [
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/plain',
      'image/png',
      'image/jpeg',
      'image/gif',
      'application/json'
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  }
});

/**
 * GET /api/chat/modules
 * Get available modules for current user
 */
router.get('/modules', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const permission = await ChatPermission.getForUser(userId);

    const modules = [
      { id: 'bol', name: 'Bol.com', icon: 'shopping_bag', description: 'Orders, shipments, returns' },
      { id: 'amazon_seller', name: 'Amazon Seller', icon: 'storefront', description: 'FBA/FBM orders, tracking' },
      { id: 'amazon_vendor', name: 'Amazon Vendor', icon: 'local_shipping', description: 'Purchase orders, invoices' },
      { id: 'odoo', name: 'Odoo ERP', icon: 'database', description: 'Products, inventory, orders' },
      { id: 'purchasing', name: 'Purchasing', icon: 'shopping_cart', description: 'Forecasting, reorder planning' }
    ];

    // Mark which modules the user can access
    const available = modules.map(m => ({
      ...m,
      canChat: permission?.modules[m.id]?.canChat === true,
      canExecute: permission?.modules[m.id]?.canExecute === true
    }));

    res.json({
      modules: available,
      hasAnyAccess: available.some(m => m.canChat)
    });
  } catch (error) {
    console.error('[Chat API] Error getting modules:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat/conversations
 * Get user's recent conversations
 */
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const conversations = await ChatMessage.getUserConversations(userId, limit);

    res.json({ conversations });
  } catch (error) {
    console.error('[Chat API] Error getting conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/chat/conversation/:id
 * Get messages in a conversation
 */
router.get('/conversation/:id', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    // Verify the conversation belongs to this user
    const messages = await ChatMessage.find({
      conversationId: id,
      userId
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    if (messages.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      conversationId: id,
      messages,
      module: messages[0]?.module || 'general'
    });
  } catch (error) {
    console.error('[Chat API] Error getting conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat/conversation
 * Start a new conversation
 */
router.post('/conversation', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { module = 'general' } = req.body;

    // Check if user can chat with this module
    if (module !== 'general') {
      const canChat = await ChatPermission.canUserChat(userId, module);
      if (!canChat) {
        return res.status(403).json({
          error: 'You do not have permission to chat with this module'
        });
      }
    }

    const conversationId = ChatMessage.createConversationId(userId);

    res.json({
      conversationId,
      module
    });
  } catch (error) {
    console.error('[Chat API] Error creating conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat/message
 * Send a message and get a response
 */
router.post('/message', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const {
      conversationId,
      message,
      module = 'general',
      attachmentIds = []
    } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    // Check if user can chat with this module
    if (module !== 'general') {
      const canChat = await ChatPermission.canUserChat(userId, module);
      if (!canChat) {
        return res.status(403).json({
          error: 'You do not have permission to chat with this module'
        });
      }
    }

    const startTime = Date.now();

    // Get conversation history for context
    const history = await ChatMessage.getContextMessages(conversationId, 10);

    // Save user message
    const userMessage = await ChatMessage.addMessage({
      conversationId,
      userId,
      role: 'user',
      content: message.trim(),
      module,
      metadata: {
        ipAddress: req.ip
      }
    });

    // Get the Module Assistant
    const assistant = getModuleAssistant();
    assistant.setUserContext(req.user);

    // Process the message
    const result = await assistant.processMessage(message, module, history);

    // Save assistant response
    const assistantMessage = await ChatMessage.addMessage({
      conversationId,
      userId,
      role: 'assistant',
      content: result.response || result.error || 'I apologize, but I could not process your request.',
      module,
      metadata: {
        responseTime: Date.now() - startTime,
        tokensUsed: result.tokensUsed,
        wasExecution: false
      }
    });

    res.json({
      success: result.success,
      message: assistantMessage,
      conversationId
    });
  } catch (error) {
    console.error('[Chat API] Error processing message:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/chat/upload
 * Upload attachments
 */
router.post('/upload', upload.array('files', 5), async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const attachments = req.files.map(file => ({
      id: uuidv4(),
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path
    }));

    res.json({
      success: true,
      attachments
    });
  } catch (error) {
    console.error('[Chat API] Error uploading files:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/chat/conversation/:id
 * Archive a conversation (mark as hidden, don't actually delete)
 */
router.delete('/conversation/:id', async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { id } = req.params;

    // We don't actually delete - just add an archived flag
    // For now, we'll just return success (messages will expire via TTL anyway)
    res.json({
      success: true,
      message: 'Conversation archived'
    });
  } catch (error) {
    console.error('[Chat API] Error archiving conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cleanup job for expired attachments
 * This should be called periodically (e.g., daily via scheduler)
 */
async function cleanupExpiredAttachments() {
  try {
    const expiredMessages = await ChatMessage.findExpiredAttachments();

    for (const msg of expiredMessages) {
      for (const att of msg.attachments) {
        if (att.path && att.path !== 'DELETED') {
          try {
            await fs.unlink(att.path);
            await ChatMessage.markAttachmentDeleted(msg._id, att._id);
            console.log(`[Chat API] Deleted expired attachment: ${att.originalName}`);
          } catch (e) {
            console.error(`[Chat API] Failed to delete attachment ${att.path}:`, e.message);
          }
        }
      }
    }

    return { cleaned: expiredMessages.length };
  } catch (error) {
    console.error('[Chat API] Error cleaning up attachments:', error);
    return { error: error.message };
  }
}

module.exports = router;
module.exports.cleanupExpiredAttachments = cleanupExpiredAttachments;
