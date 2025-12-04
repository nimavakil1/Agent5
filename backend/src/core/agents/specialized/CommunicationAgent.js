/**
 * Communication Intelligence Agent
 *
 * Monitors and analyzes ALL company communications:
 * - All employee emails (inbox, sent, drafts)
 * - Teams chats and channel messages
 * - Teams presence and activity
 *
 * Capabilities:
 * - Real-time email monitoring across all mailboxes
 * - Communication pattern analysis
 * - Urgency and sentiment detection
 * - Customer/supplier communication tracking
 * - Action item extraction
 * - Response recommendations (with approval)
 *
 * Requires Microsoft Graph API with Application permissions:
 * - Mail.Read (all mailboxes)
 * - Mail.ReadWrite (for drafts/sending)
 * - Chat.Read.All (Teams chats)
 * - ChannelMessage.Read.All (Teams channels)
 * - User.Read.All (user directory)
 * - Presence.Read.All (user presence)
 *
 * @module CommunicationAgent
 */

const LLMAgent = require('../LLMAgent');

/**
 * Communication categories
 */
const CommunicationCategory = {
  CUSTOMER: 'customer',
  SUPPLIER: 'supplier',
  PARTNER: 'partner',
  INTERNAL: 'internal',
  MARKETING: 'marketing',
  SUPPORT: 'support',
  LEGAL: 'legal',
  FINANCE: 'finance',
  SPAM: 'spam',
  UNKNOWN: 'unknown'
};

/**
 * Urgency levels
 */
const UrgencyLevel = {
  CRITICAL: 'critical',    // Needs immediate attention
  HIGH: 'high',            // Needs attention today
  MEDIUM: 'medium',        // Needs attention this week
  LOW: 'low',              // Informational
  NONE: 'none'             // No action needed
};

/**
 * Sentiment types
 */
const Sentiment = {
  POSITIVE: 'positive',
  NEUTRAL: 'neutral',
  NEGATIVE: 'negative',
  ANGRY: 'angry',
  URGENT: 'urgent'
};

class CommunicationAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Communication Intelligence Agent',
      role: 'communication_intelligence',
      capabilities: [
        'email_monitoring',
        'teams_monitoring',
        'communication_analysis',
        'urgency_detection',
        'sentiment_analysis',
        'action_extraction',
        'response_drafting'
      ],
      ...config
    });

    // Microsoft Graph client (application permissions)
    this.graphClient = null;
    this.graphConfig = {
      tenantId: config.tenantId || process.env.MICROSOFT_TENANT_ID,
      clientId: config.clientId || process.env.MICROSOFT_CLIENT_ID,
      clientSecret: config.clientSecret || process.env.MICROSOFT_CLIENT_SECRET
    };

    // Access token management
    this.accessToken = null;
    this.tokenExpiry = null;

    // Monitoring state
    this.monitoredMailboxes = new Map();  // userId -> { lastSync, deltaToken }
    this.monitoredChats = new Map();      // chatId -> { lastSync }
    this.monitoredChannels = new Map();   // teamId/channelId -> { lastSync }

    // Analysis queue
    this.analysisQueue = [];
    this.pendingActions = [];

    // Known contacts (for classification)
    this.knownContacts = {
      customers: new Set(),
      suppliers: new Set(),
      partners: new Set()
    };

    // Settings
    this.settings = {
      syncIntervalMs: config.syncIntervalMs || 60000,  // 1 minute
      batchSize: config.batchSize || 50,
      analyzeOnSync: config.analyzeOnSync !== false,
      requireApproval: config.requireApproval !== false
    };

    // Define tools
    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      {
        name: 'list_all_users',
        description: 'Get all users/employees in the organization',
        parameters: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Optional OData filter'
            }
          }
        },
        handler: this._listAllUsers.bind(this)
      },
      {
        name: 'get_user_emails',
        description: 'Get emails from a specific user mailbox',
        parameters: {
          type: 'object',
          properties: {
            user_id: {
              type: 'string',
              description: 'User ID or email address'
            },
            folder: {
              type: 'string',
              description: 'Folder name (inbox, sentItems, drafts)',
              default: 'inbox'
            },
            count: {
              type: 'number',
              description: 'Number of emails to retrieve',
              default: 50
            },
            unread_only: {
              type: 'boolean',
              description: 'Only get unread emails',
              default: false
            }
          },
          required: ['user_id']
        },
        handler: this._getUserEmails.bind(this)
      },
      {
        name: 'get_all_recent_emails',
        description: 'Get recent emails from ALL company mailboxes',
        parameters: {
          type: 'object',
          properties: {
            hours_back: {
              type: 'number',
              description: 'How many hours back to look',
              default: 24
            },
            unread_only: {
              type: 'boolean',
              description: 'Only get unread emails',
              default: false
            }
          }
        },
        handler: this._getAllRecentEmails.bind(this)
      },
      {
        name: 'analyze_email',
        description: 'Analyze an email for category, urgency, sentiment, and action items',
        parameters: {
          type: 'object',
          properties: {
            email_id: {
              type: 'string',
              description: 'Email ID to analyze'
            },
            user_id: {
              type: 'string',
              description: 'User ID who owns the mailbox'
            }
          },
          required: ['email_id', 'user_id']
        },
        handler: this._analyzeEmail.bind(this)
      },
      {
        name: 'get_communication_summary',
        description: 'Get a summary of all company communications',
        parameters: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'week', 'month'],
              default: 'today'
            }
          }
        },
        handler: this._getCommunicationSummary.bind(this)
      },
      {
        name: 'get_teams_chats',
        description: 'Get Teams chat messages',
        parameters: {
          type: 'object',
          properties: {
            user_id: {
              type: 'string',
              description: 'User ID to get chats for'
            },
            count: {
              type: 'number',
              description: 'Number of chats to retrieve',
              default: 20
            }
          },
          required: ['user_id']
        },
        handler: this._getTeamsChats.bind(this)
      },
      {
        name: 'get_teams_channel_messages',
        description: 'Get messages from a Teams channel',
        parameters: {
          type: 'object',
          properties: {
            team_id: {
              type: 'string',
              description: 'Team ID'
            },
            channel_id: {
              type: 'string',
              description: 'Channel ID'
            },
            count: {
              type: 'number',
              description: 'Number of messages to retrieve',
              default: 50
            }
          },
          required: ['team_id', 'channel_id']
        },
        handler: this._getTeamsChannelMessages.bind(this)
      },
      {
        name: 'get_user_presence',
        description: 'Get presence/availability status of users',
        parameters: {
          type: 'object',
          properties: {
            user_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of user IDs'
            }
          },
          required: ['user_ids']
        },
        handler: this._getUserPresence.bind(this)
      },
      {
        name: 'draft_email_response',
        description: 'Draft a response to an email (requires approval before sending)',
        parameters: {
          type: 'object',
          properties: {
            original_email_id: {
              type: 'string',
              description: 'ID of email to respond to'
            },
            user_id: {
              type: 'string',
              description: 'User ID whose mailbox to use'
            },
            response_content: {
              type: 'string',
              description: 'Draft response content'
            },
            response_type: {
              type: 'string',
              enum: ['reply', 'replyAll', 'forward'],
              default: 'reply'
            }
          },
          required: ['original_email_id', 'user_id', 'response_content']
        },
        handler: this._draftEmailResponse.bind(this)
      },
      {
        name: 'get_pending_actions',
        description: 'Get all pending actions awaiting approval',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getPendingActions.bind(this)
      },
      {
        name: 'detect_urgent_items',
        description: 'Scan all communications for urgent items needing attention',
        parameters: {
          type: 'object',
          properties: {
            include_emails: {
              type: 'boolean',
              default: true
            },
            include_teams: {
              type: 'boolean',
              default: true
            }
          }
        },
        handler: this._detectUrgentItems.bind(this)
      },
      {
        name: 'get_customer_communications',
        description: 'Get all recent communications with customers',
        parameters: {
          type: 'object',
          properties: {
            customer_email: {
              type: 'string',
              description: 'Optional: filter by specific customer email'
            },
            days_back: {
              type: 'number',
              default: 7
            }
          }
        },
        handler: this._getCustomerCommunications.bind(this)
      },
      {
        name: 'get_supplier_communications',
        description: 'Get all recent communications with suppliers',
        parameters: {
          type: 'object',
          properties: {
            supplier_email: {
              type: 'string',
              description: 'Optional: filter by specific supplier email'
            },
            days_back: {
              type: 'number',
              default: 7
            }
          }
        },
        handler: this._getSupplierCommunications.bind(this)
      },
      {
        name: 'extract_action_items',
        description: 'Extract action items from recent communications',
        parameters: {
          type: 'object',
          properties: {
            user_id: {
              type: 'string',
              description: 'Optional: filter by user'
            },
            hours_back: {
              type: 'number',
              default: 24
            }
          }
        },
        handler: this._extractActionItems.bind(this)
      }
    ];
  }

  // ==================== AUTHENTICATION ====================

  async _getAccessToken() {
    // Check if we have a valid token
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    const fetch = (await import('node-fetch')).default;

    const tokenUrl = `https://login.microsoftonline.com/${this.graphConfig.tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: this.graphConfig.clientId,
      client_secret: this.graphConfig.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get access token: ${error}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + (data.expires_in - 300) * 1000);

    return this.accessToken;
  }

  async _graphRequest(endpoint, options = {}) {
    const fetch = (await import('node-fetch')).default;
    const token = await this._getAccessToken();

    const url = endpoint.startsWith('http')
      ? endpoint
      : `https://graph.microsoft.com/v1.0${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Graph API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // ==================== USER MANAGEMENT ====================

  async _listAllUsers(params = {}) {
    const filter = params.filter || "accountEnabled eq true";
    const endpoint = `/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mail,userPrincipalName,department,jobTitle`;

    const result = await this._graphRequest(endpoint);

    return {
      users: result.value.map(user => ({
        id: user.id,
        name: user.displayName,
        email: user.mail || user.userPrincipalName,
        department: user.department,
        jobTitle: user.jobTitle
      })),
      count: result.value.length
    };
  }

  // ==================== EMAIL MONITORING ====================

  async _getUserEmails(params) {
    const { user_id, folder = 'inbox', count = 50, unread_only = false } = params;

    let endpoint = `/users/${user_id}/mailFolders/${folder}/messages?$top=${count}&$orderby=receivedDateTime desc`;

    if (unread_only) {
      endpoint += `&$filter=isRead eq false`;
    }

    endpoint += `&$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,importance,bodyPreview,hasAttachments`;

    const result = await this._graphRequest(endpoint);

    return {
      user_id,
      folder,
      emails: result.value.map(email => ({
        id: email.id,
        subject: email.subject,
        from: email.from?.emailAddress?.address,
        fromName: email.from?.emailAddress?.name,
        to: email.toRecipients?.map(r => r.emailAddress?.address) || [],
        cc: email.ccRecipients?.map(r => r.emailAddress?.address) || [],
        receivedAt: email.receivedDateTime,
        isRead: email.isRead,
        importance: email.importance,
        preview: email.bodyPreview,
        hasAttachments: email.hasAttachments
      })),
      count: result.value.length
    };
  }

  async _getAllRecentEmails(params = {}) {
    const { hours_back = 24, unread_only = false } = params;

    // Get all users
    const users = await this._listAllUsers();

    const cutoffDate = new Date(Date.now() - hours_back * 60 * 60 * 1000).toISOString();
    const allEmails = [];

    for (const user of users.users) {
      try {
        let endpoint = `/users/${user.id}/messages?$top=100&$orderby=receivedDateTime desc`;
        endpoint += `&$filter=receivedDateTime ge ${cutoffDate}`;

        if (unread_only) {
          endpoint += ` and isRead eq false`;
        }

        endpoint += `&$select=id,subject,from,toRecipients,receivedDateTime,isRead,importance,bodyPreview`;

        const result = await this._graphRequest(endpoint);

        for (const email of result.value) {
          allEmails.push({
            id: email.id,
            userId: user.id,
            userName: user.name,
            userEmail: user.email,
            subject: email.subject,
            from: email.from?.emailAddress?.address,
            fromName: email.from?.emailAddress?.name,
            to: email.toRecipients?.map(r => r.emailAddress?.address) || [],
            receivedAt: email.receivedDateTime,
            isRead: email.isRead,
            importance: email.importance,
            preview: email.bodyPreview
          });
        }
      } catch (error) {
        console.error(`Error fetching emails for ${user.email}: ${error.message}`);
      }
    }

    // Sort by date
    allEmails.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    return {
      period: `Last ${hours_back} hours`,
      totalEmails: allEmails.length,
      unreadOnly: unread_only,
      emails: allEmails
    };
  }

  async _getEmailBody(userId, emailId) {
    const endpoint = `/users/${userId}/messages/${emailId}?$select=body,bodyPreview`;
    const result = await this._graphRequest(endpoint);
    return result.body?.content || result.bodyPreview;
  }

  // ==================== EMAIL ANALYSIS ====================

  async _analyzeEmail(params) {
    const { email_id, user_id } = params;

    // Get full email
    const endpoint = `/users/${user_id}/messages/${email_id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,importance,hasAttachments`;
    const email = await this._graphRequest(endpoint);

    const fromEmail = email.from?.emailAddress?.address?.toLowerCase() || '';
    const subject = email.subject || '';
    const body = email.body?.content || email.bodyPreview || '';

    // Analyze with LLM
    const analysisPrompt = `Analyze this email and provide a structured analysis:

Subject: ${subject}
From: ${email.from?.emailAddress?.name} <${fromEmail}>
Body: ${body.substring(0, 2000)}

Provide analysis in this JSON format:
{
  "category": "customer|supplier|partner|internal|marketing|support|legal|finance|spam|unknown",
  "urgency": "critical|high|medium|low|none",
  "sentiment": "positive|neutral|negative|angry|urgent",
  "summary": "2-3 sentence summary",
  "actionItems": ["list of action items extracted"],
  "suggestedResponse": "brief suggested response if needed, or null",
  "requiresAttention": true/false,
  "attentionReason": "why it needs attention, if applicable"
}`;

    const analysis = await this._analyzeWithLLM(analysisPrompt);

    return {
      emailId: email_id,
      userId: user_id,
      subject,
      from: fromEmail,
      receivedAt: email.receivedDateTime,
      analysis: analysis
    };
  }

  async _analyzeWithLLM(prompt) {
    try {
      const response = await this.llmClient.chat.completions.create({
        model: this.config.model || 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an email analysis assistant. Always respond with valid JSON.'
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      return {
        category: 'unknown',
        urgency: 'medium',
        sentiment: 'neutral',
        summary: 'Analysis failed',
        actionItems: [],
        suggestedResponse: null,
        requiresAttention: false,
        error: error.message
      };
    }
  }

  // ==================== TEAMS MONITORING ====================

  async _getTeamsChats(params) {
    const { user_id, count = 20 } = params;

    // Get user's chats
    const chatsEndpoint = `/users/${user_id}/chats?$top=${count}&$expand=members`;
    const chats = await this._graphRequest(chatsEndpoint);

    const chatData = [];

    for (const chat of chats.value) {
      try {
        // Get recent messages from this chat
        const messagesEndpoint = `/chats/${chat.id}/messages?$top=10&$orderby=createdDateTime desc`;
        const messages = await this._graphRequest(messagesEndpoint);

        chatData.push({
          chatId: chat.id,
          chatType: chat.chatType,
          topic: chat.topic,
          members: chat.members?.map(m => ({
            id: m.userId,
            displayName: m.displayName,
            email: m.email
          })) || [],
          recentMessages: messages.value.map(msg => ({
            id: msg.id,
            from: msg.from?.user?.displayName,
            content: msg.body?.content?.substring(0, 500),
            createdAt: msg.createdDateTime
          }))
        });
      } catch (error) {
        console.error(`Error fetching chat ${chat.id}: ${error.message}`);
      }
    }

    return {
      userId: user_id,
      chats: chatData,
      count: chatData.length
    };
  }

  async _getTeamsChannelMessages(params) {
    const { team_id, channel_id, count = 50 } = params;

    const endpoint = `/teams/${team_id}/channels/${channel_id}/messages?$top=${count}&$orderby=createdDateTime desc`;
    const result = await this._graphRequest(endpoint);

    return {
      teamId: team_id,
      channelId: channel_id,
      messages: result.value.map(msg => ({
        id: msg.id,
        from: msg.from?.user?.displayName,
        content: msg.body?.content?.substring(0, 1000),
        contentType: msg.body?.contentType,
        createdAt: msg.createdDateTime,
        importance: msg.importance,
        hasReplies: (msg.replies?.length || 0) > 0
      })),
      count: result.value.length
    };
  }

  async _getUserPresence(params) {
    const { user_ids } = params;

    const presenceData = [];

    for (const userId of user_ids) {
      try {
        const endpoint = `/users/${userId}/presence`;
        const presence = await this._graphRequest(endpoint);

        presenceData.push({
          userId,
          availability: presence.availability,
          activity: presence.activity,
          statusMessage: presence.statusMessage?.message?.content
        });
      } catch (error) {
        presenceData.push({
          userId,
          availability: 'Unknown',
          error: error.message
        });
      }
    }

    return { presenceData };
  }

  // ==================== COMMUNICATION SUMMARY ====================

  async _getCommunicationSummary(params = {}) {
    const { period = 'today' } = params;

    let hoursBack;
    switch (period) {
      case 'today': hoursBack = 24; break;
      case 'week': hoursBack = 168; break;
      case 'month': hoursBack = 720; break;
      default: hoursBack = 24;
    }

    const emails = await this._getAllRecentEmails({ hours_back: hoursBack });

    // Categorize emails
    const byCategory = {};
    const _byUrgency = {}; // TODO: Implement urgency categorization
    const byUser = {};

    for (const email of emails.emails) {
      // Simple categorization based on sender
      const category = this._categorizeEmail(email);
      byCategory[category] = (byCategory[category] || 0) + 1;

      // Track by user
      byUser[email.userName] = byUser[email.userName] || { received: 0, emails: [] };
      byUser[email.userName].received++;
      byUser[email.userName].emails.push({
        subject: email.subject,
        from: email.from,
        receivedAt: email.receivedAt
      });
    }

    return {
      period,
      totalEmails: emails.totalEmails,
      byCategory,
      byUser: Object.entries(byUser).map(([name, data]) => ({
        name,
        received: data.received
      })),
      topSenders: this._getTopSenders(emails.emails, 10)
    };
  }

  _categorizeEmail(email) {
    const from = (email.from || '').toLowerCase();

    if (this.knownContacts.customers.has(from)) return CommunicationCategory.CUSTOMER;
    if (this.knownContacts.suppliers.has(from)) return CommunicationCategory.SUPPLIER;
    if (this.knownContacts.partners.has(from)) return CommunicationCategory.PARTNER;

    // Simple heuristics
    if (from.includes('noreply') || from.includes('newsletter')) return CommunicationCategory.MARKETING;
    if (from.includes('support') || from.includes('help')) return CommunicationCategory.SUPPORT;
    if (from.includes('invoice') || from.includes('payment')) return CommunicationCategory.FINANCE;

    return CommunicationCategory.UNKNOWN;
  }

  _getTopSenders(emails, limit) {
    const senderCount = {};
    for (const email of emails) {
      const sender = email.from || 'unknown';
      senderCount[sender] = (senderCount[sender] || 0) + 1;
    }

    return Object.entries(senderCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([sender, count]) => ({ sender, count }));
  }

  // ==================== URGENT ITEM DETECTION ====================

  async _detectUrgentItems(params = {}) {
    const { include_emails = true, include_teams: _include_teams = true } = params;

    const urgentItems = [];

    if (include_emails) {
      // Get unread emails from all users
      const emails = await this._getAllRecentEmails({ hours_back: 48, unread_only: true });

      for (const email of emails.emails.slice(0, 20)) {  // Analyze top 20
        try {
          const analysis = await this._analyzeEmail({
            email_id: email.id,
            user_id: email.userId
          });

          if (analysis.analysis?.urgency === 'critical' || analysis.analysis?.urgency === 'high') {
            urgentItems.push({
              type: 'email',
              id: email.id,
              userId: email.userId,
              userName: email.userName,
              subject: email.subject,
              from: email.from,
              receivedAt: email.receivedAt,
              urgency: analysis.analysis.urgency,
              reason: analysis.analysis.attentionReason,
              suggestedAction: analysis.analysis.suggestedResponse
            });
          }
        } catch (error) {
          console.error(`Error analyzing email: ${error.message}`);
        }
      }
    }

    return {
      urgentItems,
      count: urgentItems.length,
      timestamp: new Date().toISOString()
    };
  }

  // ==================== CUSTOMER/SUPPLIER COMMUNICATIONS ====================

  async _getCustomerCommunications(params = {}) {
    const { customer_email, days_back = 7 } = params;

    const emails = await this._getAllRecentEmails({ hours_back: days_back * 24 });

    let filtered = emails.emails;
    if (customer_email) {
      filtered = filtered.filter(e =>
        e.from?.toLowerCase().includes(customer_email.toLowerCase()) ||
        e.to?.some(t => t.toLowerCase().includes(customer_email.toLowerCase()))
      );
    } else {
      // Filter to known customers
      filtered = filtered.filter(e =>
        this.knownContacts.customers.has(e.from?.toLowerCase())
      );
    }

    return {
      customerEmail: customer_email || 'all customers',
      period: `${days_back} days`,
      communications: filtered,
      count: filtered.length
    };
  }

  async _getSupplierCommunications(params = {}) {
    const { supplier_email, days_back = 7 } = params;

    const emails = await this._getAllRecentEmails({ hours_back: days_back * 24 });

    let filtered = emails.emails;
    if (supplier_email) {
      filtered = filtered.filter(e =>
        e.from?.toLowerCase().includes(supplier_email.toLowerCase()) ||
        e.to?.some(t => t.toLowerCase().includes(supplier_email.toLowerCase()))
      );
    } else {
      filtered = filtered.filter(e =>
        this.knownContacts.suppliers.has(e.from?.toLowerCase())
      );
    }

    return {
      supplierEmail: supplier_email || 'all suppliers',
      period: `${days_back} days`,
      communications: filtered,
      count: filtered.length
    };
  }

  // ==================== ACTION ITEMS ====================

  async _extractActionItems(params = {}) {
    const { user_id, hours_back = 24 } = params;

    const emails = user_id
      ? await this._getUserEmails({ user_id, count: 50 })
      : await this._getAllRecentEmails({ hours_back });

    const emailList = emails.emails || [];
    const allActionItems = [];

    // Analyze emails for action items (limit to avoid API overload)
    for (const email of emailList.slice(0, 20)) {
      try {
        const userId = email.userId || user_id;
        const analysis = await this._analyzeEmail({
          email_id: email.id,
          user_id: userId
        });

        if (analysis.analysis?.actionItems?.length > 0) {
          for (const item of analysis.analysis.actionItems) {
            allActionItems.push({
              action: item,
              source: 'email',
              emailId: email.id,
              subject: email.subject,
              from: email.from,
              assignedTo: email.userName || userId,
              urgency: analysis.analysis.urgency,
              extractedAt: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        console.error(`Error extracting actions from email: ${error.message}`);
      }
    }

    return {
      actionItems: allActionItems,
      count: allActionItems.length,
      period: `${hours_back} hours`
    };
  }

  // ==================== RESPONSE DRAFTING ====================

  async _draftEmailResponse(params) {
    const { original_email_id, user_id, response_content, response_type = 'reply' } = params;

    if (!this.settings.requireApproval) {
      // Actually create draft
      const endpoint = `/users/${user_id}/messages/${original_email_id}/createReply`;
      const draft = await this._graphRequest(endpoint, { method: 'POST' });

      // Update draft with response content
      await this._graphRequest(`/users/${user_id}/messages/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          body: {
            contentType: 'HTML',
            content: response_content
          }
        })
      });

      return {
        status: 'draft_created',
        draftId: draft.id,
        requiresApproval: true,
        message: 'Draft created. Awaiting approval to send.'
      };
    }

    // Add to pending actions
    const pendingAction = {
      id: `action_${Date.now()}`,
      type: 'email_response',
      originalEmailId: original_email_id,
      userId: user_id,
      responseType: response_type,
      responseContent: response_content,
      createdAt: new Date().toISOString(),
      status: 'pending_approval'
    };

    this.pendingActions.push(pendingAction);

    return {
      status: 'pending_approval',
      actionId: pendingAction.id,
      message: 'Response drafted and awaiting human approval.'
    };
  }

  async _getPendingActions(_params = {}) {
    return {
      pendingActions: this.pendingActions.filter(a => a.status === 'pending_approval'),
      count: this.pendingActions.filter(a => a.status === 'pending_approval').length
    };
  }

  // ==================== CONTACT MANAGEMENT ====================

  addKnownCustomer(email) {
    this.knownContacts.customers.add(email.toLowerCase());
  }

  addKnownSupplier(email) {
    this.knownContacts.suppliers.add(email.toLowerCase());
  }

  addKnownPartner(email) {
    this.knownContacts.partners.add(email.toLowerCase());
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();

    // Test Graph API connection
    try {
      await this._getAccessToken();
      console.log('Communication Agent: Microsoft Graph API connected');
    } catch (error) {
      console.warn('Communication Agent: Graph API not configured:', error.message);
    }
  }
}

module.exports = {
  CommunicationAgent,
  CommunicationCategory,
  UrgencyLevel,
  Sentiment
};
