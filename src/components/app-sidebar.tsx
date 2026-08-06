'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BookOpen,
  Building2,
  LayoutDashboard,
  Settings,
  SlidersHorizontal,
  Table2,
} from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Navigation appears in Phase 1 rather than Phase 0 because until now there
 * was exactly one destination. Navigation designed around a single page is
 * shaped by nothing.
 *
 * Entries are filtered by permission on the server before being passed in.
 * Hiding a link is a usability affordance, never an access control — the
 * `requirePermission` guard on the page itself is what enforces the rule.
 */
export interface NavItem {
  href: string
  label: string
  icon:
    | 'dashboard'
    | 'branches'
    | 'tables'
    | 'menu'
    | 'modifiers'
    | 'settings'
}

const ICONS = {
  dashboard: LayoutDashboard,
  branches: Building2,
  tables: Table2,
  menu: BookOpen,
  modifiers: SlidersHorizontal,
  settings: Settings,
} as const

export function AppSidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Main"
      className="flex gap-1 overflow-x-auto border-b px-4 py-2 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-4"
    >
      {items.map((item) => {
        const Icon = ICONS[item.icon]
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`)

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              // 44px minimum on touch: a cashier taps this mid-service, often
              // one-handed. Desktop can afford to be tighter.
              'min-h-11 md:min-h-9',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
