/**
 * ChatMessage Model
 *
 * Stores chat messages between users and the Module Assistant.
 * Messages are organized by conversations (threads).
 */

const mongoose = require('mongoose');

// Attachment schema
const attachmentSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  originalName: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true },
  path: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  // Attachment cleanup date (90 days from upload)
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  }
}, { _id: true });

const chatMessageSchema = new mongoose.Schema({
  // Conversation grouping
  conversationId: {
    type: String,
    required: true,
    index: true
  },

  // User who sent/received the message
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Message role
  role: {
    type: String,
    enum: ['user', 'assistant', 'system'],
    required: true
  },

  // Message content
  content: {
    type: String,
    required: true
  },

  // Which module this message relates to
  module: {
    type: String,
    enum: ['bol', 'amazon_seller', 'amazon_vendor', 'odoo', 'purchasing', 'general'],
    default: 'general',
    index: true
  },

  // Attachments (for user messages)
  attachments: [attachmentSchema],

  // For assistant messages: what tool was called
  toolCall: {
    name: { type: String },
    input: { type: mongoose.Schema.Types.Mixed },
    output: { type: mongoose.Schema.Types.Mixed },
    success: { type: Boolean }
  },

  // Message metadata
  metadata: {
    // How long the response took to generate
    responseTime: { type: Number },
    // Model used
    model: { type: String },
    // Token usage
    tokensUsed: { type: Number },
    // Was this an execute command?
    wasExecution: { type: Boolean, default: false },
    // IP address for audit
    ipAddress: { type: String }
  },

  // Timestamps
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: false
});

// Compound indexes
chatMessageSchema.index({ conversationId: 1, createdAt: 1 });
chatMessageSchema.index({ userId: 1, createdAt: -1 });
chatMessageSchema.index({ module: 1, createdAt: -1 });

// TTL index to auto-delete old messages after 90 days
chatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Static: Get conversation messages
chatMessageSchema.statics.getConversation = async function(conversationId, limit = 50) {
  return this.find({ conversationId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
};

// Static: Get user's recent conversations
chatMessageSchema.statics.getUserConversations = async function(userId, limit = 20) {
  const conversations = await this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$conversationId',
        lastMessage: { $first: '$content' },
        lastMessageAt: { $first: '$createdAt' },
        module: { $first: '$module' },
        messageCount: { $sum: 1 }
      }
    },
    { $sort: { lastMessageAt: -1 } },
    { $limit: limit }
  ]);

  return conversations;
};

// Static: Create a new conversation ID
chatMessageSchema.statics.createConversationId = function(userId) {
  return `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Static: Add a message to a conversation
chatMessageSchema.statics.addMessage = async function(data) {
  const message = await this.create(data);
  return message;
};

// Static: Get messages for context (for feeding back to LLM)
chatMessageSchema.statics.getContextMessages = async function(conversationId, limit = 10) {
  const messages = await this.find({ conversationId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  // Reverse to get chronological order
  return messages.reverse().map(m => ({
    role: m.role,
    content: m.content
  }));
};

// Static: Find expired attachments
chatMessageSchema.statics.findExpiredAttachments = async function() {
  return this.find({
    'attachments.expiresAt': { $lte: new Date() }
  }).select('attachments').lean();
};

// Static: Mark attachment as deleted
chatMessageSchema.statics.markAttachmentDeleted = async function(messageId, attachmentId) {
  return this.updateOne(
    { _id: messageId, 'attachments._id': attachmentId },
    {
      $set: {
        'attachments.$.path': 'DELETED',
        'attachments.$.deletedAt': new Date()
      }
    }
  );
};

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
