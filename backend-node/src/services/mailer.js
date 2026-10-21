const nodemailer = require('nodemailer');
const { smtp } = require('../config/env');

const transport = smtp.host
  ? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    })
  : null;

exports.isConfigured = Boolean(transport);

// Sends an email, or prints it to the console when SMTP isn't configured (local dev)
exports.sendMail = async ({ to, subject, text, html }) => {
  if (!transport) {
    console.log(`\n[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n[mail:dev] ${text}\n`);
    return { delivered: false };
  }
  await transport.sendMail({ from: smtp.from, to, subject, text, html });
  return { delivered: true };
};
