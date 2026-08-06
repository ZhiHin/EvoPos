'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, deleteJson, postJson } from '@/lib/client/api'

interface Match {
  id: string
  name: string
  phone: string | null
  tierName: string | null
  pointsBalance: number
}

/**
 * Attaches a member to the bill.
 *
 * This is the control that makes loyalty accrue: points are awarded at
 * settlement to whoever is attached here, on what was actually paid.
 */
export function CustomerPanel({
  sessionId,
  attached,
  canManage,
}: {
  sessionId: string
  attached: { id: string; name: string; tierName: string | null; pointsBalance: number } | null
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [searching, setSearching] = useState(false)
  const [pending, setPending] = useState(false)

  async function search(value: string) {
    setQuery(value)
    if (value.trim().length < 2) {
      setMatches([])
      return
    }

    setSearching(true)
    try {
      const response = await fetch(
        `/api/customers/search?q=${encodeURIComponent(value)}`,
      )
      setMatches(response.ok ? await response.json() : [])
    } catch {
      setMatches([])
    } finally {
      setSearching(false)
    }
  }

  async function attach(customerId: string, name: string) {
    setPending(true)
    try {
      await postJson(`/api/pos/sessions/${sessionId}/customer`, { customerId })
      toast.success(`${name} added to the bill`)
      setOpen(false)
      setQuery('')
      setMatches([])
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not add that member.',
      )
    } finally {
      setPending(false)
    }
  }

  async function createAndAttach(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)

    const form = new FormData(event.currentTarget)

    try {
      const created = await postJson<{ id: string }>('/api/customers', {
        name: form.get('name'),
        phone: form.get('phone'),
      })
      await attach(created.id, String(form.get('name')))
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Could not sign that member up.',
      )
      setPending(false)
    }
  }

  async function detach() {
    setPending(true)
    try {
      await deleteJson(`/api/pos/sessions/${sessionId}/customer`)
      toast.success('Member removed from the bill')
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong.',
      )
    } finally {
      setPending(false)
    }
  }

  if (attached) {
    return (
      <div className="flex items-center justify-between gap-2 border-t pt-3 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{attached.name}</span>
          {attached.tierName && (
            <Badge variant="secondary" className="text-[10px]">
              {attached.tierName}
            </Badge>
          )}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {attached.pointsBalance} pts
          </span>
        </span>

        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={detach}
            disabled={pending}
          >
            Remove
          </Button>
        )}
      </div>
    )
  }

  if (!canManage) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 w-full"
        onClick={() => setOpen(true)}
      >
        Add member
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a member</DialogTitle>
            <DialogDescription>
              Points are awarded at settlement, on what is actually paid.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="member-search">Search by name or phone</Label>
              <Input
                id="member-search"
                value={query}
                onChange={(event) => search(event.target.value)}
                placeholder="At least two characters"
                autoFocus
              />
            </div>

            {matches.length > 0 && (
              <ul className="max-h-56 divide-y overflow-y-auto rounded-md border">
                {matches.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => attach(match.id, match.name)}
                      disabled={pending}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{match.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {match.phone ?? 'No phone'}
                          {match.tierName && ` · ${match.tierName}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {match.pointsBalance} pts
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {query.trim().length >= 2 &&
              matches.length === 0 &&
              !searching && (
                <form
                  onSubmit={createAndAttach}
                  className="space-y-3 rounded-md border border-dashed p-3"
                >
                  <p className="text-xs text-muted-foreground">
                    Nobody found. Sign them up now — the person is standing at
                    the counter, and asking them to come back is how a loyalty
                    scheme loses members.
                  </p>

                  <div className="space-y-2">
                    <Label htmlFor="new-name">Name</Label>
                    <Input
                      id="new-name"
                      name="name"
                      required
                      maxLength={120}
                      defaultValue={/^\+?\d/.test(query.trim()) ? '' : query}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="new-phone">Phone</Label>
                    <Input
                      id="new-phone"
                      name="phone"
                      required
                      maxLength={40}
                      defaultValue={/^\+?\d/.test(query.trim()) ? query : ''}
                    />
                  </div>

                  <Button
                    type="submit"
                    size="sm"
                    className="w-full"
                    disabled={pending}
                  >
                    {pending ? 'Signing up…' : 'Sign up and add'}
                  </Button>
                </form>
              )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
