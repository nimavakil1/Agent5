const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../../models/User');

const INVITE_EXPIRY_HOURS = 6;
const BASE_URL = process.env.BASE_URL || 'https://ai.acropaq.com';
const INVITE_SENDER_EMAIL = process.env.INVITE_SENDER_EMAIL || 'info@acropaq.com';

// MS Graph token cache
let msAccessToken = null;
let msTokenExpiry = null;

/**
 * Get MS Graph access token using client credentials flow
 */
async function getMsAccessToken() {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft 365 credentials not configured');
  }

  // Check if we have a valid cached token
  if (msAccessToken && msTokenExpiry && Date.now() < msTokenExpiry) {
    return msAccessToken;
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
    throw new Error(`Failed to get MS access token: ${error.error_description || error.error}`);
  }

  const data = await response.json();
  msAccessToken = data.access_token;
  msTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  return msAccessToken;
}

/**
 * Send email via Microsoft Graph API
 */
async function sendEmailViaMs365(toEmail, subject, htmlContent) {
  const token = await getMsAccessToken();

  const message = {
    message: {
      subject,
      body: {
        contentType: 'HTML',
        content: htmlContent
      },
      toRecipients: [
        { emailAddress: { address: toEmail } }
      ]
    },
    saveToSentItems: true
  };

  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${INVITE_SENDER_EMAIL}/sendMail`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(`Failed to send email: ${error.error?.message || response.statusText}`);
  }

  return { success: true };
}

/**
 * Generate a secure random token for invitation
 */
function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate password meets requirements: min 8 chars, includes letter and number
 */
function validatePassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, message: 'Password must include at least one letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must include at least one number' };
  }
  return { valid: true };
}

/**
 * Create an invitation for a new user
 * @param {string} email - User email
 * @param {string} roleId - Role ID (optional, uses default 'user' role if not provided)
 * @param {string} role - Legacy role string (if roleId not provided)
 * @returns {Object} - Created user with invite token
 */
async function createInvitation(email, roleId = null, role = 'user') {
  const lowerEmail = String(email).trim().toLowerCase();

  // Check if user already exists
  const existing = await User.findOne({ email: lowerEmail });
  if (existing) {
    if (existing.status === 'pending') {
      throw new Error('User already has a pending invitation');
    }
    throw new Error('User with this email already exists');
  }

  const inviteToken = generateInviteToken();
  const inviteTokenExpires = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  const userData = {
    email: lowerEmail,
    passwordHash: null,
    status: 'pending',
    inviteToken,
    inviteTokenExpires,
    active: true
  };

  if (roleId) {
    userData.roleId = roleId;
  } else {
    // Prevent creating superadmin via invitation
    userData.role = role === 'admin' ? 'admin' : (role === 'manager' ? 'manager' : 'user');
  }

  const user = await User.create(userData);
  return { user, inviteToken };
}

/**
 * Resend invitation to a pending user
 * @param {string} userId - User ID
 * @returns {Object} - Updated user with new invite token
 */
async function resendInvitation(userId) {
  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }
  if (user.status !== 'pending') {
    throw new Error('Can only resend invitation to pending users');
  }

  const inviteToken = generateInviteToken();
  const inviteTokenExpires = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

  user.inviteToken = inviteToken;
  user.inviteTokenExpires = inviteTokenExpires;
  await user.save();

  return { user, inviteToken };
}

/**
 * Send invitation email to user
 * @param {string} email - User email
 * @param {string} token - Invite token
 */
async function sendInvitationEmail(email, token) {
  const inviteUrl = `${BASE_URL}/test/app/accept-invite.html?token=${token}`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0f;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background-color: #12121a; border-radius: 16px; padding: 40px; border: 1px solid #1f1f2e;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #e4e4e7; font-size: 24px; font-weight: 600; margin: 0;">
          Welcome to ACROPAQ AI
        </h1>
      </div>

      <p style="color: #a1a1aa; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
        You've been invited to join the ACROPAQ AI platform. Click the button below to complete your registration and set up your account.
      </p>

      <div style="text-align: center; margin: 32px 0;">
        <a href="${inviteUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 600; font-size: 16px;">
          Accept Invitation
        </a>
      </div>

      <p style="color: #71717a; font-size: 14px; line-height: 1.6; margin: 24px 0 0;">
        This invitation will expire in <strong style="color: #a1a1aa;">${INVITE_EXPIRY_HOURS} hours</strong>. If you didn't expect this invitation, you can safely ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #1f1f2e; margin: 32px 0;">

      <p style="color: #52525b; font-size: 12px; margin: 0; text-align: center;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${inviteUrl}" style="color: #6366f1; word-break: break-all;">${inviteUrl}</a>
      </p>
    </div>

    <p style="color: #3f3f46; font-size: 12px; text-align: center; margin-top: 24px;">
      ACROPAQ AI Platform
    </p>
  </div>
</body>
</html>
  `.trim();

  await sendEmailViaMs365(email, 'You\'ve been invited to ACROPAQ AI', htmlContent);
}

/**
 * Validate an invite token
 * @param {string} token - Invite token
 * @returns {Object} - Validation result with user email if valid
 */
async function validateInviteToken(token) {
  if (!token) {
    return { valid: false, expired: false, message: 'No token provided' };
  }

  const user = await User.findOne({ inviteToken: token });
  if (!user) {
    return { valid: false, expired: false, message: 'Invalid invitation link' };
  }

  if (user.status !== 'pending') {
    return { valid: false, expired: false, message: 'Invitation already used' };
  }

  if (user.inviteTokenExpires < new Date()) {
    return { valid: false, expired: true, email: user.email, message: 'Invitation has expired' };
  }

  return { valid: true, expired: false, email: user.email };
}

/**
 * Complete user registration
 * @param {string} token - Invite token
 * @param {string} password - User's chosen password
 * @param {string} avatarUrl - URL to user's avatar (optional)
 * @param {string} firstName - User's first name (optional)
 * @param {string} lastName - User's last name (optional)
 * @returns {Object} - Updated user
 */
async function completeRegistration(token, password, avatarUrl = null, firstName = null, lastName = null) {
  // Validate token
  const validation = await validateInviteToken(token);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  // Validate password
  const pwValidation = validatePassword(password);
  if (!pwValidation.valid) {
    throw new Error(pwValidation.message);
  }

  const user = await User.findOne({ inviteToken: token });

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Update user
  user.passwordHash = passwordHash;
  user.status = 'active';
  user.inviteToken = null;
  user.inviteTokenExpires = null;
  if (avatarUrl) {
    user.avatar = avatarUrl;
  }
  if (firstName) {
    user.firstName = firstName;
  }
  if (lastName) {
    user.lastName = lastName;
  }

  await user.save();

  return user;
}

module.exports = {
  generateInviteToken,
  validatePassword,
  createInvitation,
  resendInvitation,
  sendInvitationEmail,
  validateInviteToken,
  completeRegistration,
  INVITE_EXPIRY_HOURS
};
