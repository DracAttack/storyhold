import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";
import { hashEmail } from "../lib/pii";

/**
 * Provider-agnostic outbound email.
 *
 * The actual delivery channel is chosen at runtime so a real provider can be
 * "plugged in" later without touching call sites. Two providers ship today:
 *
 *  - `smtp`    — sends via nodemailer over SMTP. Works with any SMTP host,
 *                including Microsoft 365 (`smtp.office365.com`), Gmail, SendGrid,
 *                Resend, etc. Activated when SMTP_HOST is set (or EMAIL_PROVIDER=smtp).
 *  - `mailbox` — no-config fallback. Renders the message to an .html file on disk
 *                (ADMIN_MAILBOX-style) and logs it, so welcome emails are visible
 *                in development before any provider credentials exist.
 *
 * To wire up a different transport (e.g. a provider's HTTP API), add a branch in
 * `selectProvider()` returning an object that satisfies `EmailProvider`.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Optional raw message headers (e.g. RFC 8058 one-click unsubscribe:
   * `List-Unsubscribe` + `List-Unsubscribe-Post`). Passed through to the SMTP
   * transport; ignored by the dev mailbox provider.
   */
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  provider: string;
  delivered: boolean;
  id?: string;
  skipped?: string;
}

interface EmailProvider {
  name: string;
  send(msg: EmailMessage): Promise<{ id?: string }>;
}

const OUTBOX_DIR = process.env["EMAIL_OUTBOX_DIR"] ?? path.resolve(process.cwd(), "data/subscriber-mailbox");

function fromAddress(): string {
  const addr = process.env["EMAIL_FROM"] ?? process.env["SMTP_USER"] ?? "no-reply@brainhook.local";
  const name = process.env["EMAIL_FROM_NAME"] ?? "BrainHook";
  return addr.includes("<") ? addr : `${name} <${addr}>`;
}

function replyToAddress(): string {
  return process.env["EMAIL_REPLY_TO"] ?? "editor@brainhook.net";
}

function smtpConfigured(): boolean {
  return Boolean(process.env["SMTP_HOST"]);
}

/**
 * Sends over SMTP via nodemailer. nodemailer is loaded dynamically (and is kept
 * external by esbuild) so the bundle never hard-depends on it — the provider is
 * only constructed when SMTP is actually configured.
 */
function smtpProvider(): EmailProvider {
  return {
    name: "smtp",
    async send(msg) {
      const nodemailer = await import("nodemailer");
      const port = Number(process.env["SMTP_PORT"] ?? "587");
      // Port 465 implies implicit TLS; 587 uses STARTTLS. Allow an explicit override.
      const secure = process.env["SMTP_SECURE"]
        ? process.env["SMTP_SECURE"] === "true"
        : port === 465;
      const user = process.env["SMTP_USER"];
      const pass = process.env["SMTP_PASS"];
      const transport = nodemailer.createTransport({
        host: process.env["SMTP_HOST"],
        port,
        secure,
        ...(user && pass ? { auth: { user, pass } } : {}),
      });
      const info = await transport.sendMail({
        from: fromAddress(),
        // Sends go out from the newsletter address; replies must land in the
        // one real, monitored inbox.
        replyTo: replyToAddress(),
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(msg.headers ? { headers: msg.headers } : {}),
      });
      return { id: info.messageId };
    },
  };
}

/**
 * Fallback that persists the rendered email to disk and logs it. Lets the rest
 * of the system behave identically (welcome emails are "sent") with zero config.
 */
function mailboxProvider(): EmailProvider {
  return {
    name: "mailbox",
    async send(msg) {
      await fs.mkdir(OUTBOX_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeTo = msg.to.replace(/[^a-zA-Z0-9@._-]/g, "_");
      const file = path.join(OUTBOX_DIR, `${stamp}-${safeTo}.html`);
      await fs.writeFile(file, msg.html, "utf8");
      logger.info({ to: msg.to, subject: msg.subject, file }, "Email written to local outbox (no SMTP configured)");
      return { id: file };
    },
  };
}

function selectProvider(): EmailProvider {
  const explicit = (process.env["EMAIL_PROVIDER"] ?? "").toLowerCase();
  if (explicit === "smtp") return smtpProvider();
  if (explicit === "mailbox") return mailboxProvider();
  return smtpConfigured() ? smtpProvider() : mailboxProvider();
}

/**
 * Send a single email through the configured provider. Never throws — failures
 * are logged and reported via the result so callers (e.g. the signup handler)
 * are never broken by a delivery error.
 */
export async function sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
  const provider = selectProvider();
  try {
    const { id } = await provider.send(msg);
    return { provider: provider.name, delivered: true, ...(id ? { id } : {}) };
  } catch (err) {
    logger.error({ err, toHash: hashEmail(msg.to), provider: provider.name }, "Failed to send email");
    return { provider: provider.name, delivered: false, skipped: "send_failed" };
  }
}
