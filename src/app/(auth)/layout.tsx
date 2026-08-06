import Link from 'next/link'

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4 sm:p-8">
      <Link
        href="/"
        className="flex items-center gap-2 text-lg font-semibold tracking-tight"
      >
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
          R
        </span>
        Restaurant OS
      </Link>

      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
