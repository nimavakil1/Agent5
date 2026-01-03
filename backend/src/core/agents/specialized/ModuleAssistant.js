/**
 * ModuleAssistant - AI-powered assistant for module operations
 *
 * This agent can:
 * - Answer questions about module functionality and status
 * - Execute safe operations (create, update, sync)
 * - NEVER execute delete operations (only reversals like cancel, reverse invoice)
 *
 * Safety rules are enforced at the code level, not just prompts.
 *
 * Modules: bol, amazon_seller, amazon_vendor, odoo, purchasing
 */

const { LLMAgent } = require('../LLMAgent');
const { getModuleLogger } = require('../../../services/logging/ModuleLogger');
const ChatPermission = require('../../../models/ChatPermission');

// Safety: List of FORBIDDEN operations (never allowed)
const FORBIDDEN_OPERATIONS = [
  'delete',
  'remove',
  'destroy',
  'drop',
  'truncate',
  'purge',
  'erase',
  'wipe',
  'unlink' // Odoo's delete method
];

// Safety: Allowed reversal operations (these are safe alternatives to delete)
const ALLOWED_REVERSALS = [
  'cancel',
  'reverse',
  'void',
  'credit',
  'refund',
  'return',
  'undo'
];

class ModuleAssistant extends LLMAgent {
  constructor(config = {}) {
    const systemPrompt = `You are a helpful AI assistant for managing e-commerce operations.
You have access to multiple modules: Bol.com, Amazon Seller, Amazon Vendor, Odoo ERP, and Purchasing.

## CRITICAL SAFETY RULES - READ CAREFULLY

1. **NEVER DELETE DATA**
   - You are FORBIDDEN from executing any delete, remove, destroy, or similar operations
   - If a user asks to delete something, explain that deletion is not allowed
   - Instead, offer to CANCEL, REVERSE, or VOID the record

2. **REVERSAL OPERATIONS ARE ALLOWED**
   - Cancelling an order is OK
   - Reversing an invoice (creating a credit note) is OK
   - Voiding a payment is OK
   - Marking something as inactive is OK

3. **ALWAYS CONFIRM BEFORE EXECUTING**
   - For any operation that modifies data, explain what you're about to do
   - Ask for confirmation before proceeding
   - Never execute multiple operations without user approval between each

4. **BE TRANSPARENT**
   - Always explain what the operation will do
   - Show the current state before modifying
   - Show the result after modifying

5. **LOG EVERYTHING**
   - All operations are logged for audit
   - Users can see what was done and when

## YOUR CAPABILITIES

### Bol.com Module
- View orders, shipments, returns
- Check stock levels and sync status
- View scheduled jobs and their status
- Cancel orders (NOT delete)
- Confirm shipments
- Check FBB/FBR fulfillment status

### Amazon Seller Module
- View orders and their status
- Check inventory levels
- View returns and refunds
- Sync order data from Amazon
- Push tracking information

### Amazon Vendor Module
- View purchase orders
- Check delivery schedules
- View invoices and their status
- Submit invoices to Amazon
- Check invoice processing status

### Odoo ERP Module
- View products and inventory
- Check sale orders and invoices
- View delivery status
- Create/update records (NOT delete)
- Reverse invoices (create credit notes)

### Purchasing Module
- View forecasts and recommendations
- Check supplier lead times
- View purchase orders
- Analyze stock levels and trends

## WHEN ANSWERING QUESTIONS

1. Be concise but thorough
2. Use bullet points for lists
3. Format numbers with proper thousands separators
4. Include dates in readable format
5. If you don't know something, say so

## WHEN EXECUTING COMMANDS

1. Parse the user's intent carefully
2. Check if you have permission to execute
3. If the operation involves "delete" - REFUSE and suggest alternatives
4. Explain what you're about to do
5. Execute with proper error handling
6. Report the result clearly`;

    super({
      name: config.name || 'Module Assistant',
      role: 'module_assistant',
      taskType: 'operational',
      capabilities: [
        'answer_questions',
        'execute_commands',
        'view_data',
        'create_records',
        'update_records',
        'sync_data',
        'cancel_records',
        'reverse_records'
      ],
      llmConfig: {
        systemPrompt,
        temperature: 0.4,
        maxTokens: 4000,
      },
      // Use Claude Opus 4.5 for best reasoning
      llmProvider: 'anthropic',
      llmModel: 'opus',
      ...config,
    });

    // Module loggers for audit
    this.loggers = {
      bol: getModuleLogger('bol'),
      amazon_seller: getModuleLogger('amazon_seller'),
      amazon_vendor: getModuleLogger('amazon_vendor'),
      odoo: getModuleLogger('odoo'),
      purchasing: getModuleLogger('purchasing')
    };

    // Module services (injected)
    this.services = config.services || {};

    // Current user context
    this.userContext = null;
  }

  /**
   * Set the current user context for permission checking
   */
  setUserContext(user) {
    this.userContext = user;
  }

  /**
   * Check if user can chat with a module
   */
  async canUserChat(module) {
    if (!this.userContext?._id) return false;
    return ChatPermission.canUserChat(this.userContext._id, module);
  }

  /**
   * Check if user can execute commands for a module
   */
  async canUserExecute(module) {
    if (!this.userContext?._id) return false;
    return ChatPermission.canUserExecute(this.userContext._id, module);
  }

  /**
   * Safety check: Ensure operation is not a forbidden delete
   */
  isForbiddenOperation(operationName, params = {}) {
    const lowerOp = (operationName || '').toLowerCase();

    // Check if operation name contains forbidden words
    for (const forbidden of FORBIDDEN_OPERATIONS) {
      if (lowerOp.includes(forbidden)) {
        return {
          forbidden: true,
          reason: `Operation "${operationName}" is forbidden. Delete operations are not allowed.`,
          suggestion: this._getSafeAlternative(operationName)
        };
      }
    }

    // Check params for dangerous indicators
    const paramStr = JSON.stringify(params).toLowerCase();
    for (const forbidden of FORBIDDEN_OPERATIONS) {
      if (paramStr.includes(`"action":"${forbidden}"`) ||
          paramStr.includes(`"method":"${forbidden}"`) ||
          paramStr.includes(`"operation":"${forbidden}"`)) {
        return {
          forbidden: true,
          reason: `Parameters contain forbidden operation: ${forbidden}`,
          suggestion: this._getSafeAlternative(forbidden)
        };
      }
    }

    return { forbidden: false };
  }

  /**
   * Get a safe alternative for a forbidden operation
   */
  _getSafeAlternative(operation) {
    const lowerOp = (operation || '').toLowerCase();

    if (lowerOp.includes('order') || lowerOp.includes('sale')) {
      return 'Consider using "cancel order" instead of delete.';
    }
    if (lowerOp.includes('invoice')) {
      return 'Consider using "reverse invoice" or "create credit note" instead of delete.';
    }
    if (lowerOp.includes('product') || lowerOp.includes('item')) {
      return 'Consider using "archive product" or "mark inactive" instead of delete.';
    }
    if (lowerOp.includes('customer') || lowerOp.includes('partner')) {
      return 'Consider using "archive customer" or "mark inactive" instead of delete.';
    }
    return 'Consider using a reversal operation (cancel, void, reverse) instead of delete.';
  }

  /**
   * Override tool execution to enforce safety
   */
  async _executeTool(toolName, params) {
    // Safety check
    const safetyCheck = this.isForbiddenOperation(toolName, params);
    if (safetyCheck.forbidden) {
      await this._logAction('BLOCKED_FORBIDDEN_OPERATION', {
        tool: toolName,
        params,
        reason: safetyCheck.reason
      });

      return {
        success: false,
        error: safetyCheck.reason,
        suggestion: safetyCheck.suggestion
      };
    }

    // Log the execution attempt
    const module = this._getModuleFromTool(toolName);
    if (module && this.loggers[module]) {
      await this.loggers[module].info('ASSISTANT_EXECUTE', `Executing ${toolName}`, {
        triggeredBy: this.userContext?.email || 'assistant',
        details: { tool: toolName, params }
      });
    }

    // Execute the actual tool
    try {
      const result = await super._executeTool(toolName, params);

      // Log success
      if (module && this.loggers[module]) {
        await this.loggers[module].success('ASSISTANT_EXECUTE', `Executed ${toolName} successfully`, {
          triggeredBy: this.userContext?.email || 'assistant',
          details: { tool: toolName, result: typeof result === 'object' ? result : { value: result } }
        });
      }

      return result;
    } catch (error) {
      // Log failure
      if (module && this.loggers[module]) {
        await this.loggers[module].error('ASSISTANT_EXECUTE', `Failed to execute ${toolName}`, error, {
          triggeredBy: this.userContext?.email || 'assistant',
          details: { tool: toolName, params }
        });
      }

      throw error;
    }
  }

  /**
   * Determine which module a tool belongs to
   */
  _getModuleFromTool(toolName) {
    const lowerTool = (toolName || '').toLowerCase();

    if (lowerTool.includes('bol') || lowerTool.includes('fbb') || lowerTool.includes('fbr')) {
      return 'bol';
    }
    if (lowerTool.includes('amazon') && lowerTool.includes('seller')) {
      return 'amazon_seller';
    }
    if (lowerTool.includes('amazon') && lowerTool.includes('vendor')) {
      return 'amazon_vendor';
    }
    if (lowerTool.includes('odoo') || lowerTool.includes('erp')) {
      return 'odoo';
    }
    if (lowerTool.includes('purchasing') || lowerTool.includes('forecast') || lowerTool.includes('reorder')) {
      return 'purchasing';
    }

    return null;
  }

  /**
   * Log an action for audit
   */
  async _logAction(action, details = {}) {
    console.log(`[ModuleAssistant] ${action}:`, JSON.stringify(details));
  }

  /**
   * Process a user message with safety checks
   */
  async processMessage(message, module = 'general', conversationHistory = []) {
    // Check if user can chat with this module
    if (module !== 'general') {
      const canChat = await this.canUserChat(module);
      if (!canChat) {
        return {
          success: false,
          error: 'You do not have permission to chat with this module.',
          module
        };
      }
    }

    // Check for forbidden operations in the message
    const messageLower = (message || '').toLowerCase();
    for (const forbidden of FORBIDDEN_OPERATIONS) {
      if (messageLower.includes(forbidden)) {
        const alternative = this._getSafeAlternative(messageLower);
        return {
          success: true,
          response: `I cannot perform ${forbidden} operations as they are not allowed for safety reasons.\n\n${alternative}\n\nWould you like me to help you with a safe alternative?`,
          wasBlocked: true,
          module
        };
      }
    }

    // Build context messages
    const contextMessages = conversationHistory.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Add module context
    const moduleContext = this._getModuleContext(module);
    contextMessages.unshift({
      role: 'system',
      content: moduleContext
    });

    // Add the new user message
    contextMessages.push({
      role: 'user',
      content: message
    });

    try {
      // Use LLM to generate response
      const response = await this.llmProvider.chat(contextMessages);

      return {
        success: true,
        response: response.content,
        module,
        tokensUsed: response.usage?.total_tokens
      };
    } catch (error) {
      console.error('[ModuleAssistant] Error processing message:', error);
      return {
        success: false,
        error: 'Failed to process your message. Please try again.',
        module
      };
    }
  }

  /**
   * Get context information for a specific module
   */
  _getModuleContext(module) {
    const contexts = {
      bol: `You are currently assisting with the Bol.com module.
This module handles:
- FBB (Fulfilled by Bol) and FBR (Fulfilled by Retailer) orders
- Stock synchronization with Bol.com
- Shipment confirmations
- Returns processing
- Invoice booking to Odoo

Scheduled jobs:
- Nightly extended sync at 3:00 AM
- Order polling every 15 minutes
- Stock sync every 15 minutes
- Shipment check every 5 minutes
- Returns sync every hour`,

      amazon_seller: `You are currently assisting with the Amazon Seller module.
This module handles:
- FBA (Fulfilled by Amazon) and FBM (Fulfilled by Merchant) orders
- Order synchronization from Amazon
- Tracking number push to Amazon
- Returns and refunds
- VCS (VAT Calculation Service) invoicing

Scheduled jobs:
- Order polling every 15 minutes
- Tracking push every 5 minutes`,

      amazon_vendor: `You are currently assisting with the Amazon Vendor module.
This module handles:
- Purchase Orders from Amazon
- Invoice submission to Amazon EDI
- Shipment confirmations
- Stock availability updates
- Payment advices

Key workflows:
- PO reception and confirmation
- ASN (Advance Shipment Notice)
- Invoice generation and submission`,

      odoo: `You are currently assisting with the Odoo ERP module.
This module handles:
- Product management
- Sale orders and invoices
- Delivery orders (stock.picking)
- Customer (res.partner) management
- Warehouse operations

Important: All sales from Amazon and Bol.com flow into Odoo as sale orders and invoices.`,

      purchasing: `You are currently assisting with the Purchasing Intelligence module.
This module handles:
- Demand forecasting
- Reorder point calculations
- Chinese New Year planning
- Seasonal adjustments
- Supplier lead time management

Key features:
- Uses invoiced quantities (not ordered) for accuracy
- Applies substitution adjustments
- Considers Belgian retail seasons`,

      general: `You are a general assistant that can help with multiple modules.
Ask me which module you need help with:
- Bol.com (FBB/FBR orders, stock, shipments)
- Amazon Seller (FBA/FBM orders, tracking)
- Amazon Vendor (Purchase Orders, invoices)
- Odoo (ERP, products, inventory)
- Purchasing (forecasting, reorder planning)`
    };

    return contexts[module] || contexts.general;
  }

  /**
   * Get available modules for a user
   */
  async getAvailableModules(userId) {
    const permission = await ChatPermission.getForUser(userId);
    if (!permission) return [];

    const available = [];
    const modules = ['bol', 'amazon_seller', 'amazon_vendor', 'odoo', 'purchasing'];

    for (const mod of modules) {
      if (permission.modules[mod]?.canChat) {
        available.push({
          id: mod,
          name: this._getModuleName(mod),
          canExecute: permission.modules[mod]?.canExecute === true
        });
      }
    }

    return available;
  }

  /**
   * Get human-readable module name
   */
  _getModuleName(module) {
    const names = {
      bol: 'Bol.com',
      amazon_seller: 'Amazon Seller',
      amazon_vendor: 'Amazon Vendor',
      odoo: 'Odoo ERP',
      purchasing: 'Purchasing Intelligence'
    };
    return names[module] || module;
  }
}

// Singleton instance
let instance = null;

function getModuleAssistant(config = {}) {
  if (!instance) {
    instance = new ModuleAssistant(config);
  }
  return instance;
}

module.exports = {
  ModuleAssistant,
  getModuleAssistant,
  FORBIDDEN_OPERATIONS,
  ALLOWED_REVERSALS
};
