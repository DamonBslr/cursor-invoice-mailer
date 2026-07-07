import sgMail from "@sendgrid/mail";
import type { Config } from "../config.js";
import type { Mailer, MailMessage } from "./index.js";

export function createSendgridMailer(config: Config): Mailer {
  sgMail.setApiKey(config.SENDGRID_API_KEY as string);

  return {
    async send(message: MailMessage): Promise<void> {
      await sgMail.send({
        to: message.to,
        from: message.from,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content.toString("base64"),
          type: a.contentType,
          disposition: "attachment",
        })),
      });
    },
  };
}
