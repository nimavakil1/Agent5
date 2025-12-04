/**
 * Microsoft Graph API MCP Integration
 *
 * Provides MCP server configuration and direct API client for Microsoft 365.
 * Supports: Outlook (Mail, Calendar), SharePoint, OneDrive, Teams, Users
 *
 * API Documentation: https://learn.microsoft.com/en-us/graph/overview
 *
 * @module MicrosoftMCP
 */

const https = require('https');

/**
 * Microsoft Graph MCP Server Configuration
 * For use with MCP-compatible Microsoft server (when available)
 */
function getMicrosoftMCPConfig() {
  return {
    name: 'microsoft',
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-microsoft-graph'],
    env: {
      MS_TENANT_ID: process.env.MS_TENANT_ID,
      MS_CLIENT_ID: process.env.MS_CLIENT_ID,
      MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET,
      MS_USER_ID: process.env.MS_USER_ID // Optional: default user for operations
    }
  };
}

/**
 * Microsoft Graph API Endpoints
 */
const MS_ENDPOINTS = {
  auth: 'login.microsoftonline.com',
  graph: 'graph.microsoft.com'
};

/**
 * Common Microsoft Graph Scopes
 */
const SCOPES = {
  // Mail
  MAIL_READ: 'Mail.Read',
  MAIL_READWRITE: 'Mail.ReadWrite',
  MAIL_SEND: 'Mail.Send',

  // Calendar
  CALENDARS_READ: 'Calendars.Read',
  CALENDARS_READWRITE: 'Calendars.ReadWrite',

  // Files (OneDrive/SharePoint)
  FILES_READ: 'Files.Read.All',
  FILES_READWRITE: 'Files.ReadWrite.All',
  SITES_READ: 'Sites.Read.All',
  SITES_READWRITE: 'Sites.ReadWrite.All',

  // Teams
  TEAM_READ: 'Team.ReadBasic.All',
  CHANNEL_MESSAGE_SEND: 'ChannelMessage.Send',

  // Users
  USER_READ: 'User.Read.All',
  DIRECTORY_READ: 'Directory.Read.All'
};

/**
 * Direct Microsoft Graph API Client
 * Uses client credentials flow (application permissions)
 */
class MicrosoftDirectClient {
  constructor(config = {}) {
    this.tenantId = config.tenantId || process.env.MS_TENANT_ID;
    this.clientId = config.clientId || process.env.MS_CLIENT_ID;
    this.clientSecret = config.clientSecret || process.env.MS_CLIENT_SECRET;
    this.defaultUserId = config.userId || process.env.MS_USER_ID;

    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Get access token using client credentials flow
   */
  async authenticate() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'https://graph.microsoft.com/.default'
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: MS_ENDPOINTS.auth,
        port: 443,
        path: `/${this.tenantId}/oauth2/v2.0/token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params.toString())
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.access_token) {
              this.accessToken = response.access_token;
              this.tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
              resolve(this.accessToken);
            } else {
              reject(new Error(`MS Auth failed: ${data}`));
            }
          } catch (e) {
            reject(new Error(`MS Auth parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(params.toString());
      req.end();
    });
  }

  /**
   * Make authenticated Graph API request
   */
  async _request(method, path, body = null) {
    await this.authenticate();

    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    const payload = body ? JSON.stringify(body) : '';

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: MS_ENDPOINTS.graph,
        port: 443,
        path: `/v1.0${path}`,
        method: method,
        headers: headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (!data || data.trim() === '') {
              resolve({ success: true, statusCode: res.statusCode });
              return;
            }

            const response = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else {
              reject(new Error(`Graph API Error ${res.statusCode}: ${JSON.stringify(response)}`));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ raw: data, statusCode: res.statusCode });
            } else {
              reject(new Error(`Graph Parse error: ${e.message}, Data: ${data}`));
            }
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ==================== MAIL (OUTLOOK) API ====================

  /**
   * Get user's messages
   */
  async getMessages(userId = null, params = {}) {
    const user = userId || this.defaultUserId;
    const queryParams = new URLSearchParams({
      $top: params.top || 25,
      $orderby: params.orderBy || 'receivedDateTime desc',
      ...(params.filter && { $filter: params.filter }),
      ...(params.search && { $search: `"${params.search}"` }),
      ...(params.select && { $select: params.select.join(',') })
    });

    return this._request('GET', `/users/${user}/messages?${queryParams}`);
  }

  /**
   * Get single message
   */
  async getMessage(messageId, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('GET', `/users/${user}/messages/${messageId}`);
  }

  /**
   * Send email
   */
  async sendMail(message, userId = null, saveToSentItems = true) {
    const user = userId || this.defaultUserId;
    return this._request('POST', `/users/${user}/sendMail`, {
      message: {
        subject: message.subject,
        body: {
          contentType: message.contentType || 'HTML',
          content: message.body
        },
        toRecipients: message.to.map(email => ({
          emailAddress: { address: email }
        })),
        ...(message.cc && {
          ccRecipients: message.cc.map(email => ({
            emailAddress: { address: email }
          }))
        }),
        ...(message.bcc && {
          bccRecipients: message.bcc.map(email => ({
            emailAddress: { address: email }
          }))
        }),
        ...(message.importance && { importance: message.importance }),
        ...(message.attachments && {
          attachments: message.attachments.map(att => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.name,
            contentType: att.contentType,
            contentBytes: att.content // Base64 encoded
          }))
        })
      },
      saveToSentItems: saveToSentItems
    });
  }

  /**
   * Reply to email
   */
  async replyToMail(messageId, comment, replyAll = false, userId = null) {
    const user = userId || this.defaultUserId;
    const action = replyAll ? 'replyAll' : 'reply';
    return this._request('POST', `/users/${user}/messages/${messageId}/${action}`, {
      comment: comment
    });
  }

  /**
   * Forward email
   */
  async forwardMail(messageId, toRecipients, comment = '', userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('POST', `/users/${user}/messages/${messageId}/forward`, {
      comment: comment,
      toRecipients: toRecipients.map(email => ({
        emailAddress: { address: email }
      }))
    });
  }

  /**
   * Get mail folders
   */
  async getMailFolders(userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('GET', `/users/${user}/mailFolders`);
  }

  /**
   * Move message to folder
   */
  async moveMessage(messageId, destinationFolderId, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('POST', `/users/${user}/messages/${messageId}/move`, {
      destinationId: destinationFolderId
    });
  }

  // ==================== CALENDAR API ====================

  /**
   * Get calendar events
   */
  async getEvents(userId = null, params = {}) {
    const user = userId || this.defaultUserId;
    const queryParams = new URLSearchParams({
      $top: params.top || 25,
      $orderby: params.orderBy || 'start/dateTime',
      ...(params.filter && { $filter: params.filter }),
      ...(params.select && { $select: params.select.join(',') })
    });

    return this._request('GET', `/users/${user}/events?${queryParams}`);
  }

  /**
   * Get events in date range (calendar view)
   */
  async getCalendarView(startDateTime, endDateTime, userId = null) {
    const user = userId || this.defaultUserId;
    const queryParams = new URLSearchParams({
      startDateTime: startDateTime,
      endDateTime: endDateTime
    });

    return this._request('GET', `/users/${user}/calendarView?${queryParams}`);
  }

  /**
   * Create calendar event
   */
  async createEvent(event, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('POST', `/users/${user}/events`, {
      subject: event.subject,
      body: {
        contentType: event.bodyType || 'HTML',
        content: event.body || ''
      },
      start: {
        dateTime: event.start,
        timeZone: event.timeZone || 'UTC'
      },
      end: {
        dateTime: event.end,
        timeZone: event.timeZone || 'UTC'
      },
      location: event.location ? { displayName: event.location } : undefined,
      attendees: event.attendees ? event.attendees.map(email => ({
        emailAddress: { address: email },
        type: 'required'
      })) : [],
      ...(event.isOnlineMeeting && {
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness'
      }),
      ...(event.recurrence && { recurrence: event.recurrence }),
      ...(event.reminder && { reminderMinutesBeforeStart: event.reminder })
    });
  }

  /**
   * Update calendar event
   */
  async updateEvent(eventId, updates, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('PATCH', `/users/${user}/events/${eventId}`, updates);
  }

  /**
   * Delete calendar event
   */
  async deleteEvent(eventId, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('DELETE', `/users/${user}/events/${eventId}`);
  }

  /**
   * Get free/busy schedule
   */
  async getSchedule(schedules, startTime, endTime, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('POST', `/users/${user}/calendar/getSchedule`, {
      schedules: schedules, // Array of email addresses
      startTime: { dateTime: startTime, timeZone: 'UTC' },
      endTime: { dateTime: endTime, timeZone: 'UTC' },
      availabilityViewInterval: 30 // minutes
    });
  }

  // ==================== ONEDRIVE API ====================

  /**
   * Get drive items (root folder)
   */
  async getDriveItems(userId = null, params = {}) {
    const user = userId || this.defaultUserId;
    const queryParams = new URLSearchParams({
      $top: params.top || 100,
      ...(params.select && { $select: params.select.join(',') })
    });

    return this._request('GET', `/users/${user}/drive/root/children?${queryParams}`);
  }

  /**
   * Get drive item by path
   */
  async getDriveItemByPath(path, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('GET', `/users/${user}/drive/root:/${encodeURIComponent(path)}`);
  }

  /**
   * Get drive item by ID
   */
  async getDriveItem(itemId, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('GET', `/users/${user}/drive/items/${itemId}`);
  }

  /**
   * Search drive items
   */
  async searchDrive(query, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('GET', `/users/${user}/drive/root/search(q='${encodeURIComponent(query)}')`);
  }

  /**
   * Create folder
   */
  async createFolder(name, parentPath = '', userId = null) {
    const user = userId || this.defaultUserId;
    const path = parentPath ? `/users/${user}/drive/root:/${encodeURIComponent(parentPath)}:/children` : `/users/${user}/drive/root/children`;

    return this._request('POST', path, {
      name: name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename'
    });
  }

  /**
   * Upload small file (< 4MB)
   */
  async uploadFile(fileName, content, parentPath = '', userId = null) {
    const user = userId || this.defaultUserId;
    const path = parentPath
      ? `/users/${user}/drive/root:/${encodeURIComponent(parentPath)}/${encodeURIComponent(fileName)}:/content`
      : `/users/${user}/drive/root:/${encodeURIComponent(fileName)}:/content`;

    return this._request('PUT', path, content);
  }

  /**
   * Delete drive item
   */
  async deleteDriveItem(itemId, userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('DELETE', `/users/${user}/drive/items/${itemId}`);
  }

  /**
   * Share drive item
   */
  async shareDriveItem(itemId, type = 'view', scope = 'anonymous', userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('POST', `/users/${user}/drive/items/${itemId}/createLink`, {
      type: type, // 'view', 'edit', 'embed'
      scope: scope // 'anonymous', 'organization'
    });
  }

  // ==================== SHAREPOINT API ====================

  /**
   * Get SharePoint sites
   */
  async getSites(params = {}) {
    const queryParams = new URLSearchParams({
      $top: params.top || 100,
      ...(params.search && { $search: params.search })
    });

    return this._request('GET', `/sites?${queryParams}`);
  }

  /**
   * Get site by URL path
   */
  async getSiteByPath(hostname, sitePath) {
    return this._request('GET', `/sites/${hostname}:/${sitePath}`);
  }

  /**
   * Get site lists
   */
  async getSiteLists(siteId) {
    return this._request('GET', `/sites/${siteId}/lists`);
  }

  /**
   * Get list items
   */
  async getListItems(siteId, listId, params = {}) {
    const queryParams = new URLSearchParams({
      $top: params.top || 100,
      ...(params.filter && { $filter: params.filter }),
      ...(params.expand && { $expand: params.expand })
    });

    return this._request('GET', `/sites/${siteId}/lists/${listId}/items?${queryParams}`);
  }

  /**
   * Create list item
   */
  async createListItem(siteId, listId, fields) {
    return this._request('POST', `/sites/${siteId}/lists/${listId}/items`, {
      fields: fields
    });
  }

  /**
   * Update list item
   */
  async updateListItem(siteId, listId, itemId, fields) {
    return this._request('PATCH', `/sites/${siteId}/lists/${listId}/items/${itemId}/fields`, fields);
  }

  // ==================== TEAMS API ====================

  /**
   * Get user's teams
   */
  async getTeams(userId = null) {
    const user = userId || this.defaultUserId;
    return this._request('GET', `/users/${user}/joinedTeams`);
  }

  /**
   * Get team channels
   */
  async getChannels(teamId) {
    return this._request('GET', `/teams/${teamId}/channels`);
  }

  /**
   * Get channel messages
   */
  async getChannelMessages(teamId, channelId, params = {}) {
    const queryParams = new URLSearchParams({
      $top: params.top || 50
    });

    return this._request('GET', `/teams/${teamId}/channels/${channelId}/messages?${queryParams}`);
  }

  /**
   * Send channel message
   */
  async sendChannelMessage(teamId, channelId, content, contentType = 'html') {
    return this._request('POST', `/teams/${teamId}/channels/${channelId}/messages`, {
      body: {
        contentType: contentType,
        content: content
      }
    });
  }

  /**
   * Reply to channel message
   */
  async replyToChannelMessage(teamId, channelId, messageId, content, contentType = 'html') {
    return this._request('POST', `/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`, {
      body: {
        contentType: contentType,
        content: content
      }
    });
  }

  /**
   * Get chat messages (1:1 or group chat)
   */
  async getChatMessages(chatId, params = {}) {
    const queryParams = new URLSearchParams({
      $top: params.top || 50
    });

    return this._request('GET', `/chats/${chatId}/messages?${queryParams}`);
  }

  /**
   * Send chat message
   */
  async sendChatMessage(chatId, content, contentType = 'html') {
    return this._request('POST', `/chats/${chatId}/messages`, {
      body: {
        contentType: contentType,
        content: content
      }
    });
  }

  // ==================== USERS API ====================

  /**
   * Get users
   */
  async getUsers(params = {}) {
    const queryParams = new URLSearchParams({
      $top: params.top || 100,
      ...(params.filter && { $filter: params.filter }),
      ...(params.search && { $search: `"displayName:${params.search}"` }),
      ...(params.select && { $select: params.select.join(',') })
    });

    return this._request('GET', `/users?${queryParams}`);
  }

  /**
   * Get user by ID or UPN
   */
  async getUser(userId) {
    return this._request('GET', `/users/${userId}`);
  }

  /**
   * Get user's manager
   */
  async getUserManager(userId) {
    return this._request('GET', `/users/${userId}/manager`);
  }

  /**
   * Get user's direct reports
   */
  async getDirectReports(userId) {
    return this._request('GET', `/users/${userId}/directReports`);
  }

  /**
   * Get user's presence (online status)
   */
  async getUserPresence(userId) {
    return this._request('GET', `/users/${userId}/presence`);
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get inbox summary
   */
  async getInboxSummary(userId = null) {
    const user = userId || this.defaultUserId;

    const [_unread, flagged, folders] = await Promise.all([
      this.getMessages(user, { filter: 'isRead eq false', top: 1 }),
      this.getMessages(user, { filter: 'flag/flagStatus eq \'flagged\'', top: 1 }),
      this.getMailFolders(user)
    ]);

    const inbox = folders.value?.find(f => f.displayName === 'Inbox');

    return {
      unreadCount: inbox?.unreadItemCount || 0,
      totalCount: inbox?.totalItemCount || 0,
      flaggedCount: flagged['@odata.count'] || 0,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get upcoming events
   */
  async getUpcomingEvents(days = 7, userId = null) {
    const startDateTime = new Date().toISOString();
    const endDateTime = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const events = await this.getCalendarView(startDateTime, endDateTime, userId);

    return {
      period: `Next ${days} days`,
      eventCount: events.value?.length || 0,
      events: (events.value || []).map(e => ({
        subject: e.subject,
        start: e.start?.dateTime,
        end: e.end?.dateTime,
        location: e.location?.displayName,
        isOnline: e.isOnlineMeeting
      }))
    };
  }

  /**
   * Get today's schedule
   */
  async getTodaySchedule(userId = null) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return this.getCalendarView(today.toISOString(), tomorrow.toISOString(), userId);
  }

  /**
   * Quick compose and send email
   */
  async quickEmail(to, subject, body, userId = null) {
    return this.sendMail({
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      body: body
    }, userId);
  }
}

module.exports = {
  getMicrosoftMCPConfig,
  MicrosoftDirectClient,
  SCOPES,
  MS_ENDPOINTS
};
