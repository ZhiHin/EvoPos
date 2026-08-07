import { env, isProduction } from './env'

/**
 * Outbound email.
 *
 * Phase 0 defined this port and shipped only the console transport, saying
 * plainly that picking a provider was a Phase 14 decision. This is that
 * decision: SMTP, configured by a single URL.
 *
 * SMTP rather than one provider's HTTP API, because every provider speaks it —
 * Resend, Postmark, SES, Mailgun, a customer's own Exchange server. Choosing
 * one vendor's REST shape would have meant this restaurant's mail depends on
 * which SaaS company we happened to like, and a migration to change it.
 */

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>
}

/**
 * Development transport. Prints the message, including any action link, so
 * password reset can be exercised end to end locally without a mail provider.
 */
export class ConsoleEmailTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<void> {
    console.info(
      [
        '',
        '─── email (console transport) ───────────────────────────────',
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '─────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    )
  }
}

/**
 * Refuses to silently drop mail in production.
 *
 * A no-op transport in production would mean password reset links are
 * generated, recorded as sent, and never delivered -- users locked out with
 * nothing in the logs to explain it. Failing loudly at the send site is the
 * lesser harm.
 */
export class UnconfiguredEmailTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<void> {
    throw new Error(
      `No email provider is configured, so "${message.subject}" could not be delivered to ${message.to}. Configure a transport before running in production.`,
    )
  }
}

/**
 * SMTP, via a connection URL.
 *
 * `SMTP_URL=smtps://user:pass@smtp.provider.com:465`. One value rather than
 * five, so a deployment cannot end up half-configured — a host with no
 * credentials, or credentials pointing at no host, are both states somebody
 * would otherwise reach and only discover on the first password reset.
 *
 * The client is built once and reused. Nodemailer pools connections, and
 * opening a TLS handshake per message would make a burst of invitations far
 * slower than it needs to be.
 */
export class SmtpEmailTransport implements EmailTransport {
  private client: import('nodemailer').Transporter | null = null

  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}

  private async connect(): Promise<import('nodemailer').Transporter> {
    if (this.client) return this.client

    /**
     * Imported lazily so a deployment with no SMTP configured never loads it.
     * The default path stays free of the dependency.
     */
    const nodemailer = await import('nodemailer')

    /**
     * The connection-URL form with pooling is documented and supported at
     * runtime; the published types describe only the options-object overload.
     * The cast asserts what the library actually accepts rather than
     * restructuring the configuration to suit a type definition.
     */
    const createTransport = nodemailer.createTransport as unknown as (
      url: string,
      defaults: { pool: boolean },
    ) => import('nodemailer').Transporter

    this.client = createTransport(this.url, { pool: true })

    return this.client
  }

  async send(message: EmailMessage): Promise<void> {
    const client = await this.connect()

    await client.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
  }
}

/**
 * Picks a transport from the configuration.
 *
 * The order matters. SMTP wins wherever it is configured — including in
 * development, so a real send can be exercised against a local catcher. With
 * no SMTP, production still refuses rather than dropping mail silently, which
 * is the Phase 0 behaviour and is still the right one.
 */
function defaultTransport(): EmailTransport {
  if (env.SMTP_URL && env.SMTP_FROM) {
    return new SmtpEmailTransport(env.SMTP_URL, env.SMTP_FROM)
  }

  return isProduction
    ? new UnconfiguredEmailTransport()
    : new ConsoleEmailTransport()
}

let transport: EmailTransport = defaultTransport()

/** Injection point for tests and for wiring an alternative provider. */
export function setEmailTransport(next: EmailTransport): void {
  transport = next
}

export function getEmailTransport(): EmailTransport {
  return transport
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await transport.send(message)
}
