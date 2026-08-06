# Phase 0 — UI/UX Screens

## Principles

**Mobile-first, but two different mobiles.** A diner's phone and a waiter's
handheld are both small screens with nothing else in common — one is used
occasionally in good light, the other constantly, one-handed, mid-service.
Phase 0 ships only administrative screens, but the component choices are made
against the harder case.

**Touch targets sized for service, not for design review.** Minimum 44px.
A cashier tapping with a wet hand during a lunch rush is the design target.

**Light and dark, following the device.** Not a preference toggle buried in
settings — a POS terminal in a dim dining room and a back-office laptop in
daylight are the same product on different hardware. `defaultTheme="system"`,
with a manual override in the account menu.

**Server components by default.** Authorisation is resolved server-side and
never round-trips to the client. A component that renders a permission-gated
control gets the answer from `can()` at render time.

## Screens

### `/login`

Centred card on a muted background.

- Email, password, "Forgot password?" inline with the password label
- Primary "Sign in"
- "Continue with Google" below a divider — rendered only when configured
- Link to registration

Error handling: one alert above the form. All credential failures show the
same message ("Incorrect email or password") regardless of cause. OAuth
failures arriving as `?error=` are translated to plain sentences.

### `/register`

- Restaurant name first, then personal name, email, password
- Password hint states the 12-character minimum and recommends a passphrase
  over a short complicated password
- Field-level errors render under their input from the server's `details`

Restaurant name leads deliberately: it frames the action as "set up my
restaurant" rather than "create yet another account".

### `/forgot-password`

Single email field. On submit the form is replaced by a confirmation that
reads identically whether or not the address exists.

### `/reset-password?token=…`

New password field. A missing token shows a "request a new link" state rather
than a broken form. Success redirects to `/login` — the reset revoked every
session, including this browser's, so landing anywhere else would be a lie.

### `/select-restaurant`

Shown when a user holds several memberships.

- One card per restaurant: name, role beneath
- Whole card is the target — keyboard-operable via Enter and Space, with a
  visible focus ring
- Busy state dims the chosen card during the switch

### `/onboarding`

Reached by a Google sign-up with no restaurant. Single field, autofocused.
Reminds the user which account they are signed in as, since they arrived via a
redirect chain and may not be sure.

### `/dashboard`

Phase 0's dashboard is a **foundation readout**, not a sales dashboard. The
operational metrics the product needs — covers, revenue, kitchen queue — have
no data behind them until Phase 5. Showing zeroes in their place would look
like a broken product rather than an unbuilt one.

What it shows instead demonstrates the foundation works:

- Branch count, permission count, branch access scope
- Every permission the current role carries, as badges
- Recent audit entries, tenant-scoped by RLS rather than by the query

### App shell

Sticky header: brand, active restaurant name, theme toggle, account menu
(name, email, role · restaurant, "Switch restaurant" when applicable, "Sign
out").

The active restaurant name sits in the header permanently. For a user who
manages several sites, "which restaurant am I about to change?" must never
require a click to answer.

## Accessibility

- Semantic elements; `role="button"` plus keyboard handlers only where a card
  is the target
- Visible focus rings retained, never suppressed
- `aria-invalid` on failed fields, with the message adjacent
- `aria-busy` during in-flight submissions
- Colour is never the sole carrier of meaning — errors pair colour with text

## Deliberately deferred

Sidebar navigation, breadcrumbs and command palette wait until Phase 1, when
there is more than one destination. Building navigation for a single page
produces navigation shaped by nothing.
