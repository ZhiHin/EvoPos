import { redirect } from 'next/navigation'

import { getAuthContext } from '@/lib/auth/context'

/**
 * Root entry. Routes visitors to the right place rather than rendering a
 * marketing page — that belongs outside this application.
 */
export default async function HomePage() {
  const ctx = await getAuthContext()

  if (!ctx) redirect('/login')
  if (!ctx.tenant) redirect('/select-restaurant')

  redirect('/dashboard')
}
