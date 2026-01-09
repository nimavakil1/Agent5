# ACRODOO Build Instructions for Claude Code

Build ACRODOO - a natural language AI assistant for Odoo - integrated into the existing Agent5 platform.

## What is ACRODOO?

ACRODOO is an AI-powered conversational interface that lets users interact with Odoo ERP using natural language instead of navigating complex menus. It's the "intelligence layer" on top of Odoo.

**Example interactions:**
- User: "Show me unpaid invoices from last month" → Agent queries Odoo, formats results nicely
- User: "Create a new customer called Test Corp B.V." → Agent shows preview, waits for approval, then creates
- User: "What's our best selling product this year?" → Agent analyzes sales data, returns insights

## Before You Start - Read These Files

1. **Existing Odoo integration:** `/backend/src/core/agents/integrations/OdooMCP.js` - This has `OdooDirectClient` class with all Odoo methods (searchRead, create, write, etc.)

2. **Existing agent pattern:** `/backend/src/core/agents/specialized/ModuleAssistant.js` - Follow this pattern for safety rules and structure

3. **Existing tools pattern:** `/backend/src/services/mcpTools.js` - See how tools are defined and called

4. **LLM base class:** `/backend/src/core/agents/LLMAgent.js` - Extend this for the agent

5. **Anthropic provider:** `/backend/src/core/agents/llm/AnthropicProvider.js` - Use this for Claude API calls

## What to Build

### 1. AcrodooAgent.js (`/backend/src/core/agents/specialized/AcrodooAgent.js`)

Create a new agent class that:
- Extends LLMAgent
- Uses Anthropic Claude (claude-sonnet-4-20250514 or claude-3-5-sonnet)
- Has a system prompt that teaches it about Odoo models and ACROPAQ's business
- Classifies user intent (READ vs WRITE vs ANALYZE)
- Converts natural language to Odoo domain filters
- For writes: shows preview first, requires "OK" or approval before executing
- NEVER deletes - only archives, cancels, or reverses

**System prompt should include:**
- List of main Odoo models (res.partner, sale.order, account.move, stock.picking, product.product, purchase.order)
- Common field names and relationships
- Safety rules (no delete, preview before write)
- How to format responses (tables for lists, cards for single records)

### 2. AcrodooTools.js (`/backend/src/core/agents/specialized/AcrodooTools.js`)

Define tools the agent can use:

```javascript
const ACRODOO_TOOLS = [
  {
    name: 'odoo_query',
    description: 'Search Odoo records using domain filters',
    input_schema: {
      type: 'object',
      required: ['model', 'domain'],
      properties: {
        model: { type: 'string' },
        domain: { type: 'array' },
        fields: { type: 'array' },
        limit: { type: 'number' },
        order: { type: 'string' }
      }
    }
  },
  {
    name: 'odoo_read',
    description: 'Read specific record by ID',
    input_schema: {
      type: 'object',
      required: ['model', 'id'],
      properties: {
        model: { type: 'string' },
        id: { type: 'number' },
        fields: { type: 'array' }
      }
    }
  },
  {
    name: 'odoo_create_preview',
    description: 'Preview what a new record would look like (does not create)',
    input_schema: {
      type: 'object',
      required: ['model', 'values'],
      properties: {
        model: { type: 'string' },
        values: { type: 'object' }
      }
    }
  },
  {
    name: 'odoo_create',
    description: 'Create a new record (only after user approval)',
    input_schema: {
      type: 'object',
      required: ['model', 'values', 'user_approved'],
      properties: {
        model: { type: 'string' },
        values: { type: 'object' },
        user_approved: { type: 'boolean' }
      }
    }
  },
  {
    name: 'odoo_update_preview',
    description: 'Preview what changes would be made to a record',
    input_schema: {
      type: 'object',
      required: ['model', 'id', 'values'],
      properties: {
        model: { type: 'string' },
        id: { type: 'number' },
        values: { type: 'object' }
      }
    }
  },
  {
    name: 'odoo_update',
    description: 'Update a record (only after user approval)',
    input_schema: {
      type: 'object',
      required: ['model', 'id', 'values', 'user_approved'],
      properties: {
        model: { type: 'string' },
        id: { type: 'number' },
        values: { type: 'object' },
        user_approved: { type: 'boolean' }
      }
    }
  }
];
```

Implement tool executor that uses OdooDirectClient.

### 3. API Routes (`/backend/src/api/routes/acrodoo.api.js`)

```javascript
const router = require('express').Router();
const { requireSession } = require('../../middleware/sessionAuth');

// Main chat endpoint
router.post('/chat', requireSession, async (req, res) => {
  const { message, conversationId } = req.body;
  // Call AcrodooAgent, return response
  // Support streaming with SSE if message is long
});

// Get conversation history
router.get('/conversations', requireSession, async (req, res) => {
  // Return user's past conversations
});

// Get single conversation
router.get('/conversations/:id', requireSession, async (req, res) => {
  // Return conversation with all messages
});

module.exports = router;
```

Add to `/backend/src/index.js`:
```javascript
const acrodooRouter = require('./api/routes/acrodoo.api');
app.use('/api/acrodoo', requireSession, acrodooRouter);
```

### 4. MongoDB Model (`/backend/src/models/AcrodooConversation.js`)

```javascript
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
  toolCalls: [{
    name: String,
    params: mongoose.Schema.Types.Mixed,
    result: mongoose.Schema.Types.Mixed
  }],
  timestamp: { type: Date, default: Date.now }
});

const conversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New conversation' },
  messages: [messageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

conversationSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model('AcrodooConversation', conversationSchema);
```

### 5. Frontend UI (`/backend/src/public/acrodoo/`)

Create these files:

**index.html** - Chat interface with:
- Message list (scrollable)
- Input box at bottom
- Send button
- Conversation sidebar (list of past chats)
- New chat button

**acrodoo.js** - Frontend logic:
- Send messages to /api/acrodoo/chat
- Render responses (handle markdown, tables)
- Handle streaming responses
- Load/save conversations

**acrodoo.css** - Styling:
- Match existing Agent5 dark theme
- Clean chat bubbles
- Code/table formatting

Add to index.js protected sections:
```javascript
protectedSections.push('acrodoo');
```

## Safety Rules (CRITICAL)

1. **NEVER execute unlink/delete** - Block it in code, not just prompts
2. **ALWAYS preview writes** - Show what will change before doing it
3. **REQUIRE explicit approval** - User must say "OK", "yes", "approve", etc.
4. **Log everything** - Use AuditLog model for all write operations
5. **Offer alternatives** - If user asks to delete, suggest archive/cancel/reverse

## Odoo Models Quick Reference

| Model | Use | Key Fields |
|-------|-----|------------|
| res.partner | Customers/Suppliers | name, email, phone, is_company, customer_rank, supplier_rank |
| sale.order | Sales Orders | name, partner_id, date_order, amount_total, state, warehouse_id |
| account.move | Invoices | name, partner_id, invoice_date, amount_total, state, payment_state, move_type |
| stock.picking | Deliveries | name, partner_id, scheduled_date, state, picking_type_id |
| product.product | Products | name, default_code (SKU), list_price, qty_available, categ_id |
| purchase.order | Purchase Orders | name, partner_id, date_order, amount_total, state |

## Common Odoo Domains

```javascript
// Unpaid invoices
[['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', '!=', 'paid']]

// Orders from today
[['date_order', '>=', '2025-01-07 00:00:00']]

// Customer search
[['customer_rank', '>', 0], ['name', 'ilike', 'searchterm']]

// Products with stock
[['qty_available', '>', 0]]

// Confirmed sales orders
[['state', 'in', ['sale', 'done']]]
```

## Test These Scenarios

1. "Show me today's orders" - Should query sale.order with today's date
2. "Find customer Bakker" - Should search res.partner with ilike
3. "What invoices are overdue?" - Should find unpaid invoices past due date
4. "Create customer Test B.V." - Should show preview, wait for approval
5. "Delete order 123" - Should REFUSE and offer to cancel instead

## Start Building

Begin with AcrodooAgent.js - that's the core. Get the basic chat working with read queries first, then add write capabilities with the preview/approve flow.

Use the existing patterns in ModuleAssistant.js and mcpTools.js as templates.
