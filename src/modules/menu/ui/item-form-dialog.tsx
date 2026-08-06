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
import { minorToDecimalString } from '@/lib/money'
import type { AttributeDefinition } from '@/modules/menu/attribute.service'
import type { CategoryRow } from '@/modules/menu/category.service'
import type { MenuItemRow } from '@/modules/menu/item.service'
import type { TagRow } from '@/modules/menu/tag.service'
import { AttributeFields } from './attribute-fields'

const NO_CATEGORY = '__none__'

export function ItemFormDialog({
  trigger,
  categories,
  tags,
  attributeDefinitions,
  item,
  itemTagIds = [],
}: {
  trigger: React.ReactNode
  categories: CategoryRow[]
  tags: TagRow[]
  attributeDefinitions: AttributeDefinition[]
  item?: MenuItemRow
  itemTagIds?: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [categoryId, setCategoryId] = useState(item?.categoryId ?? NO_CATEGORY)
  const [selectedTags, setSelectedTags] = useState<string[]>(itemTagIds)
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    item?.attributes ?? {},
  )

  const editing = Boolean(item?.id)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setFieldErrors({})
    setPending(true)

    const form = new FormData(event.currentTarget)
    const body = {
      name: form.get('name'),
      description: form.get('description') || undefined,
      categoryId: categoryId === NO_CATEGORY ? null : categoryId,
      // Sent as a decimal string; the server converts to minor units so the
      // rounding rule lives in exactly one place.
      price: form.get('price'),
      costPrice: form.get('costPrice') || undefined,
      sku: form.get('sku') || undefined,
      calories: form.get('calories') ? Number(form.get('calories')) : undefined,
      prepTimeMinutes: form.get('prepTimeMinutes')
        ? Number(form.get('prepTimeMinutes'))
        : undefined,
      status: form.get('status'),
      tagIds: selectedTags,
      attributes,
    }

    try {
      if (editing) {
        await patchJson(`/api/menu/items/${item!.id}`, body)
      } else {
        await postJson('/api/menu/items', body)
      }

      toast.success(editing ? 'Item updated' : 'Item created')
      setOpen(false)
      router.refresh()
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setError(cause.message)
        if (cause.details) {
          setFieldErrors(
            Object.fromEntries(
              Object.entries(cause.details).map(([k, v]) => [k, v[0]]),
            ),
          )
        }
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit item' : 'New menu item'}</DialogTitle>
            <DialogDescription>
              Prices are entered in major units — 12.50, not 1250.
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
                maxLength={160}
                defaultValue={item?.name}
                placeholder="Nasi Lemak"
                aria-invalid={!!fieldErrors.name}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                name="description"
                maxLength={1000}
                defaultValue={item?.description ?? ''}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="price">Price</Label>
                <Input
                  id="price"
                  name="price"
                  required
                  inputMode="decimal"
                  defaultValue={
                    item ? minorToDecimalString(item.priceMinor) : ''
                  }
                  placeholder="12.50"
                  aria-invalid={!!fieldErrors.price}
                />
                {fieldErrors.price && (
                  <p className="text-xs text-destructive">
                    {fieldErrors.price}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="costPrice">Cost price</Label>
                <Input
                  id="costPrice"
                  name="costPrice"
                  inputMode="decimal"
                  defaultValue={
                    item?.costPriceMinor != null
                      ? minorToDecimalString(item.costPriceMinor)
                      : ''
                  }
                  placeholder="4.20"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>Uncategorised</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="sku">SKU</Label>
                <Input
                  id="sku"
                  name="sku"
                  maxLength={60}
                  defaultValue={item?.sku ?? ''}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="calories">Calories</Label>
                <Input
                  id="calories"
                  name="calories"
                  type="number"
                  min={0}
                  defaultValue={item?.calories ?? ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prepTimeMinutes">Prep (min)</Label>
                <Input
                  id="prepTimeMinutes"
                  name="prepTimeMinutes"
                  type="number"
                  min={0}
                  defaultValue={item?.prepTimeMinutes ?? ''}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                name="status"
                defaultValue={item?.status ?? 'active'}
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                <option value="active">Active</option>
                <option value="hidden">Hidden</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            {tags.length > 0 && (
              <div className="space-y-2">
                <Label>Tags and allergens</Label>
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag) => {
                    const selected = selectedTags.includes(tag.id)
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setSelectedTags((current) =>
                            selected
                              ? current.filter((id) => id !== tag.id)
                              : [...current, tag.id],
                          )
                        }
                        className={
                          selected
                            ? 'rounded-md border border-primary bg-primary px-3 py-1.5 text-xs text-primary-foreground'
                            : 'rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent'
                        }
                      >
                        {tag.kind === 'allergen' && '⚠ '}
                        {tag.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2 border-t pt-4">
              <Label className="text-sm font-medium">Custom fields</Label>
              <AttributeFields
                definitions={attributeDefinitions}
                values={attributes}
                errors={fieldErrors}
                onChange={(key, value) =>
                  setAttributes((current) => ({ ...current, [key]: value }))
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editing ? 'Save changes' : 'Create item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
