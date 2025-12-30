/**
 * Custom hooks for Accounting Agent data fetching
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  VendorInvoice,
  AccountingMetrics,
  AgingReport,
  InvoiceFilters,
  InvoiceListResponse,
  ProcessInvoiceResponse,
  AccountingSettings,
} from '../types/accounting.types';

const API_BASE = '/api/accounting';

// Generic fetch helper
async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || 'API request failed');
  }

  return response.json();
}

/**
 * Hook for fetching and managing invoices list
 */
export function useInvoices(filters: InvoiceFilters = {}, page = 1, limit = 20) {
  const [invoices, setInvoices] = useState<VendorInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      });

      if (filters.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
        statuses.forEach(s => params.append('status', s));
      }
      if (filters.vendor) params.append('vendor', filters.vendor);
      if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
      if (filters.dateTo) params.append('dateTo', filters.dateTo);
      if (filters.matchingStatus) params.append('matchingStatus', filters.matchingStatus);

      const data = await apiFetch<InvoiceListResponse>(`/invoices?${params}`);
      setInvoices(data.invoices);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch invoices');
    } finally {
      setLoading(false);
    }
  }, [filters, page, limit]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  return { invoices, total, loading, error, refetch: fetchInvoices };
}

/**
 * Hook for fetching single invoice details
 */
export function useInvoice(invoiceId: string | null) {
  const [invoice, setInvoice] = useState<VendorInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInvoice = useCallback(async () => {
    if (!invoiceId) {
      setInvoice(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch<{ invoice: VendorInvoice }>(`/invoices/${invoiceId}`);
      setInvoice(data.invoice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch invoice');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  return { invoice, loading, error, refetch: fetchInvoice };
}

/**
 * Hook for accounting dashboard metrics
 */
export function useAccountingMetrics() {
  const [metrics, setMetrics] = useState<AccountingMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch<AccountingMetrics>('/metrics');
      setMetrics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  return { metrics, loading, error, refetch: fetchMetrics };
}

/**
 * Hook for invoice actions (process, approve, reject, book)
 */
export function useInvoiceActions() {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const processInvoice = useCallback(async (invoiceId: string): Promise<ProcessInvoiceResponse> => {
    setProcessing(true);
    setError(null);

    try {
      const result = await apiFetch<ProcessInvoiceResponse>(`/invoices/${invoiceId}/process`, {
        method: 'POST',
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process invoice';
      setError(message);
      throw err;
    } finally {
      setProcessing(false);
    }
  }, []);

  const approveInvoice = useCallback(async (invoiceId: string, notes?: string) => {
    setProcessing(true);
    setError(null);

    try {
      const result = await apiFetch<{ success: boolean }>(`/invoices/${invoiceId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to approve invoice';
      setError(message);
      throw err;
    } finally {
      setProcessing(false);
    }
  }, []);

  const rejectInvoice = useCallback(async (invoiceId: string, reason: string) => {
    setProcessing(true);
    setError(null);

    try {
      const result = await apiFetch<{ success: boolean }>(`/invoices/${invoiceId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reject invoice';
      setError(message);
      throw err;
    } finally {
      setProcessing(false);
    }
  }, []);

  const bookInvoice = useCallback(async (invoiceId: string) => {
    setProcessing(true);
    setError(null);

    try {
      const result = await apiFetch<{ success: boolean; odooInvoiceId?: number; odooInvoiceNumber?: string }>(
        `/invoices/${invoiceId}/book`,
        { method: 'POST' }
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to book invoice';
      setError(message);
      throw err;
    } finally {
      setProcessing(false);
    }
  }, []);

  return {
    processing,
    error,
    processInvoice,
    approveInvoice,
    rejectInvoice,
    bookInvoice,
  };
}

/**
 * Hook for aging reports
 */
export function useAgingReport(type: 'payable' | 'receivable' = 'payable') {
  const [report, setReport] = useState<AgingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch<AgingReport>(`/reports/aging?type=${type}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch aging report');
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { report, loading, error, refetch: fetchReport };
}

/**
 * Hook for settings management
 */
export function useAccountingSettings() {
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiFetch<AccountingSettings>('/settings');
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSettings = useCallback(async (newSettings: Partial<AccountingSettings>) => {
    setSaving(true);
    setError(null);

    try {
      const result = await apiFetch<AccountingSettings>('/settings', {
        method: 'PUT',
        body: JSON.stringify(newSettings),
      });
      setSettings(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      setError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return { settings, loading, saving, error, refetch: fetchSettings, saveSettings };
}

/**
 * Hook for email scanning trigger
 */
export function useEmailScan() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<{
    scanned: number;
    invoiceEmails: number;
    created: number;
    errors: { emailId: string; error: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scanEmails = useCallback(async (hoursBack = 24) => {
    setScanning(true);
    setError(null);
    setResult(null);

    try {
      const data = await apiFetch<typeof result>(`/scan-emails?hoursBack=${hoursBack}`, {
        method: 'POST',
      });
      setResult(data);
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to scan emails';
      setError(message);
      throw err;
    } finally {
      setScanning(false);
    }
  }, []);

  return { scanning, result, error, scanEmails };
}
