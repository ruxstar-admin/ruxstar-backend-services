import type { FastifyBaseLogger } from "fastify";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";
import { OTP_TTL_SECONDS } from "../modules/account/otp.js";
import { AppError } from "../platform/errors.js";
import { codeEmail } from "./email-template.js";

export interface EmailSender {
  sendCode(to: string, code: string): Promise<void>;
}

const masked = (email: string) => {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

/** Prints the code to the terminal. Config refuses this provider in prod. */
class LogEmail implements EmailSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async sendCode(to: string, code: string) {
    this.log.warn(`Development email code for ${masked(to)} is ${code}`);
  }
}

class SmtpEmail implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    private readonly settings: NonNullable<Config["email"]["smtp"]>,
    private readonly log: FastifyBaseLogger,
  ) {
    this.transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      auth: { user: settings.user, pass: settings.pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10_000,
    });
  }

  async sendCode(to: string, code: string) {
    const { from } = this.settings;
    try {
      await this.transport.sendMail({
        from: from.includes("<") ? from : `Ruxstar <${from}>`,
        to,
        ...codeEmail(to, code, OTP_TTL_SECONDS / 60),
      });
    } catch (err) {
      this.log.error({ err: (err as Error).message, to: masked(to) }, "Email could not be sent");
      throw new AppError("EMAIL_UNAVAILABLE");
    }
  }
}

class UnavailableEmail implements EmailSender {
  async sendCode(): Promise<void> {
    throw new AppError("EMAIL_UNAVAILABLE");
  }
}

export function createEmailSender(config: Config, log: FastifyBaseLogger): EmailSender {
  if (config.email.provider === "log") return new LogEmail(log);
  if (config.email.smtp) return new SmtpEmail(config.email.smtp, log);
  log.warn("SMTP_HOST, SMTP_USER and SMTP_PASS are not set. Email codes cannot be sent.");
  return new UnavailableEmail();
}
