import { z } from 'zod'

/**
 * Input contracts for the auth module.
 *
 * Every one of these is parsed server-side. Client-side validation exists
 * only to make the form pleasant; it is never the thing that decides whether
 * input is acceptable.
 */

/**
 * Emails are normalised, not merely validated. Storing the lowercased form
 * and comparing against it is what makes the unique index meaningful --
 * otherwise Owner@cafe.com and owner@cafe.com register as two accounts.
 */
/**
 * Note the ordering: normalise first, then validate.
 *
 * Writing this as `z.email().transform(trim)` reads the same but behaves
 * differently -- the format check runs against the raw input, so a
 * copy-pasted or autofilled " owner@cafe.com " is rejected as malformed
 * before the trim ever happens. Piping a trimmed, lowercased string into the
 * email check validates what will actually be stored.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email('Enter a valid email address')
      .max(254, 'Email address is too long'),
  )

/**
 * Length is the only rule, deliberately.
 *
 * NIST SP 800-63B advises against composition requirements ("one uppercase,
 * one symbol") because they push people toward predictable mutations like
 * Password1! while blocking genuinely strong passphrases. A 12-character
 * minimum with no character classes is the stronger policy.
 *
 * The 128 ceiling is a denial-of-service guard: Argon2 cost scales with input
 * length, so an unbounded field is a free way to make the server do work.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
  /** Name of the restaurant created alongside the account. */
  restaurantName: z
    .string()
    .trim()
    .min(1, 'Restaurant name is required')
    .max(120),
})

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
})

export const forgotPasswordSchema = z.object({
  email: emailSchema,
})

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: passwordSchema,
})

export const switchTenantSchema = z.object({
  restaurantId: z.uuid(),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type SwitchTenantInput = z.infer<typeof switchTenantSchema>
