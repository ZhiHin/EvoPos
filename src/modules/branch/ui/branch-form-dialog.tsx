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

export interface BranchFormValues {
  id?: string
  name: string
  code: string
  city?: string | null
  phone?: string | null
}

export function BranchFormDialog({
  trigger,
  branch,
}: {
  trigger: React.ReactNode
  branch?: BranchFormValues
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editing = Boolean(branch?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const body = {
      name: form.get('name'),
      code: form.get('code'),
      city: form.get('city') || undefined,
      phone: form.get('phone') || undefined,
    }

    try {
      if (editing) {
        await patchJson(`/api/branches/${branch!.id}`, body)
      } else {
        await postJson('/api/branches', body)
      }

      toast.success(editing ? 'Branch updated' : 'Branch created')
      setOpen(false)
      // Re-fetches the server component list rather than mutating local state,
      // so what is displayed is what the database actually holds.
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
            <DialogTitle>{editing ? 'Edit branch' : 'New branch'}</DialogTitle>
            <DialogDescription>
              The branch code appears on receipts and reports. Keep it short.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Branch name</Label>
              <Input
                id="name"
                name="name"
                required
                maxLength={120}
                defaultValue={branch?.name}
                placeholder="Bangsar"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                name="code"
                required
                maxLength={12}
                defaultValue={branch?.code}
                placeholder="BSR1"
                className="font-mono uppercase"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  name="city"
                  maxLength={120}
                  defaultValue={branch?.city ?? ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  name="phone"
                  maxLength={40}
                  defaultValue={branch?.phone ?? ''}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
