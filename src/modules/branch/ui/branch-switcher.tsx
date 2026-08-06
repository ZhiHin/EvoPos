'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Selects which branch the tables page is showing.
 *
 * Kept in the URL rather than component state so the view survives a refresh
 * and can be linked — a manager sending "look at Bangsar's layout" should be
 * able to paste a URL.
 */
export function BranchSwitcher({
  branches,
  value,
}: {
  branches: { id: string; name: string }[]
  value: string
}) {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const query = new URLSearchParams(params.toString())
        query.set('branch', next)
        router.push(`?${query.toString()}`)
      }}
    >
      <SelectTrigger className="w-[200px]" aria-label="Branch">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {branches.map((branch) => (
          <SelectItem key={branch.id} value={branch.id}>
            {branch.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
