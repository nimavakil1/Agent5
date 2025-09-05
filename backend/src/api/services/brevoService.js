
const SibApiV3Sdk = require('@sendinblue/client');

let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
let apiKey = apiInstance.authentications['apiKey'];
apiKey.apiKey = process.env.BREVO_API_KEY;

async function sendEmail(toEmail, subject, htmlContent) {
  try {
    let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.sender = { email: 'noreply@yourdomain.com', name: 'AI Call Center' }; // TODO: Configure sender email
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

// TODO: Implement sendWhatsApp message if Brevo API supports it directly
// (Brevo primarily focuses on email and SMS, WhatsApp might require a different approach or partner integration)

module.exports = {
  sendEmail,
};
