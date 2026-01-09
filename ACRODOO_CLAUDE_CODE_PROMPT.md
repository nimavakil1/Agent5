# ACRODOO Implementation Prompt for Claude Code
## Build the ACRODOO AI Odoo Assistant within Agent5

---

## PROJECT CONTEXT

You are working on **Agent5**, an existing Node.js/Express backend with MongoDB, located at `/Users/nimavakil/Agent5`. The project already has:

- **Odoo integration** via `OdooDirectClient` in `/backend/src/core/agents/integrations/OdooMCP.js`
- **MCP tools framework** in `/backend/src/services/mcpTools.js`
- **Specialized AI agents** in `/backend/src/core/agents/specialized/`
- **Module Assistant** with safety framework in `/backend/src/core/agents/specialized/ModuleAssistant.js`
- **Chat API** in `/backend/src/api/routes/chat.api.js`
- **Frontend** in `/backend/src/public/`

The Odoo MCP server is also connected to Claude AI (claude.ai) and works.

**Your mission**: Build ACRODOO - a natural language AI assistant that makes Odoo usable for ACROPAQ employees through natural conversation.

---

## CORE REQUIREMENTS

### 1. Create the ACRODOO Agent (`/backend/src/core/agents/specialized/AcrodooAgent.js`)

Build a new specialized agent that:

```javascript
/**
 * AcrodooAgent - Natural Language Odoo Assistant
 * 
 * Core capabilities:
 * 1. Natural language queries → Odoo domain filters
 * 2. Guided write operations with preview & approval
 * 3. Cross-module intelligence (sales ↔ inventory ↔ accounting)
 * 4. Proactive error prevention
 * 5. Customer-specific learning over time
 */
```

**Key features to implement:**

a) **Intent Classification** - Parse user queries into:
   - READ (safe, auto-execute)
   - WRITE (preview first, require approval)
   - ANALYZE (compute across multiple models)
   - DANGEROUS (block or require multi-approval)

b) **Natural Language to Odoo Domain** - Convert phrases like:
   - "unpaid invoices" → `[['state', '=', 'posted'], ['payment_state', '=', 'not_paid']]`
   - "orders from last week" → `[['date_order', '>=', last_week_date]]`
   - "customer John" → `[['name', 'ilike', 'John']]`

c) **Safety Framework** (follow existing ModuleAssistant pattern):
   - NEVER execute delete/unlink without explicit multi-approval
   - ALWAYS show preview before writes
   - ALWAYS capture before/after state
   - Log everything to AuditLog

d) **Approval Workflow**:
   - Auto-approve: reads, drafts < €1000
   - Single approval: drafts < €10000, updates
   - Multi-approval: posts, amounts >= €10000

### 2. Create ACRODOO Tools (`/backend/src/core/agents/specialized/AcrodooTools.js`)

Extend the existing tools pattern with ACRODOO-specific tools:

```javascript
const ACRODOO_TOOLS = [
  {
    name: 'acrodoo_query',
    description: 'Execute a natural language query against Odoo',
    input_schema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Natural language question about Odoo data' },
        context: { type: 'object', description: 'Additional context (date range, partner, etc.)' }
      }
    }
  },
  {
    name: 'acrodoo_action',
    description: 'Execute an action in Odoo with approval workflow',
    input_schema: {
      type: 'object',
      required: ['action', 'model'],
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'post', 'cancel', 'reverse'] },
        model: { type: 'string' },
        values: { type: 'object' },
        record_id: { type: 'number' },
        preview_only: { type: 'boolean', default: true }
      }
    }
  },
  {
    name: 'acrodoo_analyze',
    description: 'Run cross-module analysis',
    input_schema: {
      type: 'object',
      required: ['analysis_type'],
      properties: {
        analysis_type: { 
          type: 'string', 
          enum: ['sales_trend', 'inventory_health', 'payment_status', 'profitability', 'channel_comparison'] 
        },
        date_range: { type: 'object' },
        filters: { type: 'object' }
      }
    }
  }
];
```

### 3. Create API Routes (`/backend/src/api/routes/acrodoo.api.js`)

```javascript
const router = require('express').Router();

// Chat endpoint - main conversation interface
router.post('/chat', requireSession, async (req, res) => {
  // Accept user message, return ACRODOO response
  // Handle streaming for long responses
});

// Approval endpoint - confirm staged actions
router.post('/approve/:actionId', requireSession, async (req, res) => {
  // Execute staged action after approval
});

// Reject endpoint - cancel staged action
router.post('/reject/:actionId', requireSession, async (req, res) => {
  // Cancel and log rejection reason
});

// History endpoint - get conversation history
router.get('/history', requireSession, async (req, res) => {
  // Return user's conversation history
});

// Staged actions endpoint - get pending approvals
router.get('/staged', requireSession, async (req, res) => {
  // Return actions waiting for approval
});
```

### 4. Create Frontend UI (`/backend/src/public/acrodoo/`)

Create a new module folder with:

a) **index.html** - Main chat interface
b) **acrodoo.js** - Frontend logic

**UI Requirements:**
- Clean chat interface (similar to claude.ai)
- Message history with clear user/assistant distinction
- Action preview cards for write operations
- Approve/Reject buttons for staged actions
- Loading states with streaming text
- Error handling with helpful messages

**Design principles:**
- Use existing Agent5 shell-v2.js styling
- Mobile-responsive
- Dark/light mode support
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)

### 5. Create Database Models

a) **AcrodooConversation** - Store conversations
```javascript
// /backend/src/models/AcrodooConversation.js
{
  userId: ObjectId,
  messages: [{
    role: 'user' | 'assistant',
    content: String,
    timestamp: Date,
    toolCalls: [{ name, params, result }]
  }],
  createdAt: Date,
  updatedAt: Date
}
```

b) **AcrodooStagedAction** - Store pending approvals
```javascript
// /backend/src/models/AcrodooStagedAction.js
{
  userId: ObjectId,
  conversationId: ObjectId,
  action: String,
  model: String,
  values: Object,
  recordId: Number,
  preview: Object,
  beforeState: Object,
  expectedAfterState: Object,
  riskScore: Number,
  approvalType: 'auto' | 'single' | 'multi',
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed',
  approvedBy: [{ userId, timestamp }],
  executedAt: Date,
  result: Object,
  error: String
}
```

---

## IMPLEMENTATION STEPS

### Step 1: Core Agent
1. Create `AcrodooAgent.js` extending `LLMAgent`
2. Implement intent classification
3. Implement natural language → Odoo domain conversion
4. Implement safety checks

### Step 2: Tools
1. Create `AcrodooTools.js` with tool definitions
2. Implement tool executors
3. Add to mcpTools.js registry

### Step 3: API
1. Create `acrodoo.api.js` routes
2. Add to main router in `index.js`
3. Implement streaming support

### Step 4: Models
1. Create MongoDB models
2. Add indexes for performance

### Step 5: Frontend
1. Create `/public/acrodoo/` folder
2. Build chat UI
3. Integrate with API

### Step 6: Testing
1. Test read queries
2. Test write operations with approval
3. Test safety blocks
4. Test error handling

---

## TECHNICAL CONSTRAINTS

1. **Use existing OdooDirectClient** - Don't create new Odoo connection logic
2. **Follow ModuleAssistant patterns** - Especially safety checks
3. **Use Anthropic Claude** - Via existing `AnthropicProvider` in `/backend/src/core/agents/llm/`
4. **MongoDB for state** - Use existing connection
5. **Express routes** - Follow existing API patterns
6. **Vanilla JS frontend** - Match existing shell-v2 style (no React)

---

## SAMPLE CONVERSATIONS

### Example 1: Simple Query
```
User: Show me today's Bol.com orders
Assistant: 📦 Found 23 orders from Bol.com today:

| Order | Customer | Amount | Status |
|-------|----------|--------|--------|
| FBBA000DMJ3LU | Leon Kerckhaert | €17.95 | ✅ Confirmed |
| FBBA000DMHTCT | Shirley Beijers | €19.95 | ✅ Confirmed |
...

Total: €1,847.50 across 23 orders

Would you like to see order details or check picking status?
```

### Example 2: Write with Preview
```
User: Create a new customer called Test Corp B.V.
Assistant: 📝 I'll create a new partner with these details:

| Field | Value |
|-------|-------|
| Name | Test Corp B.V. |
| Type | Company |
| Is Customer | Yes |
| Country | Netherlands |

[Approve] [Edit] [Cancel]

Type "OK" to create, or tell me what to change.
```

### Example 3: Blocked Operation
```
User: Delete customer ID 12345
Assistant: ⚠️ I cannot delete records in Odoo - this could cause data integrity issues.

Instead, I can:
- **Archive** the customer (mark as inactive)
- **Merge** with another customer if duplicate
- Show you what records reference this customer

Which would you prefer?
```

---

## FILES TO CREATE/MODIFY

### New Files:
1. `/backend/src/core/agents/specialized/AcrodooAgent.js`
2. `/backend/src/core/agents/specialized/AcrodooTools.js`
3. `/backend/src/api/routes/acrodoo.api.js`
4. `/backend/src/models/AcrodooConversation.js`
5. `/backend/src/models/AcrodooStagedAction.js`
6. `/backend/src/public/acrodoo/index.html`
7. `/backend/src/public/acrodoo/acrodoo.js`
8. `/backend/src/public/acrodoo/acrodoo.css`

### Files to Modify:
1. `/backend/src/index.js` - Add acrodoo routes
2. `/backend/src/services/mcpTools.js` - Register ACRODOO tools
3. `/backend/src/core/agents/index.js` - Export AcrodooAgent

---

## ODOO MODELS REFERENCE

The most commonly used Odoo models you'll interact with:

| Model | Description | Common Fields |
|-------|-------------|---------------|
| `res.partner` | Customers/Suppliers | name, email, phone, is_company, customer_rank |
| `sale.order` | Sales Orders | name, partner_id, date_order, amount_total, state |
| `account.move` | Invoices/Entries | name, partner_id, invoice_date, amount_total, state, payment_state |
| `stock.picking` | Deliveries | name, partner_id, scheduled_date, state |
| `product.product` | Products | name, default_code, list_price, qty_available |
| `purchase.order` | Purchase Orders | name, partner_id, date_order, amount_total, state |

---

## SUCCESS CRITERIA

1. ✅ User can ask natural language questions about Odoo data
2. ✅ User can execute safe operations with preview/approval
3. ✅ Dangerous operations are blocked with alternatives offered
4. ✅ All actions are logged for audit
5. ✅ UI is intuitive and matches Agent5 style
6. ✅ System handles errors gracefully

---

## START HERE

Begin by creating the core `AcrodooAgent.js` file. This is the brain of the system. Once that's working, build outward to tools, API, and frontend.

Remember: Safety first. Every write operation must be previewed and approved. Never delete - only archive, cancel, or reverse.

Good luck! 🚀
