/**
 * Accounting Reports Page
 *
 * Financial reports including aging, vendor summary, and processing metrics.
 */

import React, { useState } from 'react';
import { useAgingReport } from './hooks/useAccountingData';
import type { AgingReport, AgingEntry } from './types/accounting.types';

// Format currency
const formatCurrency = (amount: number, currency = 'EUR'): string => {
  return new Intl.NumberFormat('en-EU', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
};

// Tab Button Component
const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
      active
        ? 'bg-indigo-600 text-white'
        : 'text-gray-600 hover:bg-gray-100'
    }`}
  >
    {children}
  </button>
);

// Aging Table Row
const AgingRow: React.FC<{ entry: AgingEntry; currency: string }> = ({ entry, currency }) => (
  <tr className="hover:bg-gray-50">
    <td className="px-4 py-3 text-sm font-medium text-gray-900">{entry.partnerName}</td>
    <td className="px-4 py-3 text-sm text-right text-gray-900">{formatCurrency(entry.current, currency)}</td>
    <td className="px-4 py-3 text-sm text-right text-gray-900">{formatCurrency(entry.days30, currency)}</td>
    <td className="px-4 py-3 text-sm text-right text-amber-600">{formatCurrency(entry.days60, currency)}</td>
    <td className="px-4 py-3 text-sm text-right text-red-600">{formatCurrency(entry.days90Plus, currency)}</td>
    <td className="px-4 py-3 text-sm text-right font-medium text-gray-900">{formatCurrency(entry.total, currency)}</td>
  </tr>
);

// Aging Report Component
const AgingReportView: React.FC<{ type: 'payable' | 'receivable' }> = ({ type }) => {
  const { report, loading, error, refetch } = useAgingReport(type);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading report...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  if (!report || report.entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <svg className="w-12 h-12 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p>No {type === 'payable' ? 'payables' : 'receivables'} data available</p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary Cards */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <div className="bg-green-50 rounded-lg p-4">
          <p className="text-sm text-green-600">Current</p>
          <p className="text-xl font-bold text-green-700">{formatCurrency(report.totals.current, report.currency)}</p>
        </div>
        <div className="bg-blue-50 rounded-lg p-4">
          <p className="text-sm text-blue-600">1-30 Days</p>
          <p className="text-xl font-bold text-blue-700">{formatCurrency(report.totals.days30, report.currency)}</p>
        </div>
        <div className="bg-amber-50 rounded-lg p-4">
          <p className="text-sm text-amber-600">31-60 Days</p>
          <p className="text-xl font-bold text-amber-700">{formatCurrency(report.totals.days60, report.currency)}</p>
        </div>
        <div className="bg-red-50 rounded-lg p-4">
          <p className="text-sm text-red-600">90+ Days</p>
          <p className="text-xl font-bold text-red-700">{formatCurrency(report.totals.days90Plus, report.currency)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-sm text-gray-600">Total</p>
          <p className="text-xl font-bold text-gray-900">{formatCurrency(report.totals.total, report.currency)}</p>
        </div>
      </div>

      {/* Detail Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                {type === 'payable' ? 'Vendor' : 'Customer'}
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Current</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">1-30 Days</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">31-60 Days</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">90+ Days</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {report.entries.map(entry => (
              <AgingRow key={entry.partnerId} entry={entry} currency={report.currency} />
            ))}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr>
              <td className="px-4 py-3 text-sm font-bold text-gray-900">Total</td>
              <td className="px-4 py-3 text-sm text-right font-bold text-gray-900">{formatCurrency(report.totals.current, report.currency)}</td>
              <td className="px-4 py-3 text-sm text-right font-bold text-gray-900">{formatCurrency(report.totals.days30, report.currency)}</td>
              <td className="px-4 py-3 text-sm text-right font-bold text-amber-600">{formatCurrency(report.totals.days60, report.currency)}</td>
              <td className="px-4 py-3 text-sm text-right font-bold text-red-600">{formatCurrency(report.totals.days90Plus, report.currency)}</td>
              <td className="px-4 py-3 text-sm text-right font-bold text-gray-900">{formatCurrency(report.totals.total, report.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Report Info */}
      <div className="mt-4 flex justify-between items-center text-sm text-gray-500">
        <span>As of: {new Date(report.asOf).toLocaleDateString()}</span>
        <button
          onClick={() => refetch()}
          className="text-indigo-600 hover:text-indigo-800"
        >
          Refresh
        </button>
      </div>
    </div>
  );
};

// Processing Metrics Component
const ProcessingMetrics: React.FC = () => {
  // This would fetch real metrics from the API
  const metrics = {
    totalProcessed: 156,
    avgProcessingTime: 12.5,
    matchRate: 87.5,
    autoBookRate: 72.3,
    errorRate: 2.1,
    byDay: [
      { date: '2024-01-20', processed: 23, matched: 20, booked: 18 },
      { date: '2024-01-21', processed: 28, matched: 25, booked: 22 },
      { date: '2024-01-22', processed: 19, matched: 17, booked: 15 },
      { date: '2024-01-23', processed: 32, matched: 30, booked: 28 },
      { date: '2024-01-24', processed: 25, matched: 23, booked: 20 },
      { date: '2024-01-25', processed: 15, matched: 14, booked: 12 },
      { date: '2024-01-26', processed: 14, matched: 13, booked: 11 },
    ],
  };

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Total Processed</p>
          <p className="text-2xl font-bold text-gray-900">{metrics.totalProcessed}</p>
          <p className="text-xs text-gray-400">Last 7 days</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Avg Processing Time</p>
          <p className="text-2xl font-bold text-gray-900">{metrics.avgProcessingTime}s</p>
          <p className="text-xs text-gray-400">Per invoice</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Match Rate</p>
          <p className="text-2xl font-bold text-green-600">{metrics.matchRate}%</p>
          <p className="text-xs text-gray-400">PO matching</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Auto-Book Rate</p>
          <p className="text-2xl font-bold text-indigo-600">{metrics.autoBookRate}%</p>
          <p className="text-xs text-gray-400">No manual review</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Error Rate</p>
          <p className="text-2xl font-bold text-red-600">{metrics.errorRate}%</p>
          <p className="text-xs text-gray-400">Processing errors</p>
        </div>
      </div>

      {/* Daily Chart (simplified) */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Processing Volume (Last 7 Days)</h3>
        <div className="h-64 flex items-end gap-2">
          {metrics.byDay.map(day => {
            const maxProcessed = Math.max(...metrics.byDay.map(d => d.processed));
            const height = (day.processed / maxProcessed) * 100;
            const matchedHeight = (day.matched / maxProcessed) * 100;
            const bookedHeight = (day.booked / maxProcessed) * 100;

            return (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex flex-col items-center relative" style={{ height: '200px' }}>
                  <div
                    className="w-full bg-gray-200 rounded-t absolute bottom-0"
                    style={{ height: `${height}%` }}
                  />
                  <div
                    className="w-full bg-indigo-400 rounded-t absolute bottom-0"
                    style={{ height: `${matchedHeight}%` }}
                  />
                  <div
                    className="w-full bg-green-500 rounded-t absolute bottom-0"
                    style={{ height: `${bookedHeight}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500">
                  {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-gray-200 rounded" />
            <span className="text-gray-600">Processed</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-indigo-400 rounded" />
            <span className="text-gray-600">Matched</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded" />
            <span className="text-gray-600">Booked</span>
          </div>
        </div>
      </div>
    </div>
  );
};

// Export Options Component
const ExportOptions: React.FC<{ reportType: string }> = ({ reportType }) => {
  const handleExport = (format: string) => {
    // In production, this would trigger a download
    console.log(`Exporting ${reportType} as ${format}`);
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={() => handleExport('csv')}
        className="px-3 py-1 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        Export CSV
      </button>
      <button
        onClick={() => handleExport('excel')}
        className="px-3 py-1 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        Export Excel
      </button>
      <button
        onClick={() => handleExport('pdf')}
        className="px-3 py-1 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
      >
        Export PDF
      </button>
    </div>
  );
};

// Main Reports Component
const Reports: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'ap-aging' | 'ar-aging' | 'metrics'>('ap-aging');

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Financial Reports</h1>
          <p className="text-gray-500 mt-1">Aging reports, metrics, and analytics</p>
        </div>
        <ExportOptions reportType={activeTab} />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <TabButton
          active={activeTab === 'ap-aging'}
          onClick={() => setActiveTab('ap-aging')}
        >
          AP Aging
        </TabButton>
        <TabButton
          active={activeTab === 'ar-aging'}
          onClick={() => setActiveTab('ar-aging')}
        >
          AR Aging
        </TabButton>
        <TabButton
          active={activeTab === 'metrics'}
          onClick={() => setActiveTab('metrics')}
        >
          Processing Metrics
        </TabButton>
      </div>

      {/* Content */}
      {activeTab === 'ap-aging' && <AgingReportView type="payable" />}
      {activeTab === 'ar-aging' && <AgingReportView type="receivable" />}
      {activeTab === 'metrics' && <ProcessingMetrics />}
    </div>
  );
};

export default Reports;
