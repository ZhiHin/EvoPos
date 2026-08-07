'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiClientError, deleteJson, postJson } from '@/lib/client/api'
import {
  WEBHOOK_EVENT_LABEL,
  WEBHOOK_EVENTS,
  type WebhookEvent,
} from '../webhook'

/**
 * The one moment a secret exists in the browser.
 *
 * Shown in a panel that says plainly it will not be shown again, because the
 * alternative — a customer assuming they can come back for it — ends with a
 * support request nobody can satisfy and an integration rebuilt from scratch.
 */
function SecretOnce({ label, value }: { label: string; value: string }) {
  return (
    <Alert>
      <AlertDescription className="space-y-2">
        <p className="font-medium">{label}</p>
        <code className="block break-all rounded bg-muted p-2 font-mono text-xs">
          {value}
        </code>
        <p className="text-xs">
          Copy it now. Only its hash is stored, so this is the only time it can
          be shown — if it is lost, the only route is a new one.
        </p>
      </AlertDescription>
    </Alert>
  )
}

export function CreateApiKeyDialog({
  availablePermissions,
}: {
  availablePermissions: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [token, setToken] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)

    try {
      const created = await postJson<{ token: string }>(
        '/api/integrations/keys',
        { name, permissions: [...selected] },
      )

      setToken(created.token)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  function close(next: boolean): void {
    setOpen(next)
    if (!next) {
      setToken(null)
      setName('')
      setSelected(new Set())
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm">New key</Button>
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] overflow-y-auto">
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
            </DialogHeader>
            <SecretOnce label="Your API key" value={token} />
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                A key acts on its own, not as a person — so it keeps working
                when someone leaves, and never inherits a permission they are
                granted later.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Stock feed"
                />
              </div>

              <div className="space-y-2">
                <Label>Permissions</Label>
                {/*
                  Grant only what the integration needs. A key with every
                  permission is a copy of the owner's account with no password
                  on it.
                */}
                <p className="text-xs text-muted-foreground">
                  Grant only what this integration needs. You can only choose
                  from permissions your own role holds.
                </p>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                  {availablePermissions.map((code) => (
                    <label
                      key={code}
                      className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-accent/50"
                    >
                      <span className="font-mono">{code}</span>
                      <Switch
                        checked={selected.has(code)}
                        onCheckedChange={(on) => {
                          const next = new Set(selected)
                          if (on) next.add(code)
                          else next.delete(code)
                          setSelected(next)
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={pending || !name.trim()}>
                {pending ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function RevokeKeyButton({ keyId }: { keyId: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function revoke(): Promise<void> {
    setPending(true)

    try {
      await deleteJson(`/api/integrations/keys/${keyId}`)
      toast.success('Key revoked')
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError ? cause.message : 'Could not revoke.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={revoke} disabled={pending}>
      Revoke
    </Button>
  )
}

export function CreateWebhookDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set())
  const [secret, setSecret] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)

    try {
      const created = await postJson<{ secret: string }>(
        '/api/integrations/webhooks',
        { url, events: [...events] },
      )

      setSecret(created.secret)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  function close(next: boolean): void {
    setOpen(next)
    if (!next) {
      setSecret(null)
      setUrl('')
      setEvents(new Set())
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size="sm">New endpoint</Button>
      </DialogTrigger>

      <DialogContent>
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle>Endpoint created</DialogTitle>
              <DialogDescription>
                Every delivery is signed with this. Verify it before trusting
                the body — the URL is the only thing standing between your
                endpoint and anyone who guesses it.
              </DialogDescription>
            </DialogHeader>
            <SecretOnce label="Signing secret" value={secret} />
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>New webhook endpoint</DialogTitle>
              <DialogDescription>
                Must be a public https URL. Loopback and private addresses are
                refused, because this server would be the one making the
                request.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="hook-url">URL</Label>
                <Input
                  id="hook-url"
                  type="url"
                  required
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://hooks.example.com/ros"
                />
              </div>

              <div className="space-y-2">
                <Label>Events</Label>
                <div className="space-y-1 rounded-md border p-2">
                  {WEBHOOK_EVENTS.map((eventType) => (
                    <label
                      key={eventType}
                      className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                    >
                      <span>
                        {WEBHOOK_EVENT_LABEL[eventType]}
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          {eventType}
                        </span>
                      </span>
                      <Switch
                        checked={events.has(eventType)}
                        onCheckedChange={(on) => {
                          const next = new Set(events)
                          if (on) next.add(eventType)
                          else next.delete(eventType)
                          setEvents(next)
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="submit"
                disabled={pending || !url.trim() || events.size === 0}
              >
                {pending ? 'Creating…' : 'Create endpoint'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function EndpointActions({
  endpointId,
  isActive,
}: {
  endpointId: string
  isActive: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function act(fn: () => Promise<unknown>, done: string): Promise<void> {
    setPending(true)

    try {
      await fn()
      toast.success(done)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError ? cause.message : 'Could not do that.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <span className="flex items-center gap-1">
      {!isActive && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            act(
              () => postJson(`/api/integrations/webhooks/${endpointId}`, {}),
              'Endpoint re-enabled',
            )
          }
        >
          Re-enable
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          act(
            () => deleteJson(`/api/integrations/webhooks/${endpointId}`),
            'Endpoint removed',
          )
        }
      >
        Remove
      </Button>
    </span>
  )
}

export { WEBHOOK_EVENT_LABEL, type WebhookEvent }

/** Shown beside a disabled endpoint, so the reason is never a mystery. */
export function DisabledBadge({ reason }: { reason: string | null }) {
  return (
    <Badge variant="outline" className="text-[10px] text-destructive">
      {reason ? 'disabled' : 'inactive'}
    </Badge>
  )
}
