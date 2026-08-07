'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Printer } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * The range picker.
 *
 * Everything lives in the URL rather than in component state, so a report can
 * be bookmarked and pasted into a message. "The numbers I meant" is a link,
 * not a description of which dropdowns to set.
 *
 * Dates are sent as plain `YYYY-MM-DD` and resolved on the server against the
 * restaurant's zone. Sending an instant from here would send the *browser's*
 * midnight, so a manager travelling would quietly get a different day's
 * figures than the same report pulled from the office.
 */
export function ReportControls({
  report,
  from,
  to,
  branchId,
  granularity,
  branches,
  showGranularity,
}: {
  report: string
  from: string
  to: string
  branchId: string | null
  granularity: string
  branches: { id: string; name: string }[]
  showGranularity: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()

  function update(key: string, value: string): void {
    const query = new URLSearchParams(params.toString())
    if (value) query.set(key, value)
    else query.delete(key)
    query.set('report', report)
    router.push(`?${query.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      <div className="space-y-1.5">
        <Label htmlFor="from" className="text-xs">
          From
        </Label>
        <Input
          id="from"
          type="date"
          value={from}
          max={to}
          className="w-[150px]"
          onChange={(event) => update('from', event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="to" className="text-xs">
          To
        </Label>
        <Input
          id="to"
          type="date"
          value={to}
          min={from}
          className="w-[150px]"
          onChange={(event) => update('to', event.target.value)}
        />
      </div>

      {branches.length > 1 && (
        <div className="space-y-1.5">
          <Label className="text-xs">Branch</Label>
          <Select
            value={branchId ?? 'all'}
            onValueChange={(next) =>
              update('branchId', next === 'all' ? '' : next)
            }
          >
            <SelectTrigger className="w-[180px]" aria-label="Branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showGranularity && (
        <div className="space-y-1.5">
          <Label className="text-xs">Group by</Label>
          <Select
            value={granularity}
            onValueChange={(next) => update('granularity', next)}
          >
            <SelectTrigger className="w-[130px]" aria-label="Group by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/*
        PDF is the browser's own print-to-PDF against a print stylesheet.
        Rendering one on the server would mean either a headless browser in the
        deployment or a hand-rolled PDF writer, and neither produces a better
        document than the one the browser already lays out from this page.
      */}
      <Button variant="outline" onClick={() => window.print()}>
        <Printer className="size-4" />
        Print / PDF
      </Button>
    </div>
  )
}
