/**
 * EmailScanner - Scan Gmail for invoice emails from configured suppliers
 *
 * Uses Gmail API via googleapis with OAuth2 for general@distri-smart.com.
 * For each active supplier, builds a search query based on sender/subject patterns,
 * downloads PDF attachments, and creates InvoiceSyncRecord entries.
 *
 * Required env vars:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   (for general@distri-smart.com OAuth2 access)
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const InvoiceSyncSupplier = require('../../models/InvoiceSyncSupplier');
const InvoiceSyncRecord = require('../../models/InvoiceSyncRecord');

// PDF storage base dir
const PDF_BASE_DIR = path.join(process.cwd(), 'data', 'invoice_sync_pdfs');

class EmailScanner {
  constructor() {
    this.gmail = null;
    this.auth = null;
  }

  /**
   * Initialize Gmail API client
   */
  async _ensureClient() {
    if (this.gmail) return;

    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Gmail OAuth2 not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN');
    }

    this.auth = new google.auth.OAuth2(clientId, clientSecret);
    this.auth.setCredentials({ refresh_token: refreshToken });

    this.gmail = google.gmail({ version: 'v1', auth: this.auth });
  }

  /**
   * Scan Gmail for invoices from all active suppliers (or a specific one)
   * @param {Object} options
   * @param {string} options.supplierId - Scan only this supplier (optional)
   * @param {number} options.daysBack - How many days back to scan (default: 7)
   */
  async scan(options = {}) {
    await this._ensureClient();

    const { supplierId, daysBack = 7 } = options;

    // Get suppliers to scan
    const query = { isActive: true };
    if (supplierId) query._id = supplierId;

    const suppliers = await InvoiceSyncSupplier.find(query).lean();
    if (suppliers.length === 0) {
      return { scanned: 0, message: 'No active suppliers configured' };
    }

    console.log(`[EmailScanner] Scanning for ${suppliers.length} suppliers, last ${daysBack} days`);

    const result = {
      scanned: 0,
      newInvoices: 0,
      skippedDuplicates: 0,
      errors: [],
      bySupplier: {},
    };

    for (const supplier of suppliers) {
      try {
        const supplierResult = await this._scanForSupplier(supplier, daysBack);
        result.scanned += supplierResult.messagesFound;
        result.newInvoices += supplierResult.newInvoices;
        result.skippedDuplicates += supplierResult.skippedDuplicates;
        result.bySupplier[supplier.name] = supplierResult;

        // Update supplier last scan time
        await InvoiceSyncSupplier.findByIdAndUpdate(supplier._id, { lastScanAt: new Date() });
      } catch (err) {
        console.error(`[EmailScanner] Error scanning for ${supplier.name}: ${err.message}`);
        result.errors.push({ supplier: supplier.name, error: err.message });
      }
    }

    console.log(`[EmailScanner] Scan complete: ${result.newInvoices} new invoices, ${result.skippedDuplicates} duplicates`);
    return result;
  }

  /**
   * Scan for a specific supplier
   */
  async _scanForSupplier(supplier, daysBack) {
    const gmailQuery = this._buildGmailQuery(supplier, daysBack);
    console.log(`[EmailScanner] Searching for "${supplier.name}": ${gmailQuery}`);

    const result = {
      messagesFound: 0,
      newInvoices: 0,
      skippedDuplicates: 0,
      errors: [],
    };

    // Search Gmail
    let messages = [];
    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: gmailQuery,
        maxResults: 50,
      });
      messages = response.data.messages || [];
    } catch (err) {
      throw new Error(`Gmail search failed: ${err.message}`);
    }

    result.messagesFound = messages.length;
    console.log(`[EmailScanner] Found ${messages.length} messages for "${supplier.name}"`);

    for (const msgRef of messages) {
      try {
        // Check if already processed
        const existing = await InvoiceSyncRecord.findOne({ gmailMessageId: msgRef.id });
        if (existing) {
          result.skippedDuplicates++;
          continue;
        }

        // Get full message
        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id: msgRef.id,
        });

        // Extract metadata
        const headers = msg.data.payload.headers || [];
        const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
        const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';

        // Verify match (Gmail search is broad, double-check with our patterns)
        if (!this._matchesSupplier(supplier, from, subject)) {
          continue;
        }

        // Find PDF attachments
        const pdfAttachments = this._findPdfAttachments(msg.data.payload);
        if (pdfAttachments.length === 0) {
          continue; // No PDF attachments, skip
        }

        // Download each PDF attachment and create a record
        for (const attachment of pdfAttachments) {
          const pdfPath = await this._downloadAttachment(
            msgRef.id,
            attachment.attachmentId,
            supplier.name,
            attachment.filename
          );

          // Create invoice record
          await InvoiceSyncRecord.create({
            supplier: supplier._id,
            supplierName: supplier.name,
            gmailMessageId: pdfAttachments.length === 1
              ? msgRef.id
              : `${msgRef.id}_${attachment.filename}`,
            emailSubject: subject,
            emailFrom: from,
            emailDate: date ? new Date(date) : new Date(),
            pdfFilepath: pdfPath,
            status: 'pending',
            destination: supplier.destination,
            processingHistory: [{
              action: 'email_scanned',
              details: { from, subject, filename: attachment.filename },
            }],
          });

          result.newInvoices++;
        }
      } catch (err) {
        // If it's a duplicate key error, that's fine (race condition)
        if (err.code === 11000) {
          result.skippedDuplicates++;
        } else {
          console.error(`[EmailScanner] Error processing message ${msgRef.id}: ${err.message}`);
          result.errors.push({ messageId: msgRef.id, error: err.message });
        }
      }
    }

    return result;
  }

  /**
   * Build Gmail search query from supplier config
   */
  _buildGmailQuery(supplier, daysBack) {
    const parts = [];

    // Date filter
    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const sinceStr = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;
    parts.push(`after:${sinceStr}`);

    // Has attachment
    parts.push('has:attachment');
    parts.push('filename:pdf');

    // Sender/subject patterns
    const { senderPattern, subjectPattern, matchMode } = supplier;

    if (matchMode === 'sender' && senderPattern) {
      // Convert regex-ish pattern to Gmail query: "maul|leitz" → "from:(maul OR leitz)"
      const senders = senderPattern.split('|').map(s => s.trim()).filter(Boolean);
      if (senders.length === 1) {
        parts.push(`from:${senders[0]}`);
      } else {
        parts.push(`from:(${senders.join(' OR ')})`);
      }
    } else if (matchMode === 'subject' && subjectPattern) {
      const subjects = subjectPattern.split('|').map(s => s.trim()).filter(Boolean);
      if (subjects.length === 1) {
        parts.push(`subject:${subjects[0]}`);
      } else {
        parts.push(`subject:(${subjects.join(' OR ')})`);
      }
    } else if (matchMode === 'both' && senderPattern && subjectPattern) {
      const senders = senderPattern.split('|').map(s => s.trim()).filter(Boolean);
      const subjects = subjectPattern.split('|').map(s => s.trim()).filter(Boolean);
      parts.push(`from:(${senders.join(' OR ')})`);
      parts.push(`subject:(${subjects.join(' OR ')})`);
    } else if (matchMode === 'any') {
      const orParts = [];
      if (senderPattern) {
        const senders = senderPattern.split('|').map(s => s.trim()).filter(Boolean);
        orParts.push(`from:(${senders.join(' OR ')})`);
      }
      if (subjectPattern) {
        const subjects = subjectPattern.split('|').map(s => s.trim()).filter(Boolean);
        orParts.push(`subject:(${subjects.join(' OR ')})`);
      }
      if (orParts.length > 1) {
        parts.push(`{${orParts.join(' ')}}`);
      } else if (orParts.length === 1) {
        parts.push(orParts[0]);
      }
    }

    return parts.join(' ');
  }

  /**
   * Double-check if email matches supplier patterns (regex-based)
   */
  _matchesSupplier(supplier, from, subject) {
    const { senderPattern, subjectPattern, matchMode } = supplier;

    const senderMatch = senderPattern
      ? new RegExp(senderPattern, 'i').test(from)
      : false;
    const subjectMatch = subjectPattern
      ? new RegExp(subjectPattern, 'i').test(subject)
      : false;

    switch (matchMode) {
      case 'sender': return senderMatch;
      case 'subject': return subjectMatch;
      case 'both': return senderMatch && subjectMatch;
      case 'any': return senderMatch || subjectMatch;
      default: return senderMatch;
    }
  }

  /**
   * Find PDF attachments in message payload (handles multipart)
   */
  _findPdfAttachments(payload, attachments = []) {
    if (payload.mimeType === 'application/pdf' && payload.body?.attachmentId) {
      attachments.push({
        filename: payload.filename || 'invoice.pdf',
        attachmentId: payload.body.attachmentId,
        size: payload.body.size || 0,
      });
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        this._findPdfAttachments(part, attachments);
      }
    }

    return attachments;
  }

  /**
   * Download a Gmail attachment and save to disk
   */
  async _downloadAttachment(messageId, attachmentId, supplierName, filename) {
    // Create directory
    const safeSupplier = supplierName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const dir = path.join(PDF_BASE_DIR, safeSupplier, messageId);
    fs.mkdirSync(dir, { recursive: true });

    // Download attachment
    const response = await this.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });

    // Gmail returns base64url-encoded data
    const data = response.data.data;
    const buffer = Buffer.from(data, 'base64url');

    // Save to file
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filepath = path.join(dir, safeName);
    fs.writeFileSync(filepath, buffer);

    console.log(`[EmailScanner] Saved PDF: ${filepath} (${buffer.length} bytes)`);
    return filepath;
  }
}

// Singleton
let instance = null;

async function scanEmails(options = {}) {
  if (!instance) instance = new EmailScanner();
  return instance.scan(options);
}

module.exports = {
  EmailScanner,
  scanEmails,
};
