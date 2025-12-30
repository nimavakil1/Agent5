/**
 * Accounting Agent Chat Interface
 *
 * Chat interface with voice support for interacting with
 * the Accounting Agent.
 */

import React, { useState, useRef, useEffect } from 'react';
import { useAgentChat, useVoiceSession, useAgentStatus } from './hooks/useAgentChat';
import type { ChatMessage } from './types/accounting.types';

// Agent State Colors
const stateColors: Record<string, string> = {
  idle: '#10B981',
  thinking: '#F59E0B',
  executing: '#3B82F6',
  waiting: '#8B5CF6',
  error: '#EF4444',
};

// Format timestamp
const formatTime = (timestamp: string): string => {
  return new Date(timestamp).toLocaleTimeString('en-EU', {
    hour: '2-digit',
    minute: '2-digit',
  });
};

// Agent Status Indicator
const AgentStatusIndicator: React.FC<{ state: string }> = ({ state }) => {
  const color = stateColors[state] || stateColors.idle;

  return (
    <div className="flex items-center gap-2">
      <div
        className="w-3 h-3 rounded-full"
        style={{ backgroundColor: color }}
      >
        {state === 'thinking' && (
          <div className="w-3 h-3 rounded-full animate-ping" style={{ backgroundColor: color }} />
        )}
      </div>
      <span className="text-sm text-gray-600 capitalize">{state}</span>
    </div>
  );
};

// Chat Message Component
const ChatMessageBubble: React.FC<{
  message: ChatMessage;
  onAction?: (action: string, invoiceId?: string) => void;
}> = ({ message, onAction }) => {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-indigo-600 text-white'
            : isSystem
            ? 'bg-red-50 text-red-800 border border-red-200'
            : 'bg-gray-100 text-gray-900'
        }`}
      >
        <div className="whitespace-pre-wrap text-sm">{message.content}</div>

        {/* Action buttons */}
        {message.actions && message.actions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.actions.map(action => (
              <button
                key={action.id}
                onClick={() => onAction?.(action.type, action.invoiceId)}
                className="px-3 py-1 bg-white text-indigo-600 rounded-full text-xs font-medium hover:bg-indigo-50 border border-indigo-200"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        <div className={`text-xs mt-1 ${isUser ? 'text-indigo-200' : 'text-gray-400'}`}>
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
};

// Suggested Prompt Button
const SuggestedPrompt: React.FC<{
  prompt: string;
  onClick: () => void;
}> = ({ prompt, onClick }) => (
  <button
    onClick={onClick}
    className="px-4 py-2 bg-white border border-gray-200 rounded-full text-sm text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition"
  >
    {prompt}
  </button>
);

// Voice Control Button
const VoiceButton: React.FC<{
  isActive: boolean;
  isConnecting: boolean;
  onClick: () => void;
}> = ({ isActive, isConnecting, onClick }) => (
  <button
    onClick={onClick}
    disabled={isConnecting}
    className={`p-3 rounded-full transition ${
      isActive
        ? 'bg-red-100 text-red-600 hover:bg-red-200'
        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
    } ${isConnecting ? 'opacity-50 cursor-wait' : ''}`}
    title={isActive ? 'Stop voice' : 'Start voice'}
  >
    {isConnecting ? (
      <svg className="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    ) : isActive ? (
      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ) : (
      <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
      </svg>
    )}
  </button>
);

// Main Chat Component
const AccountingChat: React.FC = () => {
  const {
    messages,
    isLoading,
    error,
    agentStatus,
    sendMessage,
    clearChat,
    suggestedPrompts,
  } = useAgentChat();

  const {
    isActive: voiceActive,
    isConnecting: voiceConnecting,
    startSession,
    endSession,
  } = useVoiceSession();

  const { status } = useAgentStatus();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const message = input.trim();
    setInput('');

    try {
      await sendMessage(message);
    } catch {
      // Error handled by hook
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestedPrompt = (prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  const handleVoiceToggle = async () => {
    if (voiceActive) {
      endSession();
    } else {
      try {
        await startSession();
      } catch {
        // Error handled by hook
      }
    }
  };

  const handleAction = async (action: string, invoiceId?: string) => {
    // Convert action to natural language command
    const commands: Record<string, string> = {
      process: `Process invoice ${invoiceId}`,
      approve: `Approve invoice ${invoiceId}`,
      reject: `Reject invoice ${invoiceId}`,
      book: `Book invoice ${invoiceId} to Odoo`,
      view: `Show details for invoice ${invoiceId}`,
    };

    const command = commands[action];
    if (command) {
      await sendMessage(command);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900">Accounting Agent</h1>
              <p className="text-sm text-gray-500">Ask questions or give commands</p>
            </div>
            <AgentStatusIndicator state={agentStatus.state} />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={clearChat}
              className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
            >
              Clear Chat
            </button>
            <a
              href="/ui/accounting"
              className="px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm"
            >
              Dashboard
            </a>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-lg font-medium">Start a conversation</p>
            <p className="text-sm mt-1">Ask about invoices, reports, or give commands</p>

            {/* Suggested prompts */}
            <div className="mt-8 flex flex-wrap justify-center gap-2 max-w-2xl">
              {suggestedPrompts.map((prompt, idx) => (
                <SuggestedPrompt
                  key={idx}
                  prompt={prompt}
                  onClick={() => handleSuggestedPrompt(prompt)}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map(message => (
              <ChatMessageBubble
                key={message.id}
                message={message}
                onAction={handleAction}
              />
            ))}

            {/* Loading indicator */}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="bg-gray-100 rounded-lg px-4 py-3">
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="px-6 py-2 bg-red-50 border-t border-red-200">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      {/* Voice Active Indicator */}
      {voiceActive && (
        <div className="px-6 py-3 bg-green-50 border-t border-green-200 flex items-center justify-center gap-2">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
          <span className="text-green-700 text-sm font-medium">Voice session active - Speak to interact</span>
        </div>
      )}

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <VoiceButton
            isActive={voiceActive}
            isConnecting={voiceConnecting}
            onClick={handleVoiceToggle}
          />

          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message or ask a question..."
              disabled={isLoading}
              className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Quick action chips when not loading */}
        {!isLoading && messages.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestedPrompts.slice(0, 4).map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => handleSuggestedPrompt(prompt)}
                className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-xs hover:bg-gray-200"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AccountingChat;
