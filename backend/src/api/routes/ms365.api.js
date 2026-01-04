/**
 * Microsoft 365 API Routes
 *
 * Direct API endpoints for Microsoft Graph integration.
 * Uses client credentials flow for application-level access.
 */

const express = require('express');
const router = express.Router();

// Microsoft Graph client
let _graphClient = null;
let accessToken = null;
let tokenExpiry = null;

/**
 * Get access token using client credentials flow
 */
async function getAccessToken() {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft 365 credentials not configured. Set MS_TENANT_ID, MS_CLIENT_ID, and MS_CLIENT_SECRET in .env');
  }

  // Check if we have a valid cached token
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to get access token: ${error.error_description || error.error}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Expire 1 minute early

  return accessToken;
}

/**
 * Make a request to Microsoft Graph API
 */
async function graphRequest(endpoint, method = 'GET', body = null) {
  const token = await getAccessToken();

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, options);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(error.error?.message || `Graph API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Clear token cache (force re-authentication)
 */
router.post('/clear-token', async (req, res) => {
  accessToken = null;
  tokenExpiry = null;
  res.json({ success: true, message: 'Token cache cleared' });
});

/**
 * Check connection status
 */
router.get('/status', async (req, res) => {
  try {
    const tenantId = process.env.MS_TENANT_ID;
    const clientId = process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
      return res.json({
        connected: false,
        configured: false,
        error: 'Environment variables not set'
      });
    }

    // Try to get a token to verify credentials
    await getAccessToken();

    res.json({
      connected: true,
      configured: true,
      tenantId: tenantId.slice(0, 8) + '...',
      clientId: clientId.slice(0, 8) + '...'
    });
  } catch (error) {
    res.json({
      connected: false,
      configured: true,
      error: error.message
    });
  }
});

/**
 * Get users (all users by default, can filter by type)
 * Handles pagination to get all users
 */
router.get('/users', async (req, res) => {
  try {
    const { filterType = 'all' } = req.query;

    // filterType: 'all' = everyone, 'members' = only Member type, 'guests' = only Guest type
    let filter = '';
    if (filterType === 'members') {
      filter = "&$filter=userType eq 'Member'";
    } else if (filterType === 'guests') {
      filter = "&$filter=userType eq 'Guest'";
    }

    // Collect all users with pagination
    let allUsers = [];
    let nextLink = `/users?$top=100&$select=id,displayName,mail,jobTitle,department,userType,accountEnabled,userPrincipalName${filter}`;

    while (nextLink) {
      const data = await graphRequest(nextLink);
      allUsers = allUsers.concat(data.value || []);

      // Check for next page
      if (data['@odata.nextLink']) {
        // Extract just the path from the full URL
        nextLink = data['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '');
      } else {
        nextLink = null;
      }

      // Safety limit to prevent infinite loops
      if (allUsers.length > 1000) break;
    }

    res.json({
      success: true,
      count: allUsers.length,
      users: allUsers.map(u => ({
        id: u.id,
        name: u.displayName,
        email: u.mail,
        userPrincipalName: u.userPrincipalName,
        jobTitle: u.jobTitle,
        department: u.department,
        userType: u.userType,
        accountEnabled: u.accountEnabled
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get emails for a specific user (inbox, sent, or all)
 */
router.get('/emails', async (req, res) => {
  try {
    const userId = req.query.userId || process.env.MS_USER_ID;
    const { limit = 50, folder = 'all' } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId required or set MS_USER_ID in .env' });
    }

    let endpoint;
    if (folder === 'inbox') {
      endpoint = `/users/${userId}/mailFolders/inbox/messages`;
    } else if (folder === 'sent') {
      endpoint = `/users/${userId}/mailFolders/sentItems/messages`;
    } else {
      // All messages
      endpoint = `/users/${userId}/messages`;
    }

    const data = await graphRequest(`${endpoint}?$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview,isDraft`);

    res.json({
      success: true,
      userId,
      folder,
      count: data.value.length,
      emails: data.value.map(e => ({
        id: e.id,
        subject: e.subject,
        from: e.from?.emailAddress?.address,
        fromName: e.from?.emailAddress?.name,
        to: e.toRecipients?.map(r => r.emailAddress?.address).join(', '),
        receivedAt: e.receivedDateTime,
        sentAt: e.sentDateTime,
        isRead: e.isRead,
        isDraft: e.isDraft,
        preview: e.bodyPreview?.slice(0, 200)
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get emails from ALL users in the organization
 * Returns recent emails across all mailboxes
 */
router.get('/emails/all', async (req, res) => {
  try {
    const { limit = 20, folder = 'all' } = req.query;

    // First get all users
    const usersData = await graphRequest('/users?$top=100&$select=id,displayName,mail,userType&$filter=userType eq \'Member\'');
    const users = usersData.value.filter(u => u.mail); // Only users with email

    const allEmails = [];

    // Fetch emails from each user
    for (const user of users) {
      try {
        let endpoint;
        if (folder === 'inbox') {
          endpoint = `/users/${user.id}/mailFolders/inbox/messages`;
        } else if (folder === 'sent') {
          endpoint = `/users/${user.id}/mailFolders/sentItems/messages`;
        } else {
          endpoint = `/users/${user.id}/messages`;
        }

        const emailData = await graphRequest(`${endpoint}?$top=${limit}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview`);

        for (const e of emailData.value || []) {
          allEmails.push({
            id: e.id,
            mailbox: user.mail,
            mailboxName: user.displayName,
            subject: e.subject,
            from: e.from?.emailAddress?.address,
            fromName: e.from?.emailAddress?.name,
            to: e.toRecipients?.map(r => r.emailAddress?.address).join(', '),
            receivedAt: e.receivedDateTime,
            sentAt: e.sentDateTime,
            isRead: e.isRead,
            preview: e.bodyPreview?.slice(0, 200)
          });
        }
      } catch (err) {
        // Skip users we can't access
        console.log(`Could not access emails for ${user.mail}: ${err.message}`);
      }
    }

    // Sort by date, most recent first
    allEmails.sort((a, b) => new Date(b.receivedAt || b.sentAt) - new Date(a.receivedAt || a.sentAt));

    res.json({
      success: true,
      folder,
      usersScanned: users.length,
      totalEmails: allEmails.length,
      emails: allEmails
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a specific email with full body
 */
router.get('/emails/:userId/:emailId', async (req, res) => {
  try {
    const { userId, emailId } = req.params;

    const email = await graphRequest(`/users/${userId}/messages/${emailId}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,isRead,importance,hasAttachments`);

    res.json({
      success: true,
      email: {
        id: email.id,
        subject: email.subject,
        from: email.from?.emailAddress?.address,
        fromName: email.from?.emailAddress?.name,
        to: email.toRecipients?.map(r => ({ email: r.emailAddress?.address, name: r.emailAddress?.name })),
        cc: email.ccRecipients?.map(r => ({ email: r.emailAddress?.address, name: r.emailAddress?.name })),
        receivedAt: email.receivedDateTime,
        sentAt: email.sentDateTime,
        body: email.body?.content,
        bodyType: email.body?.contentType,
        isRead: email.isRead,
        importance: email.importance,
        hasAttachments: email.hasAttachments
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get teams
 */
router.get('/teams', async (req, res) => {
  try {
    const data = await graphRequest('/groups?$filter=resourceProvisioningOptions/Any(x:x eq \'Team\')&$select=id,displayName,description');

    res.json({
      success: true,
      teams: data.value.map(t => ({
        id: t.id,
        name: t.displayName,
        description: t.description
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get calendar events for a user
 */
router.get('/calendar', async (req, res) => {
  try {
    const userId = req.query.userId || process.env.MS_USER_ID;
    const { days = 7 } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId required or set MS_USER_ID in .env' });
    }

    const startDate = new Date().toISOString();
    const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const data = await graphRequest(
      `/users/${userId}/calendarView?startDateTime=${startDate}&endDateTime=${endDate}&$select=id,subject,start,end,organizer,location,isOnlineMeeting&$top=20`
    );

    res.json({
      success: true,
      events: data.value.map(e => ({
        id: e.id,
        subject: e.subject,
        start: e.start?.dateTime,
        end: e.end?.dateTime,
        organizer: e.organizer?.emailAddress?.name,
        location: e.location?.displayName,
        isOnlineMeeting: e.isOnlineMeeting
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Send an email
 */
router.post('/send-email', async (req, res) => {
  try {
    const userId = req.body.userId || process.env.MS_USER_ID;
    const { to, subject, body, contentType = 'Text' } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId required or set MS_USER_ID in .env' });
    }

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }

    const message = {
      message: {
        subject,
        body: {
          contentType,
          content: body
        },
        toRecipients: [
          { emailAddress: { address: to } }
        ]
      }
    };

    await graphRequest(`/users/${userId}/sendMail`, 'POST', message);

    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get OneDrive files
 */
router.get('/files', async (req, res) => {
  try {
    const userId = req.query.userId || process.env.MS_USER_ID;
    const { path = 'root' } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId required or set MS_USER_ID in .env' });
    }

    const endpoint = path === 'root'
      ? `/users/${userId}/drive/root/children`
      : `/users/${userId}/drive/root:/${path}:/children`;

    const data = await graphRequest(`${endpoint}?$select=id,name,size,lastModifiedDateTime,folder,file,webUrl`);

    res.json({
      success: true,
      files: data.value.map(f => ({
        id: f.id,
        name: f.name,
        size: f.size,
        lastModified: f.lastModifiedDateTime,
        isFolder: !!f.folder,
        mimeType: f.file?.mimeType,
        webUrl: f.webUrl
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
