/**
 * Accounting Agent Dashboard
 *
 * Main dashboard for the Accounting Agent showing metrics,
 * recent invoices, and quick actions.
 */

import React, { useState } from 'react';
import { useAccountingMetrics, useInvoices, useEmailScan, useInvoiceActions } from './hooks/useAccountingData';
import { statusColors, type InvoiceStatus, type VendorInvoice } from './types/accounting.types';

// Format currency
const formatCurrency = (amount: number, currency = 'EUR'): string => {
  return new Intl.NumberFormat('en-EU', {
    style: 'currency',
    currency,
  }).format(amount);
};

// Format date
const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString('en-EU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

// Format relative time
const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

// Status Badge Component
const StatusBadge: React.FC<{ status: InvoiceStatus }> = ({ status }) => {
  const color = statusColors[status] || '#6B7280';
  const bgOpacity = '20';

  return (
    <span
      className="px-2 py-1 rounded-full text-xs font-medium"
      style={{
        backgroundColor: `${color}${bgOpacity}`,
        color: color,
      }}
    >
      {status.replace('_', ' ').toUpperCase()}
    </span>
  );
};

// Metric Card Component
const MetricCard: React.FC<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: { value: number; isPositive: boolean };
}> = ({ title, value, subtitle, icon, trend }) => (
  <div className="bg-white rounded-lg shadow p-6">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        {trend && (
          <p className={`text-sm mt-1 ${trend.isPositive ? 'text-green-600' : 'text-red-600'}`}>
            {trend.isPositive ? '+' : ''}{trend.value}% vs yesterday
          </p>
        )}
      </div>
      <div className="p-3 bg-gray-100 rounded-full">
        {icon}
      </div>
    </div>
  </div>
);

// Invoice Row Component
const InvoiceRow: React.FC<{
  invoice: VendorInvoice;
  onProcess: (id: string) => void;
  processing: boolean;
}> = ({ invoice, onProcess, processing }) => (
  <tr className="hover:bg-gray-50">
    <td className="px-6 py-4 whitespace-nowrap">
      <div className="text-sm font-medium text-gray-900">{invoice.invoice?.number || 'N/A'}</div>
      <div className="text-sm text-gray-500">{invoice.vendor?.name || 'Unknown'}</div>
    </td>
    <td className="px-6 py-4 whitespace-nowrap">
      <StatusBadge status={invoice.status} />
    </td>
    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
      {formatCurrency(invoice.totals?.totalAmount || 0, invoice.totals?.currency || 'EUR')}
    </td>
    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
      {invoice.invoice?.date ? formatDate(invoice.invoice.date) : 'N/A'}
    </td>
    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
      {invoice.matching?.matchedPurchaseOrders?.[0]?.poName || '-'}
    </td>
    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
      {formatRelativeTime(invoice.createdAt)}
    </td>
    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
      {['received', 'parsed', 'matched'].includes(invoice.status) && (
        <button
          onClick={() => onProcess(invoice._id)}
          disabled={processing}
          className="text-indigo-600 hover:text-indigo-900 disabled:opacity-50"
        >
          {processing ? 'Processing...' : 'Process'}
        </button>
      )}
      {invoice.status === 'manual_review' && (
        <button
          onClick={() => onProcess(invoice._id)}
          className="text-amber-600 hover:text-amber-900"
        >
          Review
        </button>
      )}
      {invoice.odoo?.billNumber && (
        <span className="text-green-600">{invoice.odoo.billNumber}</span>
      )}
    </td>
  </tr>
);

// Main Dashboard Component
const AccountingDashboard: React.FC = () => {
  const { metrics, loading: metricsLoading, error: metricsError, refetch: refetchMetrics } = useAccountingMetrics();
  const { invoices, loading: invoicesLoading, error: invoicesError, refetch: refetchInvoices } = useInvoices({}, 1, 10);
  const { scanning, scanEmails, result: scanResult } = useEmailScan();
  const { processing, processInvoice } = useInvoiceActions();

  const [showScanResult, setShowScanResult] = useState(false);

  const handleScanEmails = async () => {
    try {
      await scanEmails(24);
      setShowScanResult(true);
      refetchInvoices();
      refetchMetrics();
    } catch {
      // Error handled by hook
    }
  };

  const handleProcessInvoice = async (invoiceId: string) => {
    try {
      await processInvoice(invoiceId);
      refetchInvoices();
      refetchMetrics();
    } catch {
      // Error handled by hook
    }
  };

  const handleRefresh = () => {
    refetchMetrics();
    refetchInvoices();
  };

  // Icons (inline SVG for simplicity)
  const InvoiceIcon = () => (
    <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );

  const CheckIcon = () => (
    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );

  const ClockIcon = () => (
    <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );

  const CurrencyIcon = () => (
    <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );

  const AlertIcon = () => (
    <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Accounting Dashboard</h1>
          <p className="text-gray-500 mt-1">Invoice processing and AP management</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleRefresh}
            className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100"
          >
            Refresh
          </button>
          <button
            onClick={handleScanEmails}
            disabled={scanning}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {scanning ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Scanning...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Scan Emails
              </>
            )}
          </button>
        </div>
      </div>

      {/* Scan Result Toast */}
      {showScanResult && scanResult && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex justify-between items-center">
          <div>
            <p className="text-green-800 font-medium">Email scan complete</p>
            <p className="text-green-600 text-sm">
              Scanned {scanResult.scanned} emails, found {scanResult.invoiceEmails} invoices, created {scanResult.created} new records
            </p>
          </div>
          <button onClick={() => setShowScanResult(false)} className="text-green-600 hover:text-green-800">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* Error Display */}
      {(metricsError || invoicesError) && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800">{metricsError || invoicesError}</p>
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <MetricCard
          title="Total Invoices"
          value={metricsLoading ? '-' : metrics?.totalInvoices || 0}
          icon={<InvoiceIcon />}
        />
        <MetricCard
          title="Pending Review"
          value={metricsLoading ? '-' : metrics?.needsReview || 0}
          icon={<ClockIcon />}
        />
        <MetricCard
          title="Auto-Booked Today"
          value={metricsLoading ? '-' : metrics?.autoBooked || 0}
          icon={<CheckIcon />}
        />
        <MetricCard
          title="Pending Value"
          value={metricsLoading ? '-' : formatCurrency(metrics?.totalValuePending || 0)}
          icon={<CurrencyIcon />}
        />
        <MetricCard
          title="Errors"
          value={metricsLoading ? '-' : metrics?.errors || 0}
          icon={<AlertIcon />}
        />
      </div>

      {/* Quick Stats Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Match Rate */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Match Rate</h3>
          <div className="flex items-center justify-center">
            <div className="relative">
              <svg className="w-32 h-32">
                <circle
                  className="text-gray-200"
                  strokeWidth="10"
                  stroke="currentColor"
                  fill="transparent"
                  r="56"
                  cx="64"
                  cy="64"
                />
                <circle
                  className="text-green-500"
                  strokeWidth="10"
                  strokeDasharray={`${(metrics?.averageMatchConfidence || 0) * 3.52} 352`}
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="transparent"
                  r="56"
                  cx="64"
                  cy="64"
                  transform="rotate(-90 64 64)"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold">{Math.round(metrics?.averageMatchConfidence || 0)}%</span>
              </div>
            </div>
          </div>
          <p className="text-center text-gray-500 mt-2">Average confidence</p>
        </div>

        {/* Status Breakdown */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Status Breakdown</h3>
          <div className="space-y-3">
            {metrics?.statusBreakdown && Object.entries(metrics.statusBreakdown).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: statusColors[status as InvoiceStatus] || '#6B7280' }}
                  />
                  <span className="text-sm text-gray-600">{status.replace('_', ' ')}</span>
                </div>
                <span className="text-sm font-medium text-gray-900">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Quick Actions</h3>
          <div className="space-y-3">
            <a
              href="/ui/accounting/invoices"
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition"
            >
              <div className="p-2 bg-indigo-100 rounded-lg">
                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">View Invoice Queue</p>
                <p className="text-xs text-gray-500">Manage pending invoices</p>
              </div>
            </a>
            <a
              href="/ui/accounting/chat"
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition"
            >
              <div className="p-2 bg-green-100 rounded-lg">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">Chat with Agent</p>
                <p className="text-xs text-gray-500">Ask questions or give commands</p>
              </div>
            </a>
            <a
              href="/ui/accounting/reports"
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition"
            >
              <div className="p-2 bg-purple-100 rounded-lg">
                <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-900">View Reports</p>
                <p className="text-xs text-gray-500">Aging, cash flow, and more</p>
              </div>
            </a>
          </div>
        </div>
      </div>

      {/* Recent Invoices Table */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-lg font-medium text-gray-900">Recent Invoices</h2>
          <a
            href="/ui/accounting/invoices"
            className="text-indigo-600 hover:text-indigo-900 text-sm font-medium"
          >
            View all
          </a>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice / Vendor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  PO Match
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Received
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {invoicesLoading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    Loading invoices...
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    No invoices found. Click "Scan Emails" to fetch new invoices.
                  </td>
                </tr>
              ) : (
                invoices.map(invoice => (
                  <InvoiceRow
                    key={invoice._id}
                    invoice={invoice}
                    onProcess={handleProcessInvoice}
                    processing={processing}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default AccountingDashboard;
