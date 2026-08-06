import { isProduction } from './env'

/**
 * Outbound email port.
 *
 * Phase 0 ships only the console transport -- no provider is configured yet,
 * and picking one is a Phase 14 (integrations) decision. Defining the port
 * now means the auth flows can be written, tested and reviewed against a real
 * interface instead of being restructured later when a provider arrives.
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

let transport: EmailTransport = isProduction
  ? new UnconfiguredEmailTransport()
  : new ConsoleEmailTransport()

/** Injection point for tests and for wiring a real provider in Phase 14. */
export function setEmailTransport(next: EmailTransport): void {
  transport = next
}

export function getEmailTransport(): EmailTransport {
  return transport
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await transport.send(message)
}
