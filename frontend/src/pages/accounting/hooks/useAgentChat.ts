/**
 * Custom hook for Accounting Agent chat interactions
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, AgentStatus, VoiceSession } from '../types/accounting.types';

const API_BASE = '/api/accounting';

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  agentStatus: AgentStatus;
}

/**
 * Hook for managing agent chat state and interactions
 */
export function useAgentChat() {
  const [state, setState] = useState<ChatState>({
    messages: [],
    isLoading: false,
    error: null,
    agentStatus: {
      isActive: false,
      state: 'idle',
    },
  });

  const messageIdCounter = useRef(0);

  // Generate unique message ID
  const generateMessageId = useCallback(() => {
    messageIdCounter.current += 1;
    return `msg-${Date.now()}-${messageIdCounter.current}`;
  }, []);

  // Add a message to the chat
  const addMessage = useCallback((role: ChatMessage['role'], content: string, actions?: ChatMessage['actions']) => {
    const message: ChatMessage = {
      id: generateMessageId(),
      role,
      content,
      timestamp: new Date().toISOString(),
      actions,
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, message],
    }));

    return message;
  }, [generateMessageId]);

  // Send a message to the agent
  const sendMessage = useCallback(async (content: string) => {
    // Add user message
    addMessage('user', content);

    setState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
      agentStatus: { ...prev.agentStatus, state: 'thinking' },
    }));

    try {
      const response = await fetch(`${API_BASE}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: content }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response from agent');
      }

      const data = await response.json();

      // Add assistant response
      addMessage('assistant', data.response || data.message, data.actions);

      setState(prev => ({
        ...prev,
        isLoading: false,
        agentStatus: { ...prev.agentStatus, state: 'idle' },
      }));

      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';

      setState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
        agentStatus: { ...prev.agentStatus, state: 'error' },
      }));

      addMessage('system', `Error: ${errorMessage}`);
      throw err;
    }
  }, [addMessage]);

  // Clear chat history
  const clearChat = useCallback(() => {
    setState(prev => ({
      ...prev,
      messages: [],
      error: null,
    }));
  }, []);

  // Suggested prompts for quick actions
  const suggestedPrompts = [
    'Show me pending invoices',
    'What invoices need review?',
    'Generate aging report',
    'Scan emails for new invoices',
    'What is our accounts payable balance?',
    'Show recent errors',
  ];

  return {
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    agentStatus: state.agentStatus,
    sendMessage,
    addMessage,
    clearChat,
    suggestedPrompts,
  };
}

/**
 * Hook for voice session management with LiveKit
 */
export function useVoiceSession() {
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start a voice session
  const startSession = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/voice/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to start voice session');
      }

      const data = await response.json();
      setSession(data);
      setIsActive(true);
      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start voice session';
      setError(errorMessage);
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  // End the voice session
  const endSession = useCallback(() => {
    setSession(null);
    setIsActive(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (session) {
        endSession();
      }
    };
  }, [session, endSession]);

  return {
    session,
    isConnecting,
    isActive,
    error,
    startSession,
    endSession,
  };
}

/**
 * Hook for agent status polling
 */
export function useAgentStatus() {
  const [status, setStatus] = useState<AgentStatus>({
    isActive: false,
    state: 'idle',
  });
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/status`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      }
    } catch {
      // Silently fail, will retry
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll status every 5 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return { status, loading, refetch: fetchStatus };
}
