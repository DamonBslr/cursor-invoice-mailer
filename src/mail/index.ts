import type { Config } from "../config.js";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string[];
  from: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Selects the configured mail provider implementation. */
export async function createMailer(config: Config): Promise<Mailer> {
  switch (config.MAIL_PROVIDER) {
    case "smtp": {
      const { createSmtpMailer } = await import("./smtp.js");
      return createSmtpMailer(config);
    }
    case "resend": {
      const { createResendMailer } = await import("./resend.js");
      return createResendMailer(config);
    }
    case "sendgrid": {
      const { createSendgridMailer } = await import("./sendgrid.js");
      return createSendgridMailer(config);
    }
    default: {
      const exhaustive: never = config.MAIL_PROVIDER;
      throw new Error(`Unsupported MAIL_PROVIDER: ${exhaustive}`);
    }
  }
}
