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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ApiClientError, patchJson, postJson } from '@/lib/client/api'

export interface TableFormValues {
  id?: string
  code: string
  name?: string | null
  capacity: number
  floorId?: string | null
}

/** Radix Select cannot hold an empty-string value, hence a sentinel. */
const NO_FLOOR = '__none__'

export function TableFormDialog({
  trigger,
  branchId,
  floors,
  table,
}: {
  trigger: React.ReactNode
  branchId: string
  floors: { id: string; name: string }[]
  table?: TableFormValues
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [floorId, setFloorId] = useState(table?.floorId ?? NO_FLOOR)

  const editing = Boolean(table?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const body = {
      code: form.get('code'),
      name: form.get('name') || undefined,
      capacity: Number(form.get('capacity')),
      floorId: floorId === NO_FLOOR ? null : floorId,
    }

    try {
      if (editing) {
        await patchJson(`/api/tables/${table!.id}`, body)
      } else {
        await postJson(`/api/branches/${branchId}/tables`, body)
      }

      toast.success(editing ? 'Table updated' : 'Table created')
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
            <DialogTitle>{editing ? 'Edit table' : 'New table'}</DialogTitle>
            <DialogDescription>
              A QR code is generated automatically when the table is created.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="code">Table code</Label>
                <Input
                  id="code"
                  name="code"
                  required
                  maxLength={10}
                  defaultValue={table?.code}
                  placeholder="T12"
                  className="font-mono uppercase"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="capacity">Seats</Label>
                <Input
                  id="capacity"
                  name="capacity"
                  type="number"
                  required
                  min={1}
                  max={40}
                  defaultValue={table?.capacity ?? 2}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                name="name"
                maxLength={80}
                defaultValue={table?.name ?? ''}
                placeholder="Window booth"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="floor">Floor</Label>
              <Select value={floorId} onValueChange={setFloorId}>
                <SelectTrigger id="floor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FLOOR}>Unassigned</SelectItem>
                  {floors.map((floor) => (
                    <SelectItem key={floor.id} value={floor.id}>
                      {floor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create table'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
