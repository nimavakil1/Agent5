/**
 * Agent Monitoring Dashboard
 *
 * Real-time monitoring interface for AI agent swarm.
 * Displays health status, metrics, activity, and alerts.
 */

import React, { useState, useEffect, useCallback } from 'react';

// Types
interface Agent {
  id: string;
  name: string;
  role: string;
  state: string;
  lastHeartbeat: string;
  lastActivity: string | null;
  metrics: AgentMetrics;
}

interface AgentMetrics {
  tasksProcessed: number;
  tasksFailed: number;
  tasksSuccess: number;
  errorRate: string | number;
  avgTaskDuration: number;
  p99TaskDuration: number;
  messagesSent: number;
  messagesReceived: number;
  toolCalls: number;
  llmCalls: number;
  llmTokens: number;
}

interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  source: string;
  title: string;
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

interface Activity {
  id: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  timestamp: string;
}

interface DashboardData {
  timestamp: string;
  health: {
    status: string;
    agents: Record<string, { status: string; state: string }>;
    issues: { agentId: string; issue: string }[];
  };
  agents: Agent[];
  alerts: Alert[];
  activity: Activity[];
  charts: {
    agentStates: Record<string, number>;
    taskTrend: { timestamp: string; total: number; success: number; failed: number }[];
  };
}

// State color mapping
const stateColors: Record<string, string> = {
  idle: '#10B981',      // green
  thinking: '#F59E0B',  // yellow
  executing: '#3B82F6', // blue
  waiting: '#8B5CF6',   // purple
  error: '#EF4444',     // red
  offline: '#6B7280'    // gray
};

const severityColors: Record<string, string> = {
  info: '#3B82F6',
  warning: '#F59E0B',
  error: '#EF4444',
  critical: '#DC2626'
};

// Health status badge
const HealthBadge: React.FC<{ status: string }> = ({ status }) => {
  const colors: Record<string, string> = {
    healthy: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    critical: 'bg-red-100 text-red-800',
    unknown: 'bg-gray-100 text-gray-800'
  };

  return (
    <span className={`px-3 py-1 rounded-full text-sm font-medium ${colors[status] || colors.unknown}`}>
      {status.toUpperCase()}
    </span>
  );
};

// Agent card component
const AgentCard: React.FC<{
  agent: Agent;
  onSelect: (id: string) => void;
}> = ({ agent, onSelect }) => {
  const stateColor = stateColors[agent.state] || stateColors.offline;

  return (
    <div
      className="bg-white rounded-lg shadow p-4 cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => onSelect(agent.id)}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-lg">{agent.name}</h3>
        <div
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: stateColor }}
          title={agent.state}
        />
      </div>

      <div className="text-sm text-gray-500 mb-2">
        Role: <span className="text-gray-700">{agent.role}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-gray-500">Tasks:</span>
          <span className="ml-1 font-medium">{agent.metrics.tasksProcessed}</span>
        </div>
        <div>
          <span className="text-gray-500">Success:</span>
          <span className="ml-1 font-medium text-green-600">
            {agent.metrics.tasksSuccess}
          </span>
        </div>
        <div>
          <span className="text-gray-500">Failed:</span>
          <span className="ml-1 font-medium text-red-600">
            {agent.metrics.tasksFailed}
          </span>
        </div>
        <div>
          <span className="text-gray-500">Avg Time:</span>
          <span className="ml-1 font-medium">{agent.metrics.avgTaskDuration}ms</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t text-xs text-gray-400">
        Last activity: {agent.lastActivity
          ? new Date(agent.lastActivity).toLocaleTimeString()
          : 'Never'}
      </div>
    </div>
  );
};

// Alert item component
const AlertItem: React.FC<{
  alert: Alert;
  onAcknowledge: (id: string) => void;
}> = ({ alert, onAcknowledge }) => {
  const bgColor = alert.acknowledged ? 'bg-gray-50' : 'bg-white';

  return (
    <div className={`${bgColor} rounded-lg shadow p-3 mb-2`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center">
          <div
            className="w-2 h-2 rounded-full mr-2"
            style={{ backgroundColor: severityColors[alert.severity] }}
          />
          <span className="font-medium">{alert.title}</span>
        </div>
        {!alert.acknowledged && (
          <button
            className="text-xs text-blue-600 hover:text-blue-800"
            onClick={() => onAcknowledge(alert.id)}
          >
            Acknowledge
          </button>
        )}
      </div>
      <p className="text-sm text-gray-600 mt-1">{alert.message}</p>
      <div className="text-xs text-gray-400 mt-2">
        {new Date(alert.timestamp).toLocaleString()} - {alert.source}
      </div>
    </div>
  );
};

// Activity feed component
const ActivityFeed: React.FC<{ activities: Activity[] }> = ({ activities }) => {
  return (
    <div className="space-y-2">
      {activities.map((activity) => (
        <div key={activity.id} className="flex items-start text-sm">
          <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 mr-2" />
          <div className="flex-1">
            <div className="flex justify-between">
              <span className="font-medium">{activity.agentId}</span>
              <span className="text-gray-400 text-xs">
                {new Date(activity.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="text-gray-600">{activity.action}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

// State distribution chart (simple bar)
const StateChart: React.FC<{ data: Record<string, number> }> = ({ data }) => {
  const total = Object.values(data).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="space-y-2">
      {Object.entries(data).map(([state, count]) => (
        <div key={state} className="flex items-center">
          <span className="w-20 text-sm text-gray-600">{state}</span>
          <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${(count / total) * 100}%`,
                backgroundColor: stateColors[state] || '#6B7280'
              }}
            />
          </div>
          <span className="w-8 text-right text-sm text-gray-600">{count}</span>
        </div>
      ))}
    </div>
  );
};

// Metrics summary component
const MetricsSummary: React.FC<{ metrics: Record<string, { value: number }> }> = ({ metrics }) => {
  const items = [
    { key: 'agents_total', label: 'Total Agents', icon: '🤖' },
    { key: 'agents_active', label: 'Active', icon: '⚡' },
    { key: 'tasks_total', label: 'Total Tasks', icon: '📋' },
    { key: 'tasks_success', label: 'Successful', icon: '✅' },
    { key: 'tasks_failed', label: 'Failed', icon: '❌' },
    { key: 'messages_total', label: 'Messages', icon: '💬' }
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {items.map((item) => (
        <div key={item.key} className="bg-white rounded-lg shadow p-4 text-center">
          <div className="text-2xl mb-1">{item.icon}</div>
          <div className="text-2xl font-bold">
            {metrics[item.key]?.value || 0}
          </div>
          <div className="text-xs text-gray-500">{item.label}</div>
        </div>
      ))}
    </div>
  );
};

// Main Dashboard Component
const AgentDashboard: React.FC = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchDashboard = useCallback(async () => {
    try {
      const response = await fetch('/api/monitoring/dashboard');
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      const dashboardData = await response.json();
      setData(dashboardData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const acknowledgeAlert = async (alertId: string) => {
    try {
      await fetch(`/api/monitoring/alerts/${alertId}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgedBy: 'dashboard-user' })
      });
      fetchDashboard();
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };

  useEffect(() => {
    fetchDashboard();

    if (autoRefresh) {
      const interval = setInterval(fetchDashboard, 5000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, fetchDashboard]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-lg text-gray-600">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-lg text-red-600 mb-4">Error: {error}</div>
          <button
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            onClick={fetchDashboard}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Agent Monitoring Dashboard</h1>
          <p className="text-sm text-gray-500">
            Last updated: {new Date(data.timestamp).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center space-x-4">
          <HealthBadge status={data.health.status} />
          <label className="flex items-center text-sm text-gray-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="mr-2"
            />
            Auto-refresh
          </label>
          <button
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            onClick={fetchDashboard}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Metrics Summary */}
      <div className="mb-6">
        <MetricsSummary metrics={data.metrics?.system || {}} />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agents Section */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <h2 className="text-lg font-semibold mb-4">Agents ({data.agents.length})</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onSelect={setSelectedAgent}
                />
              ))}
            </div>
          </div>

          {/* State Distribution */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-semibold mb-4">Agent States</h2>
            <StateChart data={data.charts.agentStates} />
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="space-y-6">
          {/* Alerts */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-semibold mb-4">
              Alerts ({data.alerts.filter((a) => !a.acknowledged).length})
            </h2>
            <div className="max-h-64 overflow-y-auto">
              {data.alerts.length === 0 ? (
                <p className="text-gray-500 text-sm">No alerts</p>
              ) : (
                data.alerts.map((alert) => (
                  <AlertItem
                    key={alert.id}
                    alert={alert}
                    onAcknowledge={acknowledgeAlert}
                  />
                ))
              )}
            </div>
          </div>

          {/* Activity Feed */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
            <div className="max-h-64 overflow-y-auto">
              {data.activity.length === 0 ? (
                <p className="text-gray-500 text-sm">No recent activity</p>
              ) : (
                <ActivityFeed activities={data.activity.slice(0, 20)} />
              )}
            </div>
          </div>

          {/* Issues */}
          {data.health.issues.length > 0 && (
            <div className="bg-red-50 rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold text-red-800 mb-4">Issues</h2>
              <ul className="space-y-2">
                {data.health.issues.map((issue, idx) => (
                  <li key={idx} className="text-sm text-red-700">
                    <span className="font-medium">{issue.agentId}:</span> {issue.issue}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Agent Detail Modal */}
      {selectedAgent && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setSelectedAgent(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full m-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">Agent Details</h2>
              <button
                className="text-gray-500 hover:text-gray-700"
                onClick={() => setSelectedAgent(null)}
              >
                Close
              </button>
            </div>
            {(() => {
              const agent = data.agents.find((a) => a.id === selectedAgent);
              if (!agent) return <p>Agent not found</p>;

              return (
                <div>
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div>
                      <p className="text-gray-500 text-sm">Name</p>
                      <p className="font-medium">{agent.name}</p>
                    </div>
                    <div>
                      <p className="text-gray-500 text-sm">Role</p>
                      <p className="font-medium">{agent.role}</p>
                    </div>
                    <div>
                      <p className="text-gray-500 text-sm">State</p>
                      <div className="flex items-center">
                        <div
                          className="w-2 h-2 rounded-full mr-2"
                          style={{ backgroundColor: stateColors[agent.state] }}
                        />
                        <span className="font-medium">{agent.state}</span>
                      </div>
                    </div>
                    <div>
                      <p className="text-gray-500 text-sm">Error Rate</p>
                      <p className="font-medium">{agent.metrics.errorRate}%</p>
                    </div>
                  </div>

                  <h3 className="font-semibold mb-2">Metrics</h3>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">Tasks</p>
                      <p className="font-bold">{agent.metrics.tasksProcessed}</p>
                    </div>
                    <div className="bg-green-50 rounded p-2">
                      <p className="text-gray-500">Success</p>
                      <p className="font-bold text-green-600">{agent.metrics.tasksSuccess}</p>
                    </div>
                    <div className="bg-red-50 rounded p-2">
                      <p className="text-gray-500">Failed</p>
                      <p className="font-bold text-red-600">{agent.metrics.tasksFailed}</p>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">Avg Duration</p>
                      <p className="font-bold">{agent.metrics.avgTaskDuration}ms</p>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">P99 Duration</p>
                      <p className="font-bold">{agent.metrics.p99TaskDuration}ms</p>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">Tool Calls</p>
                      <p className="font-bold">{agent.metrics.toolCalls}</p>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">LLM Calls</p>
                      <p className="font-bold">{agent.metrics.llmCalls}</p>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">LLM Tokens</p>
                      <p className="font-bold">{agent.metrics.llmTokens}</p>
                    </div>
                    <div className="bg-gray-50 rounded p-2">
                      <p className="text-gray-500">Messages</p>
                      <p className="font-bold">
                        {agent.metrics.messagesSent + agent.metrics.messagesReceived}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentDashboard;
