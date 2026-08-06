'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { AttributeDefinition } from '@/modules/menu/attribute.service'

/**
 * Renders form controls from the tenant's own attribute definitions.
 *
 * This is what makes "unlimited custom fields configured from the admin
 * panel" real rather than a slogan: the owner defines a field, and a control
 * for it appears here with no code change. The definitions drive the form,
 * and the same definitions drive server-side validation — so the form can
 * never offer something the server would reject, or omit something it
 * requires.
 *
 * State is held by the caller so the whole item form submits as one object.
 */
export function AttributeFields({
  definitions,
  values,
  onChange,
  errors,
  disabled,
}: {
  definitions: AttributeDefinition[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  errors?: Record<string, string>
  disabled?: boolean
}) {
  if (definitions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No custom fields defined yet. Add them under Menu → Custom fields to
        capture anything this menu needs that the standard fields do not.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {definitions.map((definition) => {
        const id = `attr-${definition.key}`
        const value = values[definition.key]
        const error = errors?.[`attributes.${definition.key}`]

        return (
          <div key={definition.id} className="space-y-2">
            <Label htmlFor={id}>
              {definition.label}
              {definition.required && (
                <span className="ml-1 text-destructive" aria-hidden>
                  *
                </span>
              )}
            </Label>

            {definition.type === 'text' && (
              <Input
                id={id}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(definition.key, e.target.value)}
                maxLength={500}
                disabled={disabled}
                aria-invalid={!!error}
              />
            )}

            {definition.type === 'number' && (
              <Input
                id={id}
                type="number"
                value={typeof value === 'number' ? value : ''}
                onChange={(e) =>
                  onChange(
                    definition.key,
                    // Empty reads as "not set" rather than 0 — otherwise
                    // clearing an optional number silently stores zero.
                    e.target.value === '' ? undefined : Number(e.target.value),
                  )
                }
                disabled={disabled}
                aria-invalid={!!error}
              />
            )}

            {definition.type === 'boolean' && (
              <div className="flex h-9 items-center">
                <Switch
                  id={id}
                  checked={value === true}
                  onCheckedChange={(checked) =>
                    onChange(definition.key, checked)
                  }
                  disabled={disabled}
                />
              </div>
            )}

            {definition.type === 'select' && (
              <Select
                value={typeof value === 'string' ? value : ''}
                onValueChange={(next) => onChange(definition.key, next)}
                disabled={disabled}
              >
                <SelectTrigger id={id} aria-invalid={!!error}>
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {(definition.options ?? []).map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {definition.type === 'multiselect' && (
              <div className="flex flex-wrap gap-2">
                {(definition.options ?? []).map((option) => {
                  const selected =
                    Array.isArray(value) && (value as string[]).includes(option)

                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => {
                        const current = Array.isArray(value)
                          ? (value as string[])
                          : []
                        onChange(
                          definition.key,
                          selected
                            ? current.filter((v) => v !== option)
                            : [...current, option],
                        )
                      }}
                      className={
                        selected
                          ? 'rounded-md border border-primary bg-primary px-3 py-1.5 text-xs text-primary-foreground'
                          : 'rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent'
                      }
                    >
                      {option}
                    </button>
                  )
                })}
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )
      })}
    </div>
  )
}
