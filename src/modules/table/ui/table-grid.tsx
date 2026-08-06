import QRCode from 'qrcode'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { qrPayloadUrl } from '@/modules/table/qr'
import type { TableSummary } from '@/modules/table/table.repository'
import { QrDialog } from './qr-dialog'
import { TableFormDialog } from './table-form-dialog'

const STATUS_VARIANT = {
  available: 'secondary',
  occupied: 'default',
  reserved: 'outline',
  out_of_service: 'destructive',
} as const

/**
 * A grid rather than a drag-and-drop floor plan.
 *
 * `positionX`/`positionY` exist in the schema, so a spatial layout can be
 * built later without a migration. Shipping the grid first means tables are
 * usable in Phase 1 instead of waiting on a layout editor that nobody can use
 * until there are tables to arrange.
 */
export async function TableGrid({
  tables,
  floors,
  branchId,
  canEdit,
  canRotate,
}: {
  tables: TableSummary[]
  floors: { id: string; name: string }[]
  branchId: string
  canEdit: boolean
  canRotate: boolean
}) {
  if (tables.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm text-muted-foreground">
          No tables in this branch yet.
        </p>
      </div>
    )
  }

  const floorName = new Map(floors.map((f) => [f.id, f.name]))

  /**
   * Rendered on the server so the SVG is part of the HTML. It prints
   * correctly from the browser's print dialog and needs no client-side
   * library, which also keeps the token out of a client bundle.
   */
  const qrByTable = new Map(
    await Promise.all(
      tables.map(
        async (table) =>
          [
            table.id,
            {
              svg: await QRCode.toString(qrPayloadUrl(table.qrToken), {
                type: 'svg',
                margin: 1,
                errorCorrectionLevel: 'M',
              }),
              url: qrPayloadUrl(table.qrToken),
            },
          ] as const,
      ),
    ),
  )

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tables.map((table) => {
        const qr = qrByTable.get(table.id)!

        return (
          <Card key={table.id}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-lg font-semibold">
                    {table.code}
                  </div>
                  {table.name && (
                    <div className="truncate text-xs text-muted-foreground">
                      {table.name}
                    </div>
                  )}
                </div>
                <Badge variant={STATUS_VARIANT[table.status]}>
                  {table.status.replace(/_/g, ' ')}
                </Badge>
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {table.capacity} seat{table.capacity === 1 ? '' : 's'}
                </span>
                <span>
                  {table.floorId
                    ? (floorName.get(table.floorId) ?? 'Unknown floor')
                    : 'Unassigned'}
                </span>
              </div>

              <div className="flex gap-2">
                <QrDialog
                  tableId={table.id}
                  tableCode={table.code}
                  svg={qr.svg}
                  url={qr.url}
                  canRotate={canRotate}
                  trigger={
                    <Button variant="outline" size="sm" className="flex-1">
                      QR
                    </Button>
                  }
                />

                {canEdit && (
                  <TableFormDialog
                    branchId={branchId}
                    floors={floors}
                    table={table}
                    trigger={
                      <Button variant="outline" size="sm" className="flex-1">
                        Edit
                      </Button>
                    }
                  />
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
