
const SibApiV3Sdk = require('@sendinblue/client');

async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch; // Node 18+ global
  const mod = await import('node-fetch');
  return mod.default;
}

let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
let apiKey = apiInstance.authentications['apiKey'];
apiKey.apiKey = process.env.BREVO_API_KEY;

async function sendEmail(toEmail, subject, htmlContent, fromOverride) {
  try {
    let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    const defaultSender = {
      email: process.env.BREVO_SENDER_EMAIL || 'noreply@example.com',
      name: process.env.BREVO_SENDER_NAME || 'Agent5'
    };
    sendSmtpEmail.sender = fromOverride || defaultSender;
    sendSmtpEmail.to = [{ email: toEmail }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;

    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('Email sent successfully. Returned data: ' + JSON.stringify(data));
    return data;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

/**
 * Send a WhatsApp template message via Brevo WhatsApp API
 * Prerequisites:
 * - BREVO_API_KEY: REST API key from Brevo
 * - BREVO_WA_SENDER: Your WhatsApp sender number (as configured in Brevo)
 * - BREVO_WA_NAMESPACE: Template namespace (from Meta/Brevo)
 *
 * @param {string} recipientNumber - E.164 number, e.g. "+491701234567"
 * @param {string} templateName - Approved template name
 * @param {string} languageCode - Language code, e.g. "en"; defaults to "en"
 * @param {Array} components - Template components array for variables/media
 */
async function sendWhatsAppTemplate(recipientNumber, templateName, languageCode = 'en', components = []) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderNumber = process.env.BREVO_WA_SENDER;
  const namespace = process.env.BREVO_WA_NAMESPACE;
  if (!apiKey) throw new Error('Missing BREVO_API_KEY');
  if (!senderNumber) throw new Error('Missing BREVO_WA_SENDER');
  if (!namespace) throw new Error('Missing BREVO_WA_NAMESPACE');

  const url = 'https://api.brevo.com/v3/whatsapp/sendTemplate';
  const payload = {
    senderNumber,
    recipientNumber,
    template: {
      name: templateName,
      namespace,
      language: { policy: 'deterministic', code: languageCode },
      components
    }
  };

  const _fetch = await getFetch();
  const resp = await _fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'accept': 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Brevo WhatsApp error ${resp.status}: ${text}`);
  }
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

module.exports = {
  sendEmail,
  sendWhatsAppTemplate,
};
