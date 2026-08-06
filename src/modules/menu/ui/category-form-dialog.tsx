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
import type { CategoryNode, CategoryRow } from '@/modules/menu/category.service'

const NO_PARENT = '__root__'

/** Flattens the tree into indented options so nesting is visible in a select. */
function flatten(
  nodes: CategoryNode[],
  excludeId?: string,
): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = []

  const walk = (list: CategoryNode[]) => {
    for (const node of list) {
      // A category cannot be its own parent, and its descendants cannot
      // either — the server rejects both, but offering them would be a
      // pointless round trip.
      if (node.id === excludeId) continue
      out.push({ id: node.id, label: node.name, depth: node.depth })
      walk(node.children)
    }
  }

  walk(nodes)
  return out
}

export function CategoryFormDialog({
  trigger,
  tree,
  category,
}: {
  trigger: React.ReactNode
  tree: CategoryNode[]
  category?: CategoryRow
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [parentId, setParentId] = useState(category?.parentId ?? NO_PARENT)

  const editing = Boolean(category?.id)
  const options = flatten(tree, category?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const form = new FormData(event.currentTarget)
    const body = {
      name: form.get('name'),
      description: form.get('description') || undefined,
      parentId: parentId === NO_PARENT ? null : parentId,
      displayOrder: Number(form.get('displayOrder') ?? 0),
    }

    try {
      if (editing) {
        await patchJson(`/api/menu/categories/${category!.id}`, body)
      } else {
        await postJson('/api/menu/categories', body)
      }

      toast.success(editing ? 'Category updated' : 'Category created')
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
              {editing ? 'Edit category' : 'New category'}
            </DialogTitle>
            <DialogDescription>
              Categories can be nested up to three levels deep.
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
                maxLength={120}
                defaultValue={category?.name}
                placeholder="Mains"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="parent">Parent category</Label>
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger id="parent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>Top level</SelectItem>
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {' '.repeat((option.depth - 1) * 3)}
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  name="description"
                  maxLength={500}
                  defaultValue={category?.description ?? ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="displayOrder">Sort order</Label>
                <Input
                  id="displayOrder"
                  name="displayOrder"
                  type="number"
                  min={0}
                  defaultValue={category?.displayOrder ?? 0}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
