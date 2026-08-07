import { Download } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * Export links.
 *
 * Plain anchors, not fetch-and-blob. A download is exactly what an `<a>` does:
 * it streams, it shows in the browser's download list, it survives a slow
 * connection, and it needs no JavaScript. Wrapping it in a click handler adds
 * a spinner and a way to fail.
 */
export function ExportLinks({
  report,
  query,
}: {
  report: string
  query: string
}) {
  const href = (format: string): string =>
    `/api/reports/${report}/export?${query}${query ? '&' : ''}format=${format}`

  return (
    <div className="flex items-center gap-2 print:hidden">
      <Button asChild variant="outline" size="sm">
        <a href={href('csv')} download>
          <Download className="size-4" />
          CSV
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={href('xlsx')} download>
          <Download className="size-4" />
          Excel
        </a>
      </Button>
    </div>
  )
}
