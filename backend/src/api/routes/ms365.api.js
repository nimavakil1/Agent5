/**
 * Microsoft 365 API Routes
 *
 * Direct API endpoints for Microsoft Graph integration.
 * Uses client credentials flow for application-level access.
 */

const express = require('express');
const router = express.Router();

// Microsoft Graph client
let graphClient = null;
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
 * Get users (internal members only, excludes guests)
 */
router.get('/users', async (req, res) => {
  try {
    const { limit = 999, includeGuests = 'false' } = req.query;

    // Filter to only show Member users (excludes Guest users)
    let filter = includeGuests === 'true'
      ? ''
      : "&$filter=userType eq 'Member'";

    const data = await graphRequest(`/users?$top=${limit}&$select=id,displayName,mail,jobTitle,department,userType,accountEnabled${filter}`);

    res.json({
      success: true,
      users: data.value.map(u => ({
        id: u.id,
        name: u.displayName,
        email: u.mail,
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
 * Get emails for a user
 */
router.get('/emails', async (req, res) => {
  try {
    const userId = req.query.userId || process.env.MS_USER_ID;
    const { limit = 10 } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId required or set MS_USER_ID in .env' });
    }

    const data = await graphRequest(`/users/${userId}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,isRead,bodyPreview`);

    res.json({
      success: true,
      emails: data.value.map(e => ({
        id: e.id,
        subject: e.subject,
        from: e.from?.emailAddress?.address,
        fromName: e.from?.emailAddress?.name,
        receivedAt: e.receivedDateTime,
        isRead: e.isRead,
        preview: e.bodyPreview?.slice(0, 200)
      }))
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
