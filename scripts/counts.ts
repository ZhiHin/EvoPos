import 'dotenv/config'
import { sql } from 'drizzle-orm'

/**
 * Counts the things the phase READMEs quote — tables, policies, permissions.
 *
 * A script rather than a note in a document, because the numbers in those
 * documents are claims about the database and a claim nobody can re-check is
 * one that drifts.
 *
 *   npx tsx scripts/counts.ts
 */
async function main(): Promise<void> {
  const { db } = await import('../src/lib/db')

  const [tables] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `)

  const [policies] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_policies where schemaname = 'public'
  `)

  const [permissions] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from permissions
  `)

  console.info(`tables:      ${String(tables.n)}`)
  console.info(`RLS policies: ${String(policies.n)}`)
  console.info(`permissions:  ${String(permissions.n)}`)

  process.exit(0)
}

void main()
