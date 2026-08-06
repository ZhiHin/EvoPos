import { redirect } from 'next/navigation'

import { AppShell } from '@/components/app-shell'
import { getAuthContext } from '@/lib/auth/context'
import { listTenantsForUser } from '@/modules/rbac/rbac.repository'

/**
 * Guard for every signed-in, tenant-scoped page.
 *
 * This is a real enforcement point, unlike the middleware -- it runs on the
 * Node runtime, validates the session against the database, and re-resolves
 * membership on every request. A user removed from a restaurant loses access
 * on their next navigation rather than whenever their cookie happens to
 * expire.
 */
export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const ctx = await getAuthContext()

  if (!ctx) redirect('/login')

  if (!ctx.tenant) {
    // Signed in, but no active restaurant: either they hold several
    // memberships and have not chosen, or they hold none at all.
    const tenants = await listTenantsForUser(ctx.user.id)
    redirect(tenants.length === 0 ? '/onboarding' : '/select-restaurant')
  }

  const tenants = await listTenantsForUser(ctx.user.id)

  /**
   * Filtered here, on the server, from permissions already resolved for this
   * request. A link the member cannot use is not rendered — but the guard on
   * each page is what actually refuses them, so a hand-typed URL gets the
   * same answer as a hidden link.
   */
  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' as const },
    ...(ctx.tenant.permissions.has('branch.view')
      ? [{ href: '/branches', label: 'Branches', icon: 'branches' as const }]
      : []),
    ...(ctx.tenant.permissions.has('table.view')
      ? [{ href: '/tables', label: 'Tables', icon: 'tables' as const }]
      : []),
    ...(ctx.tenant.permissions.has('menu.item.view')
      ? [{ href: '/menu', label: 'Menu', icon: 'menu' as const }]
      : []),
    ...(ctx.tenant.permissions.has('settings.view')
      ? [{ href: '/settings', label: 'Settings', icon: 'settings' as const }]
      : []),
  ]

  return (
    <AppShell
      user={{ name: ctx.user.name, email: ctx.user.email }}
      tenant={{ name: ctx.tenant.restaurantName, roleName: ctx.tenant.roleName }}
      canSwitchTenant={tenants.length > 1}
      navItems={navItems}
    >
      {children}
    </AppShell>
  )
}
