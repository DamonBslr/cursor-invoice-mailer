import { Resend } from "resend";
import type { Config } from "../config.js";
import type { Mailer, MailMessage } from "./index.js";

export function createResendMailer(config: Config): Mailer {
  const client = new Resend(config.RESEND_API_KEY);

  return {
    async send(message: MailMessage): Promise<void> {
      const { error } = await client.emails.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
        })),
      });

      if (error) {
        throw new Error(`Resend send failed: ${error.message}`);
      }
    },
  };
}
