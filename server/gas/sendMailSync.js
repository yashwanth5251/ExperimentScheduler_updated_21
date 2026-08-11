'use strict';

const fs = require('fs');
const nodemailer = require('nodemailer');

async function main() {
  const file = process.argv[2];
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const transporter = nodemailer.createTransport({
    host: payload.smtp.host,
    port: payload.smtp.port,
    secure: payload.smtp.secure,
    auth: { user: payload.smtp.user, pass: payload.smtp.pass }
  });
  await transporter.sendMail(payload.mail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
