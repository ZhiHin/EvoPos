'use client'

import { useSyncExternalStore } from 'react'

/**
 * The current time, ticking, without making render impure.
 *
 * The clock is an external system, so it is subscribed to rather than read
 * during render. Reading `Date.now()` while rendering makes the output depend
 * on when React happened to re-render, and makes the server and client
 * disagree on the first paint.
 *
 * The snapshot is bucketed to the tick interval so it is stable between
 * ticks. An unbucketed `Date.now()` changes on every call, and
 * `useSyncExternalStore` would re-render forever trying to settle.
 *
 * Returns `null` during server rendering and hydration — there is no
 * meaningful "now" to agree on across that boundary, and a caller showing an
 * age should render nothing rather than a figure that is about to jump.
 */
export function useNow(intervalMs = 30_000): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const timer = setInterval(onChange, intervalMs)
      return () => clearInterval(timer)
    },
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => null,
  )
}

/** Whole minutes elapsed since `date`, or null before the clock is live. */
export function minutesSince(date: Date | string, now: number | null): number | null {
  if (now === null) return null
  return Math.max(0, Math.round((now - new Date(date).getTime()) / 60_000))
}
