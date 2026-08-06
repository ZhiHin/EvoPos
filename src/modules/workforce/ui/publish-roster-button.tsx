'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ApiClientError, postJson } from '@/lib/client/api'

interface PublishResult {
  published: number
  conflicts: { userId: string; userName: string }[]
}

export function PublishRosterButton({
  branchId,
  from,
  to,
  count,
}: {
  branchId: string
  from: string
  to: string
  count: number
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function publish() {
    setPending(true)
    try {
      const result = await postJson<PublishResult>('/api/shifts/publish', {
        branchId,
        from,
        to,
      })

      if (result.conflicts.length > 0) {
        /**
         * Names, not a count. "Two conflicts" sends a manager hunting; "Ana
         * is rostered twice" tells them where to look.
         */
        toast.error(
          `Not published — ${result.conflicts
            .map((c) => c.userName)
            .join(', ')} rostered in two places at once.`,
        )
        return
      }

      toast.success(`Published ${result.published} shifts`)
      router.refresh()
    } catch (cause) {
      toast.error(
        cause instanceof ApiClientError
          ? cause.message
          : 'Something went wrong.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="outline" onClick={publish} disabled={pending}>
      {pending ? 'Publishing…' : `Publish ${count} draft${count === 1 ? '' : 's'}`}
    </Button>
  )
}
