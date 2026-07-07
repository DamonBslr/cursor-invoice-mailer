import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { Mailer, MailMessage } from "./index.js";

export function createSmtpMailer(config: Config): Mailer {
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER && config.SMTP_PASS ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });

  return {
    async send(message: MailMessage): Promise<void> {
      await transporter.sendMail({
        to: message.to,
        from: message.from,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
    },
  };
}
