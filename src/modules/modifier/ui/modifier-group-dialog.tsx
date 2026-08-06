'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { ApiClientError, patchJson, postJson } from '@/lib/client/api'
import type { ModifierGroupRow } from '@/modules/modifier/modifier.service'

export function ModifierGroupDialog({
  trigger,
  group,
}: {
  trigger: React.ReactNode
  group?: ModifierGroupRow
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editing = Boolean(group?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const maxRaw = form.get('maxSelection')

    const body = {
      name: form.get('name'),
      description: form.get('description') || undefined,
      minSelection: Number(form.get('minSelection') ?? 0),
      // Blank means unlimited, which is null — not 0, which would mean
      // "choose nothing" and make every option unselectable.
      maxSelection: maxRaw === '' || maxRaw === null ? null : Number(maxRaw),
    }

    try {
      if (editing) {
        await patchJson(`/api/menu/modifier-groups/${group!.id}`, body)
      } else {
        await postJson('/api/menu/modifier-groups', body)
      }

      toast.success(editing ? 'Group updated' : 'Group created')
      setOpen(false)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Edit modifier group' : 'New modifier group'}
            </DialogTitle>
            <DialogDescription>
              A question asked about an item — “What size?”, “How much ice?”
              Groups are reusable across many items.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                required
                maxLength={80}
                defaultValue={group?.name}
                placeholder="Size"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                name="description"
                maxLength={300}
                defaultValue={group?.description ?? ''}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="minSelection">Minimum choices</Label>
                <Input
                  id="minSelection"
                  name="minSelection"
                  type="number"
                  min={0}
                  max={50}
                  defaultValue={group?.minSelection ?? 0}
                />
                <p className="text-xs text-muted-foreground">
                  1 or more makes this group required.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxSelection">Maximum choices</Label>
                <Input
                  id="maxSelection"
                  name="maxSelection"
                  type="number"
                  min={1}
                  max={50}
                  defaultValue={group?.maxSelection ?? ''}
                  placeholder="No limit"
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank for no limit.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
