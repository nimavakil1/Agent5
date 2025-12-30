/**
 * TypeScript types for Accounting Agent UI
 */

// Invoice Status
export type InvoiceStatus =
  | 'received'
  | 'parsing'
  | 'parsed'
  | 'matching'
  | 'matched'
  | 'manual_review'
  | 'approved'
  | 'booking'
  | 'booked'
  | 'error'
  | 'cancelled';

// Matching Status
export type MatchingStatus =
  | 'pending'
  | 'matched'
  | 'partial_match'
  | 'unmatched';

// Vendor
export interface Vendor {
  name: string;
  vatNumber?: string;
  address?: string;
  email?: string;
  odooPartnerId?: number;
}

// Invoice Details
export interface InvoiceDetails {
  number?: string;
  date?: string;
  dueDate?: string;
  currency: string;
  poReference?: string;
  paymentTerms?: string;
}

// Invoice Line Item
export interface InvoiceLine {
  description?: string;
  sku?: string;
  quantity?: number;
  unitPrice?: number;
  vatRate?: number;
  vatAmount?: number;
  lineTotal?: number;
  matchedOdooPOLineId?: number;
}

// Invoice Totals
export interface InvoiceTotals {
  subtotal?: number;
  vatRate?: number;
  vatAmount?: number;
  totalAmount?: number;
  currency: string;
}

// Matched Purchase Order
export interface MatchedPurchaseOrder {
  odooPoId: number;
  poName: string;
  matchConfidence: number;
  matchedLines: number[];
}

// Invoice Matching Info
export interface InvoiceMatching {
  status: MatchingStatus;
  matchedPurchaseOrders: MatchedPurchaseOrder[];
  matchAttemptedAt?: string;
  matchNotes?: string;
}

// Odoo Reference
export interface OdooReference {
  billId?: number;
  billNumber?: string;
  createdAt?: string;
  postedAt?: string;
  syncError?: string;
  lastSyncAttempt?: string;
}

// Invoice Approval
export interface InvoiceApproval {
  required: boolean;
  requestedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  notes?: string;
}

// Invoice Source
export interface InvoiceSource {
  type: 'email' | 'upload' | 'api';
  emailId?: string;
  emailSubject?: string;
  emailFrom?: string;
  receivedAt?: string;
  attachmentName?: string;
  attachmentSize?: number;
  attachmentContentType?: string;
}

// Processing Event
export interface ProcessingEvent {
  event: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

// Invoice Error
export interface InvoiceError {
  stage: string;
  message: string;
  timestamp: string;
  retryCount: number;
}

// Full Vendor Invoice
export interface VendorInvoice {
  _id: string;
  source: InvoiceSource;
  vendor: Vendor;
  invoice: InvoiceDetails;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  matching: InvoiceMatching;
  odoo?: OdooReference;
  approval?: InvoiceApproval;
  status: InvoiceStatus;
  extractionConfidence?: number;
  processingHistory: ProcessingEvent[];
  errors: InvoiceError[];
  createdAt: string;
  updatedAt: string;
}

// Dashboard Metrics
export interface AccountingMetrics {
  totalInvoices: number;
  pendingInvoices: number;
  processedToday: number;
  autoBooked: number;
  needsReview: number;
  errors: number;
  totalValuePending: number;
  averageMatchConfidence: number;
  averageProcessingTime: number;
  statusBreakdown: Record<InvoiceStatus, number>;
}

// Aging Report Entry
export interface AgingEntry {
  partnerId: number;
  partnerName: string;
  current: number;
  days30: number;
  days60: number;
  days90Plus: number;
  total: number;
}

// Aging Report
export interface AgingReport {
  type: 'payable' | 'receivable';
  asOf: string;
  currency: string;
  entries: AgingEntry[];
  totals: {
    current: number;
    days30: number;
    days60: number;
    days90Plus: number;
    total: number;
  };
}

// Chat Message
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  actions?: ChatAction[];
}

// Chat Action (suggested action button)
export interface ChatAction {
  id: string;
  label: string;
  type: 'process' | 'approve' | 'reject' | 'book' | 'view';
  invoiceId?: string;
}

// Agent Status
export interface AgentStatus {
  isActive: boolean;
  state: 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';
  currentTask?: string;
  lastActivity?: string;
}

// Voice Session
export interface VoiceSession {
  roomName: string;
  token: string;
  agentToken: string;
  livekitUrl: string;
}

// Settings
export interface AccountingSettings {
  invoicePolling: {
    enabled: boolean;
    intervalMinutes: number;
    mailboxUserId: string;
    targetFolder: string;
    processedFolder: string;
  };
  autoProcessing: {
    enabled: boolean;
    autoMatchThreshold: number;
    approvalAmountThreshold: number;
    autoPostEnabled: boolean;
  };
  notifications: {
    emailOnError: boolean;
    emailOnApprovalNeeded: boolean;
    emailRecipients: string[];
  };
}

// API Response Types
export interface InvoiceListResponse {
  invoices: VendorInvoice[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ProcessInvoiceResponse {
  success: boolean;
  invoiceId: string;
  status: InvoiceStatus;
  actions: string[];
  matchConfidence?: number;
  error?: string;
}

// Filter Options
export interface InvoiceFilters {
  status?: InvoiceStatus | InvoiceStatus[];
  vendor?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: number;
  maxAmount?: number;
  matchingStatus?: MatchingStatus;
}

// Status Colors (for consistency)
export const statusColors: Record<InvoiceStatus, string> = {
  received: '#6B7280',    // gray
  parsing: '#F59E0B',     // amber
  parsed: '#3B82F6',      // blue
  matching: '#F59E0B',    // amber
  matched: '#8B5CF6',     // purple
  manual_review: '#F59E0B', // amber
  approved: '#06B6D4',    // cyan
  booking: '#F59E0B',     // amber
  booked: '#10B981',      // green
  error: '#EF4444',       // red
  cancelled: '#6B7280',   // gray
};

export const matchingStatusColors: Record<MatchingStatus, string> = {
  pending: '#6B7280',
  matched: '#10B981',
  partial_match: '#F59E0B',
  unmatched: '#EF4444',
};
