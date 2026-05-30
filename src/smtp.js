import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Envoie un email de notification aux joueurs configurés.
 * @param {Object} details Informations de la réservation (day, startHour, courtName, dateStr, account)
 * @param {boolean} isSuccess Indique si la réservation a réussi
 * @param {string|null} error Message d'erreur éventuel
 */
export async function sendBookingEmail(details, isSuccess, error = null) {
  const { day, startHour, courtName, dateStr, account } = details;
  
  // Validation des variables d'environnement
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;
  const notificationEmails = process.env.NOTIFICATION_EMAILS;

  if (!smtpHost || !smtpUser || !smtpPass || !notificationEmails) {
    console.error('[SMTP] [ERROR] Configuration SMTP manquante dans les variables d\'environnement.');
    return;
  }

  // Création du transporteur Nodemailer
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465, // True pour le port 465 SSL, False pour les autres ports TLS
    auth: {
      user: smtpUser,
      pass: smtpPass
    },
    tls: {
      rejectUnauthorized: false // Permet de tolérer certains certificats auto-signés
    }
  });

  const recipients = notificationEmails
    .split(/[\s,;]+/)
    .map(email => email.trim())
    .filter(email => email.length > 0);
  const subject = isSuccess 
    ? `🎾 SUCCÈS : Réservation Padel - ${day} ${dateStr} à ${startHour}h00`
    : `❌ ÉCHEC : Réservation Padel - ${day} ${dateStr} à ${startHour}h00`;

  // Construction du corps de l'email très bref
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${subject}</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.4; color: #333; max-width: 600px; margin: 20px auto; padding: 0 10px; text-align: left;">
      ${isSuccess 
        ? `<p>La réservation pour le créneau <strong>${day} ${dateStr} de ${startHour}h à ${startHour + 1}h</strong> (terrain <strong>${courtName}</strong>) a été initiée.</p>
           <p><strong>🚨 Action requise :</strong> Vous devez cliquer rapidement sur le lien de confirmation officiel reçu sur <strong>${account}</strong> pour valider définitivement.</p>`
        : `<p>La tentative de réservation pour le créneau <strong>${day} ${dateStr} de ${startHour}h à ${startHour + 1}h</strong> avec le compte <strong>${account}</strong> a échoué.</p>`
      }
      ${error ? `<p style="color: #c53030; background-color: #fde8e8; padding: 10px; border-radius: 4px; font-family: monospace;"><strong>Erreur :</strong> ${error}</p>` : ''}
      <br>
      <p style="font-size: 12px; color: #666; border-top: 1px solid #eee; padding-top: 10px; margin-top: 20px;">Cet e-mail a été envoyé automatiquement par le robot de réservation Padel. Ne pas répondre.</p>
    </body>
    </html>
  `;

  // Options du courrier
  const mailOptions = {
    from: smtpFrom,
    to: recipients.join(', '),
    subject: subject,
    html: htmlContent
  };

  try {
    console.log(`[SMTP] Envoi de l'e-mail de notification à : ${recipients.join(', ')}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] [SUCCESS] E-mail envoyé avec succès (ID: ${info.messageId}).`);
  } catch (err) {
    console.error('[SMTP] [ERROR] Échec de l\'envoi de l\'e-mail de notification :', err.message);
  }
}
