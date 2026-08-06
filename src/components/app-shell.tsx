'use client'

import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { LogOut, Moon, Store, Sun } from 'lucide-react'
import { useTransition, type ReactNode } from 'react'

import { AppSidebar, type NavItem } from '@/components/app-sidebar'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { postJson } from '@/lib/client/api'

interface AppShellProps {
  user: { name: string; email: string }
  tenant: { name: string; roleName: string }
  /** True when the user belongs to more than one restaurant. */
  canSwitchTenant: boolean
  /** Already filtered by permission on the server. */
  navItems: NavItem[]
  children: ReactNode
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function AppShell({
  user,
  tenant,
  canSwitchTenant,
  navItems,
  children,
}: AppShellProps) {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [pending, startTransition] = useTransition()

  async function signOut() {
    try {
      await postJson('/api/auth/logout', {})
    } catch {
      // The cookie is cleared server-side either way; a network hiccup here
      // should not strand the user on a page they think they left.
    }
    startTransition(() => {
      router.push('/login')
      router.refresh()
    })
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-sm text-primary-foreground">
              R
            </span>
            <span className="hidden sm:inline">Restaurant OS</span>
          </div>

          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Store className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{tenant.name}</span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
              }
              aria-label="Toggle theme"
            >
              <Sun className="size-4 dark:hidden" />
              <Moon className="hidden size-4 dark:block" />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-9 gap-2 px-2"
                  aria-label="Account menu"
                >
                  <Avatar className="size-7">
                    <AvatarFallback className="text-xs">
                      {initials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="truncate font-medium">{user.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {tenant.roleName} · {tenant.name}
                  </div>
                </DropdownMenuLabel>

                <DropdownMenuSeparator />

                {canSwitchTenant && (
                  <DropdownMenuItem
                    onSelect={() => router.push('/select-restaurant')}
                  >
                    <Store className="size-4" />
                    Switch restaurant
                  </DropdownMenuItem>
                )}

                <DropdownMenuItem onSelect={signOut} disabled={pending}>
                  <LogOut className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col md:flex-row">
        <aside className="md:w-56 md:shrink-0">
          <AppSidebar items={navItems} />
        </aside>

        <main className="min-w-0 flex-1 px-4 py-8">{children}</main>
      </div>
    </div>
  )
}
