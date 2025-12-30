/**
 * Accounting Agent Settings
 *
 * Configuration for invoice polling, auto-processing, and notifications.
 */

import React, { useState, useEffect } from 'react';
import { useAccountingSettings } from './hooks/useAccountingData';
import type { AccountingSettings } from './types/accounting.types';

// Toggle Switch Component
const Toggle: React.FC<{
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}> = ({ enabled, onChange, disabled }) => (
  <button
    type="button"
    onClick={() => !disabled && onChange(!enabled)}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
      enabled ? 'bg-indigo-600' : 'bg-gray-200'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    disabled={disabled}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        enabled ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

// Section Header
const SectionHeader: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <div className="mb-4">
    <h3 className="text-lg font-medium text-gray-900">{title}</h3>
    <p className="text-sm text-gray-500">{description}</p>
  </div>
);

// Form Field
const FormField: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className="flex items-center justify-between py-4 border-b border-gray-100 last:border-0">
    <div>
      <label className="text-sm font-medium text-gray-900">{label}</label>
      {description && <p className="text-sm text-gray-500">{description}</p>}
    </div>
    <div>{children}</div>
  </div>
);

// Main Settings Component
const Settings: React.FC = () => {
  const { settings: savedSettings, loading, saving, error, saveSettings } = useAccountingSettings();
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Initialize local state from saved settings
  useEffect(() => {
    if (savedSettings) {
      setSettings(savedSettings);
    }
  }, [savedSettings]);

  // Update a setting value
  const updateSetting = <K extends keyof AccountingSettings>(
    section: K,
    key: keyof AccountingSettings[K],
    value: AccountingSettings[K][typeof key]
  ) => {
    if (!settings) return;

    setSettings({
      ...settings,
      [section]: {
        ...settings[section],
        [key]: value,
      },
    });
    setHasChanges(true);
    setSaveSuccess(false);
  };

  // Handle save
  const handleSave = async () => {
    if (!settings) return;

    try {
      await saveSettings(settings);
      setHasChanges(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      // Error handled by hook
    }
  };

  // Handle reset
  const handleReset = () => {
    if (savedSettings) {
      setSettings(savedSettings);
      setHasChanges(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 bg-gray-50 min-h-screen">
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500">Loading settings...</p>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="p-6 bg-gray-50 min-h-screen">
        <div className="flex items-center justify-center h-64">
          <p className="text-red-500">Failed to load settings</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Accounting Settings</h1>
          <p className="text-gray-500 mt-1">Configure invoice processing and automation</p>
        </div>
        <div className="flex gap-3">
          {hasChanges && (
            <button
              onClick={handleReset}
              className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Reset
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Success Message */}
      {saveSuccess && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-green-800">Settings saved successfully</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {/* Settings Sections */}
      <div className="space-y-6">
        {/* Email Polling */}
        <div className="bg-white rounded-lg shadow p-6">
          <SectionHeader
            title="Email Polling"
            description="Configure automatic invoice email scanning"
          />

          <FormField
            label="Enable Email Polling"
            description="Automatically scan for new invoice emails"
          >
            <Toggle
              enabled={settings.invoicePolling.enabled}
              onChange={v => updateSetting('invoicePolling', 'enabled', v)}
            />
          </FormField>

          <FormField
            label="Polling Interval"
            description="How often to check for new emails (minutes)"
          >
            <select
              value={settings.invoicePolling.intervalMinutes}
              onChange={e => updateSetting('invoicePolling', 'intervalMinutes', parseInt(e.target.value))}
              disabled={!settings.invoicePolling.enabled}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value={1}>Every 1 minute</option>
              <option value={5}>Every 5 minutes</option>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every hour</option>
            </select>
          </FormField>

          <FormField
            label="Mailbox"
            description="Email address to monitor for invoices"
          >
            <input
              type="email"
              value={settings.invoicePolling.mailboxUserId}
              onChange={e => updateSetting('invoicePolling', 'mailboxUserId', e.target.value)}
              disabled={!settings.invoicePolling.enabled}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 disabled:opacity-50"
              placeholder="invoices@company.com"
            />
          </FormField>

          <FormField
            label="Target Folder"
            description="Email folder to scan"
          >
            <input
              type="text"
              value={settings.invoicePolling.targetFolder}
              onChange={e => updateSetting('invoicePolling', 'targetFolder', e.target.value)}
              disabled={!settings.invoicePolling.enabled}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48 disabled:opacity-50"
              placeholder="Inbox"
            />
          </FormField>

          <FormField
            label="Processed Folder"
            description="Move processed emails to this folder"
          >
            <input
              type="text"
              value={settings.invoicePolling.processedFolder}
              onChange={e => updateSetting('invoicePolling', 'processedFolder', e.target.value)}
              disabled={!settings.invoicePolling.enabled}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48 disabled:opacity-50"
              placeholder="Processed Invoices"
            />
          </FormField>
        </div>

        {/* Auto Processing */}
        <div className="bg-white rounded-lg shadow p-6">
          <SectionHeader
            title="Automatic Processing"
            description="Configure invoice auto-matching and booking"
          />

          <FormField
            label="Enable Auto-Processing"
            description="Automatically process newly received invoices"
          >
            <Toggle
              enabled={settings.autoProcessing.enabled}
              onChange={v => updateSetting('autoProcessing', 'enabled', v)}
            />
          </FormField>

          <FormField
            label="Auto-Match Threshold"
            description="Minimum confidence to auto-approve matches"
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={50}
                max={100}
                value={settings.autoProcessing.autoMatchThreshold}
                onChange={e => updateSetting('autoProcessing', 'autoMatchThreshold', parseInt(e.target.value))}
                disabled={!settings.autoProcessing.enabled}
                className="w-32 disabled:opacity-50"
              />
              <span className="text-sm text-gray-600 w-12">
                {settings.autoProcessing.autoMatchThreshold}%
              </span>
            </div>
          </FormField>

          <FormField
            label="Approval Amount Threshold"
            description="Require manual approval above this amount (EUR)"
          >
            <input
              type="number"
              value={settings.autoProcessing.approvalAmountThreshold}
              onChange={e => updateSetting('autoProcessing', 'approvalAmountThreshold', parseInt(e.target.value))}
              disabled={!settings.autoProcessing.enabled}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-32 disabled:opacity-50"
              min={0}
              step={100}
            />
          </FormField>

          <FormField
            label="Auto-Post to Odoo"
            description="Automatically post bills after booking"
          >
            <Toggle
              enabled={settings.autoProcessing.autoPostEnabled}
              onChange={v => updateSetting('autoProcessing', 'autoPostEnabled', v)}
              disabled={!settings.autoProcessing.enabled}
            />
          </FormField>
        </div>

        {/* Notifications */}
        <div className="bg-white rounded-lg shadow p-6">
          <SectionHeader
            title="Notifications"
            description="Configure email alerts"
          />

          <FormField
            label="Email on Error"
            description="Send email when invoice processing fails"
          >
            <Toggle
              enabled={settings.notifications.emailOnError}
              onChange={v => updateSetting('notifications', 'emailOnError', v)}
            />
          </FormField>

          <FormField
            label="Email on Approval Needed"
            description="Send email when manual approval is required"
          >
            <Toggle
              enabled={settings.notifications.emailOnApprovalNeeded}
              onChange={v => updateSetting('notifications', 'emailOnApprovalNeeded', v)}
            />
          </FormField>

          <FormField
            label="Notification Recipients"
            description="Email addresses for notifications (comma-separated)"
          >
            <input
              type="text"
              value={settings.notifications.emailRecipients.join(', ')}
              onChange={e => updateSetting(
                'notifications',
                'emailRecipients',
                e.target.value.split(',').map(s => s.trim()).filter(Boolean)
              )}
              disabled={!settings.notifications.emailOnError && !settings.notifications.emailOnApprovalNeeded}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-80 disabled:opacity-50"
              placeholder="finance@company.com, accounting@company.com"
            />
          </FormField>
        </div>

        {/* Integration Status */}
        <div className="bg-white rounded-lg shadow p-6">
          <SectionHeader
            title="Integration Status"
            description="Connected services and their status"
          />

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <svg className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M21.17 3H2.83A2.83 2.83 0 000 5.83v12.34A2.83 2.83 0 002.83 21h18.34A2.83 2.83 0 0024 18.17V5.83A2.83 2.83 0 0021.17 3zM12 18.5c-3.59 0-6.5-2.91-6.5-6.5S8.41 5.5 12 5.5s6.5 2.91 6.5 6.5-2.91 6.5-6.5 6.5z"/>
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">Microsoft 365</p>
                  <p className="text-xs text-gray-500">Email & Calendar</p>
                </div>
              </div>
              <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Connected
              </span>
            </div>

            <div className="flex items-center justify-between py-3 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                  <svg className="w-6 h-6 text-purple-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">Odoo</p>
                  <p className="text-xs text-gray-500">ERP & Accounting</p>
                </div>
              </div>
              <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Connected
              </span>
            </div>

            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                  <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">LiveKit Voice</p>
                  <p className="text-xs text-gray-500">Voice Agent</p>
                </div>
              </div>
              <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Available
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
