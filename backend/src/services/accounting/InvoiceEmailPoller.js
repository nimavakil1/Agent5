/**
 * InvoiceEmailPoller - Monitor email inbox for incoming invoices
 *
 * Uses Microsoft Graph API via existing MicrosoftMCP integration.
 */

const { MicrosoftDirectClient } = require('../../core/agents/integrations/MicrosoftMCP');
const VendorInvoice = require('../../models/VendorInvoice');
const AccountingTask = require('../../models/AccountingTask');
const InvoiceAuditLog = require('../../models/InvoiceAuditLog');
const InvoiceParser = require('./InvoiceParser');

class InvoiceEmailPoller {
  constructor() {
    this.msClient = null;
    this.parser = new InvoiceParser();

    // Configuration
    this.config = {
      targetMailbox: process.env.INVOICE_MAILBOX_USER_ID || 'invoices@acropaq.com',
      targetFolder: 'Inbox',
      processedFolder: 'Processed Invoices',
      errorFolder: 'Invoice Errors',
      maxMessagesPerPoll: 25,
      supportedAttachmentTypes: [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/tiff',
        'application/xml',
        'text/xml',
      ],
      invoiceKeywords: [
        'invoice', 'facture', 'rechnung', 'factuur', 'factura',
        'bill', 'payment', 'betaling', 'zahlung',
      ],
    };

    // Track last poll time for delta queries
    this.lastPollTime = null;
  }

  /**
   * Initialize Microsoft client
   */
  async _ensureClient() {
    if (!this.msClient) {
      this.msClient = new MicrosoftDirectClient();
    }
  }

  /**
   * Scan inbox for invoice emails
   * @param {Object} options - Scan options
   */
  async scanForInvoices(options = {}) {
    await this._ensureClient();

    const folder = options.folder || this.config.targetFolder;
    const hoursBack = options.hoursBack || 24;

    console.log(`[InvoiceEmailPoller] Scanning ${folder} for invoices (last ${hoursBack} hours)`);

    const result = {
      scanned: 0,
      invoiceEmails: 0,
      created: 0,
      skipped: 0,
      errors: [],
    };

    try {
      // Calculate time filter
      const sinceTime = new Date();
      sinceTime.setHours(sinceTime.getHours() - hoursBack);
      const sinceTimeStr = sinceTime.toISOString();

      // Query messages with attachments
      const messages = await this._getMessagesWithAttachments(folder, sinceTimeStr);
      result.scanned = messages.length;

      console.log(`[InvoiceEmailPoller] Found ${messages.length} messages with attachments`);

      for (const message of messages) {
        try {
          // Check if likely an invoice
          if (!this._isLikelyInvoice(message)) {
            result.skipped++;
            continue;
          }

          result.invoiceEmails++;

          // Check if already processed
          const existing = await VendorInvoice.findOne({
            'source.emailId': message.id,
          });

          if (existing) {
            console.log(`[InvoiceEmailPoller] Email already processed: ${message.id}`);
            result.skipped++;
            continue;
          }

          // Create invoice record
          const invoice = await this._createInvoiceFromEmail(message);
          result.created++;

          // Process immediately if requested
          if (options.processImmediately) {
            const { processInvoice } = require('./InvoiceProcessor');
            await processInvoice(invoice._id);
          }

        } catch (error) {
          console.error(`[InvoiceEmailPoller] Error processing email ${message.id}:`, error.message);
          result.errors.push({
            emailId: message.id,
            subject: message.subject,
            error: error.message,
          });
        }
      }

      this.lastPollTime = new Date();

    } catch (error) {
      console.error('[InvoiceEmailPoller] Scan error:', error.message);
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Get messages with attachments from folder
   */
  async _getMessagesWithAttachments(folder, sinceTime) {
    const userId = this.config.targetMailbox;

    // Build filter
    let filter = `hasAttachments eq true`;
    if (sinceTime) {
      filter += ` and receivedDateTime ge ${sinceTime}`;
    }

    const messages = await this.msClient._request(
      'GET',
      `/users/${userId}/mailFolders/${folder}/messages`,
      null,
      {
        $filter: filter,
        $select: 'id,subject,from,receivedDateTime,bodyPreview,hasAttachments',
        $top: this.config.maxMessagesPerPoll,
        $orderby: 'receivedDateTime desc',
      }
    );

    return messages.value || [];
  }

  /**
   * Check if an email is likely an invoice
   */
  _isLikelyInvoice(message) {
    const subject = (message.subject || '').toLowerCase();
    const body = (message.bodyPreview || '').toLowerCase();
    const fromAddress = message.from?.emailAddress?.address || '';

    // Check keywords
    const hasKeyword = this.config.invoiceKeywords.some(kw =>
      subject.includes(kw) || body.includes(kw)
    );

    // Check for common invoice patterns
    const hasInvoiceNumber = /inv[oice]*[\s\-#:]*\d+/i.test(subject + body);
    const hasAmount = /(?:€|EUR|USD|\$)\s*\d+[.,]\d{2}/i.test(body);

    return hasKeyword || hasInvoiceNumber || hasAmount;
  }

  /**
   * Create a VendorInvoice record from an email
   */
  async _createInvoiceFromEmail(message) {
    console.log(`[InvoiceEmailPoller] Creating invoice from email: ${message.subject}`);

    const userId = this.config.targetMailbox;

    // Get attachments
    const attachments = await this._getMessageAttachments(userId, message.id);

    // Filter to supported types
    const validAttachments = attachments.filter(att =>
      this.config.supportedAttachmentTypes.includes(att.contentType)
    );

    if (validAttachments.length === 0) {
      throw new Error('No valid invoice attachments found');
    }

    // Use the first valid attachment
    const attachment = validAttachments[0];

    // Parse the attachment
    const attachmentBuffer = Buffer.from(attachment.contentBytes, 'base64');
    let extractedData = null;

    try {
      extractedData = await this.parser.parseInvoice(
        attachmentBuffer,
        attachment.contentType,
        attachment.name
      );
    } catch (error) {
      console.error('[InvoiceEmailPoller] Parse error:', error.message);
      // Continue with minimal data
    }

    // Create invoice record
    const invoice = new VendorInvoice({
      source: {
        type: 'email',
        emailId: message.id,
        emailSubject: message.subject,
        emailFrom: message.from?.emailAddress?.address,
        receivedAt: new Date(message.receivedDateTime),
        attachmentName: attachment.name,
        attachmentSize: attachment.size,
        attachmentContentType: attachment.contentType,
      },
      vendor: extractedData?.vendor || {
        name: this._extractVendorFromEmail(message),
      },
      invoice: extractedData?.invoice || {
        number: this._extractInvoiceNumberFromSubject(message.subject),
        currency: 'EUR',
      },
      lines: extractedData?.lines || [],
      totals: extractedData?.totals || {
        subtotal: 0,
        vatAmount: 0,
        totalAmount: 0,
      },
      matching: {
        status: 'pending',
      },
      status: extractedData ? 'parsed' : 'received',
      extractionConfidence: extractedData?.extractionConfidence,
      rawExtraction: extractedData?.rawExtraction,
    });

    invoice.addProcessingEvent('email_received', {
      emailId: message.id,
      subject: message.subject,
      from: message.from?.emailAddress?.address,
    });

    await invoice.save();

    // Log audit
    await InvoiceAuditLog.log(invoice._id, 'email_received', {
      invoiceNumber: invoice.invoice?.number,
      vendorName: invoice.vendor?.name,
      actor: { type: 'system', name: 'InvoiceEmailPoller' },
      details: {
        emailId: message.id,
        subject: message.subject,
        from: message.from?.emailAddress?.address,
        attachmentName: attachment.name,
      },
    });

    return invoice;
  }

  /**
   * Get attachments for a message
   */
  async _getMessageAttachments(userId, messageId) {
    const result = await this.msClient._request(
      'GET',
      `/users/${userId}/messages/${messageId}/attachments`,
      null,
      { $select: 'id,name,contentType,size,contentBytes' }
    );

    return result.value || [];
  }

  /**
   * Extract vendor name from email
   */
  _extractVendorFromEmail(message) {
    // Try to get from sender display name
    const displayName = message.from?.emailAddress?.name;
    if (displayName && !displayName.includes('@')) {
      return displayName;
    }

    // Extract from email domain
    const email = message.from?.emailAddress?.address || '';
    const domain = email.split('@')[1];
    if (domain) {
      // Remove common TLDs and capitalize
      return domain.replace(/\.(com|be|nl|de|fr|eu|net|org)$/i, '')
        .split('.')[0]
        .replace(/-/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
    }

    return 'Unknown Vendor';
  }

  /**
   * Try to extract invoice number from subject
   */
  _extractInvoiceNumberFromSubject(subject) {
    if (!subject) return null;

    // Common patterns
    const patterns = [
      /(?:invoice|inv|facture|factuur|rechnung)[\s\-#:]*([A-Z0-9\-\/]+)/i,
      /(?:ref|reference)[\s\-#:]*([A-Z0-9\-\/]+)/i,
      /#([A-Z0-9\-\/]+)/,
    ];

    for (const pattern of patterns) {
      const match = subject.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Move processed email to folder
   */
  async moveToProcessedFolder(messageId) {
    const userId = this.config.targetMailbox;

    try {
      // Get or create processed folder
      let folder = await this._getOrCreateFolder(userId, this.config.processedFolder);

      // Move message
      await this.msClient._request(
        'POST',
        `/users/${userId}/messages/${messageId}/move`,
        { destinationId: folder.id }
      );

      console.log(`[InvoiceEmailPoller] Moved message ${messageId} to ${this.config.processedFolder}`);
    } catch (error) {
      console.error('[InvoiceEmailPoller] Error moving message:', error.message);
    }
  }

  /**
   * Get or create a mail folder
   */
  async _getOrCreateFolder(userId, folderName) {
    // Try to find existing folder
    const folders = await this.msClient._request(
      'GET',
      `/users/${userId}/mailFolders`,
      null,
      { $filter: `displayName eq '${folderName}'` }
    );

    if (folders.value?.length > 0) {
      return folders.value[0];
    }

    // Create folder
    const newFolder = await this.msClient._request(
      'POST',
      `/users/${userId}/mailFolders`,
      { displayName: folderName }
    );

    return newFolder;
  }

  /**
   * Extract invoice data from a specific email
   * @param {string} emailId - Email message ID
   * @param {string} userId - User ID (optional, uses default)
   */
  async extractInvoiceFromEmail(emailId, userId = null) {
    await this._ensureClient();

    const targetUser = userId || this.config.targetMailbox;

    // Get message
    const message = await this.msClient._request(
      'GET',
      `/users/${targetUser}/messages/${emailId}`,
      null,
      { $select: 'id,subject,from,receivedDateTime,bodyPreview,body,hasAttachments' }
    );

    if (!message) {
      throw new Error(`Email not found: ${emailId}`);
    }

    // Get attachments
    const attachments = await this._getMessageAttachments(targetUser, emailId);

    const validAttachments = attachments.filter(att =>
      this.config.supportedAttachmentTypes.includes(att.contentType)
    );

    if (validAttachments.length === 0) {
      throw new Error('No valid invoice attachments found');
    }

    // Parse each attachment
    const results = [];

    for (const attachment of validAttachments) {
      try {
        const buffer = Buffer.from(attachment.contentBytes, 'base64');
        const data = await this.parser.parseInvoice(
          buffer,
          attachment.contentType,
          attachment.name
        );

        results.push({
          attachmentName: attachment.name,
          contentType: attachment.contentType,
          extractedData: data,
          confidence: data.extractionConfidence,
        });
      } catch (error) {
        results.push({
          attachmentName: attachment.name,
          error: error.message,
        });
      }
    }

    return {
      emailId,
      subject: message.subject,
      from: message.from?.emailAddress?.address,
      receivedAt: message.receivedDateTime,
      attachments: results,
    };
  }
}

// Singleton instance
let instance = null;

module.exports = {
  InvoiceEmailPoller,

  // Factory functions
  scanForInvoices: async (options) => {
    if (!instance) instance = new InvoiceEmailPoller();
    return instance.scanForInvoices(options);
  },

  extractInvoiceFromEmail: async (emailId, userId) => {
    if (!instance) instance = new InvoiceEmailPoller();
    return instance.extractInvoiceFromEmail(emailId, userId);
  },

  pollForInvoices: async () => {
    if (!instance) instance = new InvoiceEmailPoller();
    return instance.scanForInvoices({ processImmediately: true });
  },
};
