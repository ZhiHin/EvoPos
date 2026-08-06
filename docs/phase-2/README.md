# Phase 2 — Universal Menu Engine

Nested categories, menu items, owner-defined custom fields, tags and
allergens, branch availability and time windows. The first phase where
configurability is the feature rather than a property of it.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 10 new codes — 36 total |
| Categories | Nested to 3 levels, cycle-proof, orphan-safe deletion |
| Custom fields | Owner-defined definitions + validated JSONB values |
| Items | Price/cost in minor units, per-item tax override, SKU, barcode, calories, prep time |
| Tags | One table for labels, allergens and dietary marks |
| Availability | Per-branch exceptions and per-weekday time windows |
| UI | Menu page with category tree, item table, dynamic attribute form |

One migration: `0004_menu`. **21 tables, 23 RLS policies, 36 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅
RUN_DB_TESTS=1 npm test  ✅ 130/130 (41 integration)
```

## The four design decisions

### 1. Nested categories → adjacency list, not a closure table

A closure table is the right structure for deep arbitrary hierarchies. Menu
trees are not that — "Food › Mains › Curries" is already a deep one — so a
second table with its triggers and write amplification would be cost with no
matching benefit.

The two invariants a plain `parent_id` cannot enforce are handled in the
service, where a recursive CTE can express them:

- **No cycles.** Moving a parent under its own child creates a detached ring
  that no tree walk can reach. `ancestorIdsOf` catches it before the write.
- **Depth cap of 3.** Checked as `depth(newParent) + height(movingSubtree)`,
  because moving a two-level branch under a level-two parent pushes its leaves
  to level four even though the parent itself was legal.

Both recursive queries carry a `depth <` guard. If corrupt data ever produced
a loop, an unguarded recursive query would spin until the connection died;
the guard makes it terminate so the caller can reject the row instead.

### 2. Custom attributes → definitions table + JSONB values

The requirement is "unlimited custom attributes through the admin panel".
Three ways to build it:

| Approach | Problem |
| --- | --- |
| Bare JSONB | Nothing to render a form from, nothing to validate against, no way to tell a typo'd key from a new one |
| Full EAV | Every item read becomes a pile of joins for data always fetched with its item |
| **Definitions + JSONB** | — |

Definitions live in `menu_attribute_definitions` (key, label, type, options,
required); values live in `menu_items.attributes`, GIN-indexed so they stay
filterable. `validateAttributeValues` is pure, so the rules that gate a
schemaless column are unit-testable without a database — 15 tests cover it.

**Unknown keys are rejected, not dropped.** A typo'd key that silently
vanishes on save looks to the user like the field simply did not work, with
nothing on screen to explain why.

There is no PATCH for attribute definitions. Changing a `select`'s options or
its type outright can invalidate every stored value with no way to tell which
were affected. Delete-and-recreate is the honest operation: values under the
old key survive untouched and become live again if the key is reused.

### 3. Allergens are tags with a `kind`

Labels, allergens and dietary marks are the same shape — a named badge on an
item. Three tables would mean three admin screens and three join tables for
one concept. `kind` keeps them queryable apart where it matters, since
allergens are safety information and need distinct display treatment — but
that is a rendering concern, not a storage one.

### 4. Branch availability stores exceptions only

Absence of a row means available. The inverse — a row per item per branch
meaning "yes" — would give a hundred-item menu across ten branches a thousand
rows that all say yes, and a newly created branch would silently open with an
empty menu.

## Money

Prices are entered in major units (`12.50`) and converted to integer minor
units at the validation boundary, in one place:

```ts
Math.round(parsed * 100)
```

The rounding is not decoration. `12.10 * 100` is `1209.9999999999998` in IEEE
754; truncating yields `1209` — a bill one cent light, on a perfectly ordinary
price, every time.

Per-item `taxRateBasisPoints` is **nullable**, and null is meaningfully
different from `0`: null inherits the restaurant rate from Phase 1, zero means
genuinely zero-rated.

## A bug caught by the registry's own test

`define()` derived a permission's `action` from the last dotted segment, so
`menu.category.view` would have registered `module='menu'`, `action='view'` —
breaking the `code === module.action` invariant *and* colliding with
`menu.item.view`, which derives the identical pair. The helper now treats the
whole suffix as the action.

Worth noting the failure mode: the collision would not have thrown. Two
permissions would simply have shared a `(module, action)` pair, and any future
code grouping permissions by that pair would have silently conflated
"view categories" with "view items".

## Known gaps

- **No tag or attribute admin screens.** Both APIs are complete and tested,
  and the item form renders whatever attributes exist — but defining them
  currently requires an API call. The screens are small and can land with
  Phase 3.
- **No per-branch price overrides.** `menu_item_branches` carries availability
  only. Chains with city-versus-suburb pricing will want a nullable
  `price_minor_override` there; it is a one-column migration when the need is
  real rather than anticipated.
- **Availability windows are not yet consulted.** They are stored and
  validated, but nothing filters a menu by "available right now" until orders
  exist in Phase 5.
- **`ingredientsText` is free text.** Phase 10 replaces it with real recipe
  links and stock deduction.

## Next: Phase 3 — Modifiers and Combos

Modifier groups with selection rules (min/max, required, defaults, price
deltas), the combo builder, and nested modifiers inside combo items. Depends
on this phase for the items being modified.
