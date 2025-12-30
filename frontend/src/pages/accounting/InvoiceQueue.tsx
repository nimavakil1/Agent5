/**
 * Invoice Queue Management
 *
 * Full invoice queue with filtering, sorting, bulk actions,
 * and detailed invoice modal.
 */

import React, { useState, useMemo } from 'react';
import { useInvoices, useInvoice, useInvoiceActions } from './hooks/useAccountingData';
import {
  statusColors,
  matchingStatusColors,
  type InvoiceStatus,
  type MatchingStatus,
  type VendorInvoice,
  type InvoiceFilters,
} from './types/accounting.types';

// Format currency
const formatCurrency = (amount: number, currency = 'EUR'): string => {
  return new Intl.NumberFormat('en-EU', {
    style: 'currency',
    currency,
  }).format(amount);
};

// Format date
const formatDate = (dateString: string | undefined): string => {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('en-EU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// Status Badge
const StatusBadge: React.FC<{ status: InvoiceStatus }> = ({ status }) => {
  const color = statusColors[status] || '#6B7280';
  return (
    <span
      className="px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {status.replace('_', ' ').toUpperCase()}
    </span>
  );
};

// Matching Status Badge
const MatchingBadge: React.FC<{ status: MatchingStatus; confidence?: number }> = ({ status, confidence }) => {
  const color = matchingStatusColors[status] || '#6B7280';
  return (
    <span
      className="px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {status.replace('_', ' ')}
      {confidence !== undefined && ` (${Math.round(confidence)}%)`}
    </span>
  );
};

// Filter Panel Component
const FilterPanel: React.FC<{
  filters: InvoiceFilters;
  onChange: (filters: InvoiceFilters) => void;
  onReset: () => void;
}> = ({ filters, onChange, onReset }) => {
  const statusOptions: InvoiceStatus[] = [
    'received', 'parsing', 'parsed', 'matching', 'matched',
    'manual_review', 'approved', 'booking', 'booked', 'error',
  ];

  const matchingOptions: MatchingStatus[] = ['pending', 'matched', 'partial_match', 'unmatched'];

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-6">
      <div className="flex flex-wrap gap-4 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
          <select
            value={filters.status as string || ''}
            onChange={e => onChange({ ...filters, status: e.target.value as InvoiceStatus || undefined })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">All Statuses</option>
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status.replace('_', ' ').toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Matching Status</label>
          <select
            value={filters.matchingStatus || ''}
            onChange={e => onChange({ ...filters, matchingStatus: e.target.value as MatchingStatus || undefined })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">All</option>
            {matchingOptions.map(status => (
              <option key={status} value={status}>
                {status.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Vendor</label>
          <input
            type="text"
            placeholder="Search vendor..."
            value={filters.vendor || ''}
            onChange={e => onChange({ ...filters, vendor: e.target.value || undefined })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div className="flex-1 min-w-[150px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Date From</label>
          <input
            type="date"
            value={filters.dateFrom || ''}
            onChange={e => onChange({ ...filters, dateFrom: e.target.value || undefined })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div className="flex-1 min-w-[150px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Date To</label>
          <input
            type="date"
            value={filters.dateTo || ''}
            onChange={e => onChange({ ...filters, dateTo: e.target.value || undefined })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <button
          onClick={onReset}
          className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
        >
          Reset
        </button>
      </div>
    </div>
  );
};

// Invoice Detail Modal
const InvoiceDetailModal: React.FC<{
  invoiceId: string;
  onClose: () => void;
  onAction: (action: string) => void;
}> = ({ invoiceId, onClose, onAction }) => {
  const { invoice, loading, error } = useInvoice(invoiceId);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-8">
          <p>Loading invoice details...</p>
        </div>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-8">
          <p className="text-red-600">{error || 'Invoice not found'}</p>
          <button onClick={onClose} className="mt-4 px-4 py-2 bg-gray-200 rounded-lg">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center sticky top-0 bg-white">
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              Invoice {invoice.invoice?.number || 'N/A'}
            </h2>
            <p className="text-gray-500">{invoice.vendor?.name || 'Unknown Vendor'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Status & Matching */}
          <div className="flex gap-4">
            <StatusBadge status={invoice.status} />
            <MatchingBadge
              status={invoice.matching?.status || 'pending'}
              confidence={invoice.matching?.matchedPurchaseOrders?.[0]?.matchConfidence}
            />
          </div>

          {/* Main Info Grid */}
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-4">
              <h3 className="font-medium text-gray-900">Invoice Details</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Number</dt>
                  <dd className="text-gray-900">{invoice.invoice?.number || 'N/A'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Date</dt>
                  <dd className="text-gray-900">{formatDate(invoice.invoice?.date)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Due Date</dt>
                  <dd className="text-gray-900">{formatDate(invoice.invoice?.dueDate)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">PO Reference</dt>
                  <dd className="text-gray-900">{invoice.invoice?.poReference || 'None'}</dd>
                </div>
              </dl>
            </div>

            <div className="space-y-4">
              <h3 className="font-medium text-gray-900">Vendor</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Name</dt>
                  <dd className="text-gray-900">{invoice.vendor?.name || 'Unknown'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">VAT Number</dt>
                  <dd className="text-gray-900">{invoice.vendor?.vatNumber || 'N/A'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Odoo Partner ID</dt>
                  <dd className="text-gray-900">{invoice.vendor?.odooPartnerId || 'Not linked'}</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Totals */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-medium text-gray-900 mb-3">Totals</h3>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-sm text-gray-500">Subtotal</p>
                <p className="text-lg font-medium">{formatCurrency(invoice.totals?.subtotal || 0, invoice.totals?.currency)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">VAT ({invoice.totals?.vatRate || 0}%)</p>
                <p className="text-lg font-medium">{formatCurrency(invoice.totals?.vatAmount || 0, invoice.totals?.currency)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Total</p>
                <p className="text-xl font-bold text-gray-900">{formatCurrency(invoice.totals?.totalAmount || 0, invoice.totals?.currency)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Currency</p>
                <p className="text-lg font-medium">{invoice.totals?.currency || 'EUR'}</p>
              </div>
            </div>
          </div>

          {/* Line Items */}
          {invoice.lines && invoice.lines.length > 0 && (
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Line Items</h3>
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Unit Price</th>
                    <th className="px-3 py-2 text-right">VAT</th>
                    <th className="px-3 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {invoice.lines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2">{line.description || 'N/A'}</td>
                      <td className="px-3 py-2 text-right">{line.quantity || 1}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(line.unitPrice || 0)}</td>
                      <td className="px-3 py-2 text-right">{line.vatRate || 0}%</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(line.lineTotal || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Matched POs */}
          {invoice.matching?.matchedPurchaseOrders && invoice.matching.matchedPurchaseOrders.length > 0 && (
            <div>
              <h3 className="font-medium text-gray-900 mb-3">Matched Purchase Orders</h3>
              <div className="space-y-2">
                {invoice.matching.matchedPurchaseOrders.map((po, idx) => (
                  <div key={idx} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                    <span className="font-medium">{po.poName}</span>
                    <span className="text-green-600">{po.matchConfidence}% match</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Odoo Reference */}
          {invoice.odoo?.billNumber && (
            <div className="bg-green-50 rounded-lg p-4">
              <h3 className="font-medium text-green-800 mb-2">Booked to Odoo</h3>
              <p className="text-green-700">Bill Number: {invoice.odoo.billNumber}</p>
              {invoice.odoo.postedAt && (
                <p className="text-green-600 text-sm">Posted: {formatDate(invoice.odoo.postedAt)}</p>
              )}
            </div>
          )}

          {/* Errors */}
          {invoice.errors && invoice.errors.length > 0 && (
            <div className="bg-red-50 rounded-lg p-4">
              <h3 className="font-medium text-red-800 mb-2">Errors</h3>
              {invoice.errors.map((err, idx) => (
                <div key={idx} className="text-sm text-red-700">
                  [{err.stage}] {err.message}
                </div>
              ))}
            </div>
          )}

          {/* Source Info */}
          <div className="text-sm text-gray-500 space-y-1">
            <p>Source: {invoice.source?.type}</p>
            {invoice.source?.emailSubject && <p>Email: {invoice.source.emailSubject}</p>}
            {invoice.source?.attachmentName && <p>Attachment: {invoice.source.attachmentName}</p>}
            <p>Received: {formatDate(invoice.createdAt)}</p>
            {invoice.extractionConfidence && (
              <p>Extraction Confidence: {Math.round(invoice.extractionConfidence * 100)}%</p>
            )}
          </div>
        </div>

        {/* Reject Form */}
        {showRejectForm && (
          <div className="px-6 pb-4">
            <div className="bg-red-50 rounded-lg p-4">
              <h3 className="font-medium text-red-800 mb-2">Reject Invoice</h3>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="Enter rejection reason..."
                className="w-full border border-red-200 rounded-lg p-2 text-sm"
                rows={3}
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => {
                    onAction(`reject:${rejectReason}`);
                    setShowRejectForm(false);
                    setRejectReason('');
                  }}
                  disabled={!rejectReason}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm"
                >
                  Confirm Reject
                </button>
                <button
                  onClick={() => setShowRejectForm(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Actions Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Close
          </button>
          <div className="flex gap-2">
            {['received', 'parsed', 'matched'].includes(invoice.status) && (
              <button
                onClick={() => onAction('process')}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                Process
              </button>
            )}
            {invoice.status === 'manual_review' && (
              <>
                <button
                  onClick={() => setShowRejectForm(true)}
                  className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200"
                >
                  Reject
                </button>
                <button
                  onClick={() => onAction('approve')}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  Approve
                </button>
              </>
            )}
            {invoice.status === 'approved' && (
              <button
                onClick={() => onAction('book')}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Book to Odoo
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Main Invoice Queue Component
const InvoiceQueue: React.FC = () => {
  const [filters, setFilters] = useState<InvoiceFilters>({});
  const [page, setPage] = useState(1);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { invoices, total, loading, error, refetch } = useInvoices(filters, page, 20);
  const { processing, processInvoice, approveInvoice, rejectInvoice, bookInvoice } = useInvoiceActions();

  const totalPages = Math.ceil(total / 20);

  const handleResetFilters = () => {
    setFilters({});
    setPage(1);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === invoices.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(invoices.map(i => i._id)));
    }
  };

  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleBulkProcess = async () => {
    for (const id of selectedIds) {
      try {
        await processInvoice(id);
      } catch {
        // Continue with others
      }
    }
    setSelectedIds(new Set());
    refetch();
  };

  const handleInvoiceAction = async (action: string) => {
    if (!selectedInvoice) return;

    try {
      if (action === 'process') {
        await processInvoice(selectedInvoice);
      } else if (action === 'approve') {
        await approveInvoice(selectedInvoice);
      } else if (action.startsWith('reject:')) {
        await rejectInvoice(selectedInvoice, action.substring(7));
      } else if (action === 'book') {
        await bookInvoice(selectedInvoice);
      }
      refetch();
      setSelectedInvoice(null);
    } catch {
      // Error handled by hook
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Invoice Queue</h1>
          <p className="text-gray-500 mt-1">Manage and process vendor invoices</p>
        </div>
        <div className="flex gap-3">
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkProcess}
              disabled={processing}
              className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              Process {selectedIds.size} Selected
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <FilterPanel
        filters={filters}
        onChange={f => { setFilters(f); setPage(1); }}
        onReset={handleResetFilters}
      />

      {/* Error Display */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={selectedIds.size === invoices.length && invoices.length > 0}
                  onChange={handleSelectAll}
                  className="rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Invoice</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Vendor</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Matching</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Odoo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                  Loading invoices...
                </td>
              </tr>
            ) : invoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                  No invoices found matching your criteria.
                </td>
              </tr>
            ) : (
              invoices.map(invoice => (
                <tr
                  key={invoice._id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => setSelectedInvoice(invoice._id)}
                >
                  <td className="px-4 py-4" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(invoice._id)}
                      onChange={() => handleToggleSelect(invoice._id)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-4">
                    <div className="text-sm font-medium text-gray-900">{invoice.invoice?.number || 'N/A'}</div>
                    {invoice.source?.attachmentName && (
                      <div className="text-xs text-gray-500 truncate max-w-[200px]">
                        {invoice.source.attachmentName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <div className="text-sm text-gray-900">{invoice.vendor?.name || 'Unknown'}</div>
                    {invoice.vendor?.vatNumber && (
                      <div className="text-xs text-gray-500">{invoice.vendor.vatNumber}</div>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td className="px-4 py-4">
                    <MatchingBadge
                      status={invoice.matching?.status || 'pending'}
                      confidence={invoice.matching?.matchedPurchaseOrders?.[0]?.matchConfidence}
                    />
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="text-sm font-medium text-gray-900">
                      {formatCurrency(invoice.totals?.totalAmount || 0, invoice.totals?.currency)}
                    </div>
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-500">
                    {formatDate(invoice.invoice?.date)}
                  </td>
                  <td className="px-4 py-4 text-sm">
                    {invoice.odoo?.billNumber ? (
                      <span className="text-green-600">{invoice.odoo.billNumber}</span>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-500">
              Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, total)} of {total} invoices
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
              >
                Previous
              </button>
              <span className="px-3 py-1">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Invoice Detail Modal */}
      {selectedInvoice && (
        <InvoiceDetailModal
          invoiceId={selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
          onAction={handleInvoiceAction}
        />
      )}
    </div>
  );
};

export default InvoiceQueue;
