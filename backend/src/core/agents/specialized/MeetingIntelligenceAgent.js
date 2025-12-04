/**
 * Meeting Intelligence Agent
 *
 * AI agent that participates in meetings via LiveKit:
 * - Real-time meeting transcription
 * - Speaker identification and diarization
 * - Automatic action item extraction
 * - Meeting summarization
 * - Sentiment and engagement analysis
 * - Decision tracking
 * - Follow-up task creation
 * - Integration with calendar systems
 *
 * Integrates with:
 * - LiveKit (real-time audio/video)
 * - Microsoft Teams/Outlook Calendar
 * - Odoo (task creation)
 * - Speech-to-text services
 * - LLM for analysis
 *
 * @module MeetingIntelligenceAgent
 */

const LLMAgent = require('../LLMAgent');

/**
 * Meeting types
 */
const MeetingType = {
  STANDUP: 'standup',
  PLANNING: 'planning',
  REVIEW: 'review',
  ONEONONE: 'one_on_one',
  SALES: 'sales',
  CUSTOMER: 'customer',
  ALLHANDS: 'all_hands',
  BRAINSTORM: 'brainstorm',
  INTERVIEW: 'interview',
  TRAINING: 'training',
  OTHER: 'other'
};

/**
 * Meeting status
 */
const MeetingStatus = {
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

/**
 * Action item priority
 */
const ActionPriority = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

/**
 * Participant engagement levels
 */
const EngagementLevel = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  SILENT: 'silent'
};

class MeetingIntelligenceAgent extends LLMAgent {
  constructor(id, config = {}) {
    super(id, {
      name: config.name || 'Meeting Intelligence Agent',
      role: 'meeting_intelligence',
      capabilities: [
        'meeting_transcription',
        'speaker_diarization',
        'action_extraction',
        'meeting_summarization',
        'sentiment_analysis',
        'decision_tracking',
        'followup_creation',
        'calendar_integration',
        'real_time_participation'
      ],
      ...config
    });

    // Integration clients
    this.liveKitClient = config.liveKitClient || null;
    this.microsoftClient = config.microsoftClient || null;
    this.odooClient = config.odooClient || null;
    this.speechClient = config.speechClient || null; // Azure/Google STT

    // LiveKit configuration
    this.liveKitConfig = {
      url: config.liveKitUrl || process.env.LIVEKIT_URL,
      apiKey: config.liveKitApiKey || process.env.LIVEKIT_API_KEY,
      apiSecret: config.liveKitApiSecret || process.env.LIVEKIT_API_SECRET
    };

    // Meeting tracking
    this.activeMeetings = new Map();
    this.completedMeetings = new Map();
    this.actionItems = new Map();
    this.decisions = [];

    // Transcription buffers
    this.transcriptionBuffers = new Map();

    // Settings
    this.settings = {
      autoJoin: config.autoJoin || false,
      transcriptionLanguage: config.language || 'en-US',
      summarizeOnEnd: config.summarizeOnEnd !== false,
      extractActionsOnEnd: config.extractActionsOnEnd !== false,
      sendRecapEmail: config.sendRecapEmail !== false
    };

    this._initializeTools();
  }

  _initializeTools() {
    this.tools = [
      // ==================== MEETING LIFECYCLE ====================
      {
        name: 'join_meeting',
        description: 'Join a meeting room via LiveKit',
        parameters: {
          type: 'object',
          properties: {
            room_name: { type: 'string' },
            meeting_id: { type: 'string' },
            meeting_type: { type: 'string', enum: Object.values(MeetingType) },
            participant_name: { type: 'string', default: 'AI Assistant' }
          },
          required: ['room_name']
        },
        handler: this._joinMeeting.bind(this)
      },
      {
        name: 'leave_meeting',
        description: 'Leave current meeting',
        parameters: {
          type: 'object',
          properties: {
            room_name: { type: 'string' },
            generate_summary: { type: 'boolean', default: true }
          },
          required: ['room_name']
        },
        handler: this._leaveMeeting.bind(this)
      },
      {
        name: 'get_active_meetings',
        description: 'Get list of active meetings the agent is in',
        parameters: {
          type: 'object',
          properties: {}
        },
        handler: this._getActiveMeetings.bind(this)
      },
      {
        name: 'get_scheduled_meetings',
        description: 'Get upcoming scheduled meetings',
        parameters: {
          type: 'object',
          properties: {
            hours_ahead: { type: 'number', default: 24 },
            include_recurring: { type: 'boolean', default: true }
          }
        },
        handler: this._getScheduledMeetings.bind(this)
      },

      // ==================== TRANSCRIPTION ====================
      {
        name: 'get_live_transcript',
        description: 'Get current transcript from active meeting',
        parameters: {
          type: 'object',
          properties: {
            room_name: { type: 'string' },
            last_n_minutes: { type: 'number', default: 5 }
          },
          required: ['room_name']
        },
        handler: this._getLiveTranscript.bind(this)
      },
      {
        name: 'get_full_transcript',
        description: 'Get complete transcript of a meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            include_timestamps: { type: 'boolean', default: true },
            include_speakers: { type: 'boolean', default: true }
          },
          required: ['meeting_id']
        },
        handler: this._getFullTranscript.bind(this)
      },
      {
        name: 'search_transcript',
        description: 'Search meeting transcripts for keywords',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            meeting_id: { type: 'string' },
            date_from: { type: 'string' },
            date_to: { type: 'string' }
          },
          required: ['query']
        },
        handler: this._searchTranscript.bind(this)
      },

      // ==================== MEETING ANALYSIS ====================
      {
        name: 'generate_meeting_summary',
        description: 'Generate AI summary of a meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            summary_type: { type: 'string', enum: ['brief', 'detailed', 'executive'], default: 'detailed' }
          },
          required: ['meeting_id']
        },
        handler: this._generateMeetingSummary.bind(this)
      },
      {
        name: 'extract_action_items',
        description: 'Extract action items from meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            auto_assign: { type: 'boolean', default: false }
          },
          required: ['meeting_id']
        },
        handler: this._extractActionItems.bind(this)
      },
      {
        name: 'extract_decisions',
        description: 'Extract decisions made in meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' }
          },
          required: ['meeting_id']
        },
        handler: this._extractDecisions.bind(this)
      },
      {
        name: 'analyze_meeting_sentiment',
        description: 'Analyze sentiment and engagement in meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            by_participant: { type: 'boolean', default: true }
          },
          required: ['meeting_id']
        },
        handler: this._analyzeMeetingSentiment.bind(this)
      },
      {
        name: 'get_participant_stats',
        description: 'Get participation statistics for meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' }
          },
          required: ['meeting_id']
        },
        handler: this._getParticipantStats.bind(this)
      },

      // ==================== ACTION ITEMS ====================
      {
        name: 'get_action_items',
        description: 'Get action items from meetings',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            assignee: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'all'], default: 'pending' }
          }
        },
        handler: this._getActionItems.bind(this)
      },
      {
        name: 'create_action_item',
        description: 'Create action item from meeting (requires approval)',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            assignee: { type: 'string' },
            due_date: { type: 'string' },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }
          },
          required: ['title']
        },
        handler: this._createActionItem.bind(this)
      },
      {
        name: 'sync_actions_to_odoo',
        description: 'Sync action items to Odoo tasks',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            project_id: { type: 'number' }
          }
        },
        handler: this._syncActionsToOdoo.bind(this)
      },

      // ==================== FOLLOW-UPS ====================
      {
        name: 'generate_meeting_recap',
        description: 'Generate meeting recap email',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            recipients: { type: 'array', items: { type: 'string' } },
            include_transcript: { type: 'boolean', default: false }
          },
          required: ['meeting_id']
        },
        handler: this._generateMeetingRecap.bind(this)
      },
      {
        name: 'schedule_follow_up',
        description: 'Schedule a follow-up meeting',
        parameters: {
          type: 'object',
          properties: {
            original_meeting_id: { type: 'string' },
            title: { type: 'string' },
            participants: { type: 'array', items: { type: 'string' } },
            suggested_times: { type: 'array', items: { type: 'string' } },
            duration_minutes: { type: 'number', default: 30 }
          },
          required: ['original_meeting_id', 'title']
        },
        handler: this._scheduleFollowUp.bind(this)
      },

      // ==================== REAL-TIME FEATURES ====================
      {
        name: 'get_discussion_topics',
        description: 'Get current discussion topics from live meeting',
        parameters: {
          type: 'object',
          properties: {
            room_name: { type: 'string' }
          },
          required: ['room_name']
        },
        handler: this._getDiscussionTopics.bind(this)
      },
      {
        name: 'detect_off_topic',
        description: 'Detect if discussion has gone off-topic',
        parameters: {
          type: 'object',
          properties: {
            room_name: { type: 'string' },
            agenda: { type: 'array', items: { type: 'string' } }
          },
          required: ['room_name']
        },
        handler: this._detectOffTopic.bind(this)
      },
      {
        name: 'get_unanswered_questions',
        description: 'Get questions raised but not answered',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' }
          },
          required: ['meeting_id']
        },
        handler: this._getUnansweredQuestions.bind(this)
      },

      // ==================== MEETING INSIGHTS ====================
      {
        name: 'get_meeting_insights',
        description: 'Get AI insights from meeting',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' }
          },
          required: ['meeting_id']
        },
        handler: this._getMeetingInsights.bind(this)
      },
      {
        name: 'compare_meetings',
        description: 'Compare metrics across meetings',
        parameters: {
          type: 'object',
          properties: {
            meeting_ids: { type: 'array', items: { type: 'string' } },
            metrics: { type: 'array', items: { type: 'string' } }
          },
          required: ['meeting_ids']
        },
        handler: this._compareMeetings.bind(this)
      },
      {
        name: 'get_meeting_patterns',
        description: 'Analyze patterns across meetings',
        parameters: {
          type: 'object',
          properties: {
            meeting_type: { type: 'string' },
            period_days: { type: 'number', default: 30 }
          }
        },
        handler: this._getMeetingPatterns.bind(this)
      },

      // ==================== REPORTS ====================
      {
        name: 'generate_meeting_report',
        description: 'Generate comprehensive meeting report',
        parameters: {
          type: 'object',
          properties: {
            meeting_id: { type: 'string' },
            format: { type: 'string', enum: ['markdown', 'html', 'json'], default: 'markdown' }
          },
          required: ['meeting_id']
        },
        handler: this._generateMeetingReport.bind(this)
      },
      {
        name: 'get_weekly_meeting_summary',
        description: 'Get summary of all meetings in the week',
        parameters: {
          type: 'object',
          properties: {
            week_start: { type: 'string' }
          }
        },
        handler: this._getWeeklyMeetingSummary.bind(this)
      }
    ];
  }

  // ==================== MEETING LIFECYCLE ====================

  async _joinMeeting(params) {
    const { room_name, meeting_id, meeting_type = MeetingType.OTHER, participant_name = 'AI Assistant' } = params;

    if (!this.liveKitConfig.url) {
      return { error: 'LiveKit not configured' };
    }

    const meetingData = {
      id: meeting_id || `meeting_${Date.now()}`,
      roomName: room_name,
      type: meeting_type,
      status: MeetingStatus.IN_PROGRESS,
      joinedAt: new Date().toISOString(),
      participants: [participant_name],
      transcript: [],
      speakerStats: {},
      topics: []
    };

    this.activeMeetings.set(room_name, meetingData);
    this.transcriptionBuffers.set(room_name, []);

    // In production, would connect to LiveKit
    // const room = await this._connectToLiveKit(room_name);
    // await this._startTranscription(room);

    return {
      success: true,
      message: `Joined meeting: ${room_name}`,
      meetingId: meetingData.id,
      roomName: room_name,
      status: 'connected',
      note: 'LiveKit connection requires VPS deployment with proper audio handling'
    };
  }

  async _leaveMeeting(params) {
    const { room_name, generate_summary = true } = params;

    const meeting = this.activeMeetings.get(room_name);
    if (!meeting) {
      return { error: 'Not in this meeting' };
    }

    meeting.status = MeetingStatus.COMPLETED;
    meeting.leftAt = new Date().toISOString();

    // Generate summary if requested
    let summary = null;
    let actionItems = null;

    if (generate_summary && this.settings.summarizeOnEnd) {
      summary = await this._generateMeetingSummary({ meeting_id: meeting.id });
    }

    if (this.settings.extractActionsOnEnd) {
      actionItems = await this._extractActionItems({ meeting_id: meeting.id });
    }

    // Move to completed meetings
    this.completedMeetings.set(meeting.id, meeting);
    this.activeMeetings.delete(room_name);

    return {
      success: true,
      meetingId: meeting.id,
      duration: this._calculateDuration(meeting.joinedAt, meeting.leftAt),
      summary,
      actionItems: actionItems?.items,
      message: 'Left meeting and generated summary'
    };
  }

  async _getActiveMeetings(_params = {}) {
    const meetings = Array.from(this.activeMeetings.values());

    return {
      activeMeetings: meetings.map(m => ({
        id: m.id,
        roomName: m.roomName,
        type: m.type,
        joinedAt: m.joinedAt,
        duration: this._calculateDuration(m.joinedAt, new Date().toISOString()),
        participantCount: m.participants?.length || 0
      })),
      count: meetings.length
    };
  }

  async _getScheduledMeetings(params = {}) {
    const { hours_ahead = 24, include_recurring = true } = params;

    if (!this.microsoftClient) {
      return { error: 'Microsoft client not configured' };
    }

    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + hours_ahead * 60 * 60 * 1000);

    try {
      const events = await this.microsoftClient.api('/me/calendarview')
        .query({
          startDateTime: startTime.toISOString(),
          endDateTime: endTime.toISOString()
        })
        .get();

      const meetings = events.value
        .filter(e => e.isOnlineMeeting || e.onlineMeeting)
        .map(e => ({
          id: e.id,
          subject: e.subject,
          start: e.start.dateTime,
          end: e.end.dateTime,
          organizer: e.organizer?.emailAddress?.name,
          attendees: e.attendees?.map(a => a.emailAddress?.name),
          onlineMeetingUrl: e.onlineMeeting?.joinUrl,
          isRecurring: !!e.recurrence
        }));

      if (!include_recurring) {
        return {
          meetings: meetings.filter(m => !m.isRecurring),
          count: meetings.filter(m => !m.isRecurring).length
        };
      }

      return {
        meetings,
        count: meetings.length,
        hoursAhead: hours_ahead
      };
    } catch (_e) {
      return { error: 'Failed to fetch calendar' };
    }
  }

  // ==================== TRANSCRIPTION ====================

  async _getLiveTranscript(params) {
    const { room_name, last_n_minutes = 5 } = params;

    const meeting = this.activeMeetings.get(room_name);
    if (!meeting) {
      return { error: 'Not in this meeting' };
    }

    const cutoff = new Date(Date.now() - last_n_minutes * 60 * 1000);
    const recentTranscript = meeting.transcript.filter(t => new Date(t.timestamp) > cutoff);

    return {
      roomName: room_name,
      lastMinutes: last_n_minutes,
      transcript: recentTranscript,
      lineCount: recentTranscript.length
    };
  }

  async _getFullTranscript(params) {
    const { meeting_id, include_timestamps = true, include_speakers = true } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    let transcript = meeting.transcript || [];

    if (!include_timestamps) {
      transcript = transcript.map(t => ({ ...t, timestamp: undefined }));
    }
    if (!include_speakers) {
      transcript = transcript.map(t => ({ ...t, speaker: undefined }));
    }

    return {
      meetingId: meeting_id,
      transcript,
      wordCount: transcript.reduce((sum, t) => sum + (t.text?.split(' ').length || 0), 0),
      duration: meeting.leftAt ? this._calculateDuration(meeting.joinedAt, meeting.leftAt) : 'ongoing'
    };
  }

  async _searchTranscript(params) {
    const { query, meeting_id, date_from, date_to } = params;

    let meetings = [];

    if (meeting_id) {
      const meeting = this.completedMeetings.get(meeting_id);
      if (meeting) meetings.push(meeting);
    } else {
      meetings = Array.from(this.completedMeetings.values());
    }

    // Filter by date if specified
    if (date_from) {
      meetings = meetings.filter(m => new Date(m.joinedAt) >= new Date(date_from));
    }
    if (date_to) {
      meetings = meetings.filter(m => new Date(m.joinedAt) <= new Date(date_to));
    }

    const results = [];
    const queryLower = query.toLowerCase();

    for (const meeting of meetings) {
      const matches = (meeting.transcript || []).filter(t =>
        t.text?.toLowerCase().includes(queryLower)
      );

      if (matches.length > 0) {
        results.push({
          meetingId: meeting.id,
          date: meeting.joinedAt,
          matches: matches.map(m => ({
            timestamp: m.timestamp,
            speaker: m.speaker,
            text: m.text
          }))
        });
      }
    }

    return {
      query,
      results,
      totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0)
    };
  }

  // ==================== MEETING ANALYSIS ====================

  async _generateMeetingSummary(params) {
    const { meeting_id, summary_type = 'detailed' } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const transcript = (meeting.transcript || [])
      .map(t => `${t.speaker || 'Unknown'}: ${t.text}`)
      .join('\n');

    if (!transcript) {
      return {
        meetingId: meeting_id,
        summary: 'No transcript available for summarization',
        type: summary_type
      };
    }

    const prompts = {
      brief: `Provide a 2-3 sentence summary of this meeting:

${transcript}`,
      detailed: `Provide a detailed summary of this meeting, including:
1. Main topics discussed
2. Key points and outcomes
3. Notable disagreements or concerns
4. Next steps mentioned

Transcript:
${transcript}`,
      executive: `Provide an executive summary of this meeting in bullet points, focusing on:
- Strategic decisions
- Business impact
- Action required from leadership
- Risks or concerns raised

Transcript:
${transcript}`
    };

    try {
      const summary = await this._generateWithLLM(prompts[summary_type] || prompts.detailed);
      return {
        meetingId: meeting_id,
        type: summary_type,
        summary,
        generatedAt: new Date().toISOString()
      };
    } catch (_e) {
      return { error: 'Failed to generate summary' };
    }
  }

  async _extractActionItems(params) {
    const { meeting_id, auto_assign = false } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const transcript = (meeting.transcript || [])
      .map(t => `${t.speaker || 'Unknown'}: ${t.text}`)
      .join('\n');

    if (!transcript) {
      return {
        meetingId: meeting_id,
        items: [],
        message: 'No transcript available'
      };
    }

    const prompt = `Extract action items from this meeting transcript. For each action item, identify:
1. The task/action needed
2. Who should do it (if mentioned)
3. Deadline (if mentioned)
4. Priority (inferred from context)

Format as JSON array:
[{"task": "", "assignee": "", "deadline": "", "priority": "high|medium|low"}]

Transcript:
${transcript}`;

    try {
      const response = await this._generateWithLLM(prompt);
      let items = [];

      try {
        items = JSON.parse(response);
      } catch (_e) {
        // Try to extract from text if not valid JSON
        items = [{ task: response, assignee: 'Unassigned', priority: 'medium' }];
      }

      // Store action items
      for (const item of items) {
        const actionId = `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.actionItems.set(actionId, {
          id: actionId,
          meetingId: meeting_id,
          ...item,
          status: 'pending',
          createdAt: new Date().toISOString()
        });
      }

      return {
        meetingId: meeting_id,
        items,
        count: items.length,
        autoAssigned: auto_assign
      };
    } catch (_e) {
      return { error: 'Failed to extract action items' };
    }
  }

  async _extractDecisions(params) {
    const { meeting_id } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const transcript = (meeting.transcript || [])
      .map(t => `${t.speaker || 'Unknown'}: ${t.text}`)
      .join('\n');

    if (!transcript) {
      return { meetingId: meeting_id, decisions: [] };
    }

    const prompt = `Extract decisions made in this meeting. For each decision, identify:
1. The decision made
2. Who made it or approved it
3. Rationale (if discussed)
4. Any conditions or caveats

Format as JSON array:
[{"decision": "", "decidedBy": "", "rationale": "", "conditions": ""}]

Transcript:
${transcript}`;

    try {
      const response = await this._generateWithLLM(prompt);
      let decisions = [];

      try {
        decisions = JSON.parse(response);
      } catch (_e) {
        decisions = [];
      }

      return {
        meetingId: meeting_id,
        decisions,
        count: decisions.length
      };
    } catch (_e) {
      return { error: 'Failed to extract decisions' };
    }
  }

  async _analyzeMeetingSentiment(params) {
    const { meeting_id, by_participant = true } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const transcript = meeting.transcript || [];

    if (transcript.length === 0) {
      return { meetingId: meeting_id, sentiment: 'neutral', message: 'No transcript available' };
    }

    const fullText = transcript.map(t => t.text).join(' ');

    const prompt = `Analyze the sentiment and engagement of this meeting transcript.

Provide:
1. Overall sentiment (positive/neutral/negative)
2. Key positive moments
3. Areas of concern or tension
4. Engagement level indicators

${by_participant ? 'Also analyze by participant if possible.' : ''}

Transcript:
${fullText}`;

    try {
      const analysis = await this._generateWithLLM(prompt);
      return {
        meetingId: meeting_id,
        analysis,
        generatedAt: new Date().toISOString()
      };
    } catch (_e) {
      return { error: 'Failed to analyze sentiment' };
    }
  }

  async _getParticipantStats(params) {
    const { meeting_id } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const transcript = meeting.transcript || [];
    const stats = {};

    for (const entry of transcript) {
      const speaker = entry.speaker || 'Unknown';
      if (!stats[speaker]) {
        stats[speaker] = {
          messages: 0,
          wordCount: 0,
          firstSpoke: entry.timestamp,
          lastSpoke: entry.timestamp
        };
      }
      stats[speaker].messages++;
      stats[speaker].wordCount += entry.text?.split(' ').length || 0;
      stats[speaker].lastSpoke = entry.timestamp;
    }

    // Calculate percentages
    const totalWords = Object.values(stats).reduce((sum, s) => sum + s.wordCount, 0);
    for (const speaker of Object.keys(stats)) {
      stats[speaker].speakingPercentage = totalWords > 0
        ? ((stats[speaker].wordCount / totalWords) * 100).toFixed(1) + '%'
        : '0%';
    }

    return {
      meetingId: meeting_id,
      participants: stats,
      totalParticipants: Object.keys(stats).length
    };
  }

  // ==================== ACTION ITEMS ====================

  async _getActionItems(params = {}) {
    const { meeting_id, assignee, status = 'pending' } = params;

    let items = Array.from(this.actionItems.values());

    if (meeting_id) {
      items = items.filter(i => i.meetingId === meeting_id);
    }
    if (assignee) {
      items = items.filter(i => i.assignee?.toLowerCase().includes(assignee.toLowerCase()));
    }
    if (status !== 'all') {
      items = items.filter(i => i.status === status);
    }

    return {
      items,
      count: items.length
    };
  }

  async _createActionItem(params) {
    const { meeting_id, title, description, assignee, due_date, priority = 'medium' } = params;

    return {
      status: 'pending_approval',
      message: 'Action item creation requires human approval',
      actionItem: {
        meetingId: meeting_id,
        title,
        description,
        assignee,
        dueDate: due_date,
        priority
      }
    };
  }

  async _syncActionsToOdoo(params = {}) {
    const { meeting_id, project_id } = params;

    if (!this.odooClient) {
      return { error: 'Odoo client not configured' };
    }

    const actions = await this._getActionItems({ meeting_id, status: 'pending' });
    if (actions.error) return actions;

    return {
      status: 'pending_approval',
      message: 'Syncing actions to Odoo requires human approval',
      actionsToSync: actions.items.length,
      projectId: project_id
    };
  }

  // ==================== FOLLOW-UPS ====================

  async _generateMeetingRecap(params) {
    const { meeting_id, recipients = [], include_transcript = false } = params;

    const summary = await this._generateMeetingSummary({ meeting_id, summary_type: 'detailed' });
    const actions = await this._getActionItems({ meeting_id });
    const decisions = await this._extractDecisions({ meeting_id });

    const meeting = this.completedMeetings.get(meeting_id);

    const recap = `# Meeting Recap

**Date:** ${meeting?.joinedAt || 'Unknown'}
**Duration:** ${meeting?.leftAt ? this._calculateDuration(meeting.joinedAt, meeting.leftAt) : 'Unknown'}
**Type:** ${meeting?.type || 'Meeting'}

## Summary
${summary.summary || 'No summary available'}

## Action Items
${actions.items?.map(a => `- [ ] ${a.task} (${a.assignee || 'Unassigned'})`).join('\n') || 'No action items'}

## Decisions Made
${decisions.decisions?.map(d => `- ${d.decision}`).join('\n') || 'No decisions recorded'}

${include_transcript ? `\n## Full Transcript\n${(meeting?.transcript || []).map(t => `**${t.speaker}:** ${t.text}`).join('\n')}` : ''}
`;

    return {
      status: 'pending_approval',
      message: 'Sending meeting recap requires human approval',
      recap,
      recipients,
      meetingId: meeting_id
    };
  }

  async _scheduleFollowUp(params) {
    const { original_meeting_id, title, participants = [], suggested_times = [], duration_minutes = 30 } = params;

    return {
      status: 'pending_approval',
      message: 'Scheduling follow-up meeting requires human approval',
      followUp: {
        originalMeetingId: original_meeting_id,
        title,
        participants,
        suggestedTimes: suggested_times,
        durationMinutes: duration_minutes
      }
    };
  }

  // ==================== REAL-TIME FEATURES ====================

  async _getDiscussionTopics(params) {
    const { room_name } = params;

    const meeting = this.activeMeetings.get(room_name);
    if (!meeting) {
      return { error: 'Not in this meeting' };
    }

    const recentTranscript = (meeting.transcript || []).slice(-20)
      .map(t => t.text)
      .join(' ');

    if (!recentTranscript) {
      return { roomName: room_name, topics: [] };
    }

    const prompt = `What are the main topics being discussed in this conversation? List 3-5 key topics.

${recentTranscript}`;

    try {
      const topics = await this._generateWithLLM(prompt);
      return {
        roomName: room_name,
        topics,
        generatedAt: new Date().toISOString()
      };
    } catch (_e) {
      return { error: 'Failed to analyze topics' };
    }
  }

  async _detectOffTopic(params) {
    const { room_name, agenda = [] } = params;

    const meeting = this.activeMeetings.get(room_name);
    if (!meeting) {
      return { error: 'Not in this meeting' };
    }

    if (agenda.length === 0) {
      return {
        roomName: room_name,
        offTopic: false,
        message: 'No agenda provided for comparison'
      };
    }

    const recentTranscript = (meeting.transcript || []).slice(-10)
      .map(t => t.text)
      .join(' ');

    const prompt = `Given this meeting agenda:
${agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Is the following discussion on-topic or off-topic?
${recentTranscript}

Respond with: ON_TOPIC or OFF_TOPIC and a brief explanation.`;

    try {
      const analysis = await this._generateWithLLM(prompt);
      const isOffTopic = analysis.includes('OFF_TOPIC');

      return {
        roomName: room_name,
        offTopic: isOffTopic,
        analysis,
        agenda
      };
    } catch (_e) {
      return { error: 'Failed to analyze' };
    }
  }

  async _getUnansweredQuestions(params) {
    const { meeting_id } = params;

    const meeting = this.completedMeetings.get(meeting_id) ||
                    Array.from(this.activeMeetings.values()).find(m => m.id === meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const transcript = (meeting.transcript || [])
      .map(t => `${t.speaker || 'Unknown'}: ${t.text}`)
      .join('\n');

    if (!transcript) {
      return { meetingId: meeting_id, questions: [] };
    }

    const prompt = `Identify questions that were asked but not answered in this meeting:

${transcript}

List any unanswered questions with who asked them.`;

    try {
      const questions = await this._generateWithLLM(prompt);
      return {
        meetingId: meeting_id,
        questions,
        generatedAt: new Date().toISOString()
      };
    } catch (_e) {
      return { error: 'Failed to identify questions' };
    }
  }

  // ==================== MEETING INSIGHTS ====================

  async _getMeetingInsights(params) {
    const { meeting_id } = params;

    const summary = await this._generateMeetingSummary({ meeting_id });
    const actions = await this._extractActionItems({ meeting_id });
    const decisions = await this._extractDecisions({ meeting_id });
    const sentiment = await this._analyzeMeetingSentiment({ meeting_id });
    const stats = await this._getParticipantStats({ meeting_id });

    return {
      meetingId: meeting_id,
      insights: {
        summary: summary.summary,
        actionItems: actions.items?.length || 0,
        decisions: decisions.decisions?.length || 0,
        sentiment: sentiment.analysis,
        participation: stats.participants
      },
      generatedAt: new Date().toISOString()
    };
  }

  async _compareMeetings(params) {
    const { meeting_ids, metrics: _metrics = [] } = params;

    const comparisons = [];

    for (const id of meeting_ids) {
      const meeting = this.completedMeetings.get(id);
      if (meeting) {
        const stats = await this._getParticipantStats({ meeting_id: id });
        comparisons.push({
          meetingId: id,
          date: meeting.joinedAt,
          type: meeting.type,
          participantCount: Object.keys(stats.participants || {}).length,
          transcriptLength: meeting.transcript?.length || 0
        });
      }
    }

    return {
      meetings: comparisons,
      comparedCount: comparisons.length
    };
  }

  async _getMeetingPatterns(params = {}) {
    const { meeting_type, period_days = 30 } = params;

    const cutoff = new Date(Date.now() - period_days * 24 * 60 * 60 * 1000);
    let meetings = Array.from(this.completedMeetings.values())
      .filter(m => new Date(m.joinedAt) > cutoff);

    if (meeting_type) {
      meetings = meetings.filter(m => m.type === meeting_type);
    }

    return {
      period: `${period_days} days`,
      meetingType: meeting_type || 'all',
      patterns: {
        totalMeetings: meetings.length,
        avgDuration: 'N/A',
        mostActiveDay: 'N/A',
        commonTopics: []
      },
      message: 'Pattern analysis requires historical data'
    };
  }

  // ==================== REPORTS ====================

  async _generateMeetingReport(params) {
    const { meeting_id, format = 'markdown' } = params;

    const insights = await this._getMeetingInsights({ meeting_id });
    const meeting = this.completedMeetings.get(meeting_id);

    if (!meeting) {
      return { error: 'Meeting not found' };
    }

    const report = {
      meetingId: meeting_id,
      date: meeting.joinedAt,
      type: meeting.type,
      duration: meeting.leftAt ? this._calculateDuration(meeting.joinedAt, meeting.leftAt) : 'Unknown',
      ...insights.insights,
      generatedAt: new Date().toISOString()
    };

    if (format === 'markdown') {
      return {
        format: 'markdown',
        report: `# Meeting Report

**ID:** ${report.meetingId}
**Date:** ${report.date}
**Type:** ${report.type}
**Duration:** ${report.duration}

## Summary
${report.summary || 'No summary available'}

## Key Metrics
- Action Items: ${report.actionItems}
- Decisions Made: ${report.decisions}

## Participation
${Object.entries(report.participation || {}).map(([name, stats]) =>
  `- ${name}: ${stats.speakingPercentage}`
).join('\n')}

---
*Generated: ${report.generatedAt}*`
      };
    }

    return { format, report };
  }

  async _getWeeklyMeetingSummary(params = {}) {
    const { week_start } = params;

    const startDate = week_start ? new Date(week_start) : new Date();
    startDate.setDate(startDate.getDate() - startDate.getDay()); // Start of week
    const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const meetings = Array.from(this.completedMeetings.values())
      .filter(m => {
        const date = new Date(m.joinedAt);
        return date >= startDate && date < endDate;
      });

    let totalActions = 0;
    for (const meeting of meetings) {
      const actions = await this._getActionItems({ meeting_id: meeting.id });
      totalActions += actions.count || 0;
    }

    return {
      weekStart: startDate.toISOString().split('T')[0],
      weekEnd: endDate.toISOString().split('T')[0],
      totalMeetings: meetings.length,
      totalActionItems: totalActions,
      byType: meetings.reduce((acc, m) => {
        acc[m.type] = (acc[m.type] || 0) + 1;
        return acc;
      }, {}),
      meetings: meetings.map(m => ({
        id: m.id,
        type: m.type,
        date: m.joinedAt
      }))
    };
  }

  // ==================== HELPERS ====================

  _calculateDuration(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate - startDate;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) return `${diffMins} minutes`;
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m`;
  }

  async _generateWithLLM(prompt) {
    try {
      const response = await this.llmClient.chat.completions.create({
        model: this.config.model || 'gpt-4',
        messages: [{ role: 'user', content: prompt }]
      });
      return response.choices[0].message.content;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  }

  // ==================== LIVEKIT INTEGRATION ====================

  async _connectToLiveKit(_roomName) {
    // Placeholder for LiveKit connection
    // In production:
    // 1. Generate access token
    // 2. Connect to room
    // 3. Subscribe to audio tracks
    // 4. Start real-time transcription
    return null;
  }

  async _startTranscription(_room) {
    // Placeholder for transcription start
    // Would connect to speech-to-text service
    // and stream transcripts to transcript buffer
    return null;
  }

  // ==================== LIFECYCLE ====================

  async init() {
    await super.init();
    console.log('Meeting Intelligence Agent initialized');
  }

  setLiveKitClient(client) { this.liveKitClient = client; }
  setMicrosoftClient(client) { this.microsoftClient = client; }
  setOdooClient(client) { this.odooClient = client; }
  setSpeechClient(client) { this.speechClient = client; }
}

module.exports = {
  MeetingIntelligenceAgent,
  MeetingType,
  MeetingStatus,
  ActionPriority,
  EngagementLevel
};
