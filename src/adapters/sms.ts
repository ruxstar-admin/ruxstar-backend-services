import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import { AppError } from "../platform/errors.js";

export interface SmsSender {
  /** `phone` is E.164. */
  sendOtp(phone: string, code: string): Promise<void>;
}

const masked = (phone: string) => `${phone.slice(0, 3)}******${phone.slice(-4)}`;

/** Prints the code to the terminal. Config refuses this provider in prod. */
class LogSms implements SmsSender {
  constructor(private readonly log: FastifyBaseLogger) {}

  async sendOtp(phone: string, code: string) {
    this.log.warn(`Development OTP for ${masked(phone)} is ${code}`);
  }
}

/** MSG91 Flow API with the DLT-approved template. The template variable is `OTP`, as in v1. */
class Msg91Sms implements SmsSender {
  constructor(
    private readonly settings: NonNullable<Config["otp"]["msg91"]>,
    private readonly log: FastifyBaseLogger,
  ) {}

  async sendOtp(phone: string, code: string) {
    let res: Response;
    try {
      res = await fetch("https://control.msg91.com/api/v5/flow/", {
        method: "POST",
        headers: { authkey: this.settings.authKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: this.settings.templateId,
          short_url: "0",
          ...(this.settings.senderId ? { sender: this.settings.senderId } : {}),
          recipients: [{ mobiles: phone.replace("+", ""), OTP: code }],
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      this.log.error({ err, to: masked(phone) }, "MSG91 request failed");
      throw new AppError("SMS_UNAVAILABLE");
    }
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || (body.type && body.type !== "success")) {
      this.log.error({ status: res.status, reply: body.message, to: masked(phone) }, "MSG91 refused the message");
      throw new AppError("SMS_UNAVAILABLE");
    }
  }
}

class UnavailableSms implements SmsSender {
  async sendOtp(): Promise<void> {
    throw new AppError("SMS_UNAVAILABLE");
  }
}

export function createSmsSender(config: Config, log: FastifyBaseLogger): SmsSender {
  if (config.otp.provider === "log") return new LogSms(log);
  if (config.otp.msg91) return new Msg91Sms(config.otp.msg91, log);
  log.warn("MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are not set. Codes cannot be sent.");
  return new UnavailableSms();
}
