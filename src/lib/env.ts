import { z } from 'zod'

/**
 * Validated server-side environment.
 *
 * Parsed once at module load so a misconfigured deployment fails at boot
 * rather than at the first request that happens to touch the missing value.
 */

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    APP_URL: z.url(),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_URL_MIGRATOR: z
      .string()
      .min(1, 'DATABASE_URL_MIGRATOR is required'),

    AUTH_SECRET: z
      .string()
      .min(32, 'AUTH_SECRET must be at least 32 characters'),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    /**
     * Optional, and the advisor is fully functional without it.
     *
     * A model is used for one thing only: writing the advisor's findings up as
     * a paragraph. Every figure and every recommendation is computed before
     * the model is called, so leaving this unset changes the prose and nothing
     * else. See `src/modules/advisor/narrator.ts`.
     */
    ANTHROPIC_API_KEY: z.string().optional(),
  })
  .refine(
    (v) => !!v.GOOGLE_CLIENT_ID === !!v.GOOGLE_CLIENT_SECRET,
    {
      message:
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or both left empty to disable Google login',
      path: ['GOOGLE_CLIENT_ID'],
    },
  )

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env)

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nRequired variables are documented in README.md, Setup step 3.`,
    )
  }

  return parsed.data
}

export const env = loadEnv()

/** Google login is only wired up when both credentials are present. */
export const isGoogleAuthEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
)

export const isProduction = env.NODE_ENV === 'production'

/**
 * True when the advisor can have its briefing written by a model.
 *
 * False is a supported configuration, not a broken one — the findings are
 * identical either way, and only the paragraph introducing them is plainer.
 */
export const isNarratorEnabled = Boolean(env.ANTHROPIC_API_KEY)
