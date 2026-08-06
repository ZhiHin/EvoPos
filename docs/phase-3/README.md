# Phase 3 — Modifiers and Combos

Reusable modifier groups with selection rules, the combo builder, and the pure
pricing engine that Phases 4–6 will depend on entirely.

## What shipped

| Area | Delivered |
| --- | --- |
| Permissions | 8 new codes — 44 total |
| Modifier groups | Reusable, min/max selection, per-item overrides |
| Options | Signed price deltas, defaults, per-option quantity limits, availability |
| Combos | Base price + slots, each with its own selection rules |
| Pricing engine | Pure validation and line-total arithmetic, 37 unit tests |
| UI | Modifier group and option management |

One migration: `0005_modifiers`. **28 tables, 30 RLS policies, 44 permissions.**

## Verified

```
npm run typecheck        ✅ clean
npx eslint .             ✅ clean
npm run build            ✅ 54 routes
RUN_DB_TESTS=1 npm test  ✅ 177/177 (51 integration)
```

## The four design decisions

### 1. Groups are reusable, not per-item

A "Size" group attaches to forty drinks through `menu_item_modifier_groups`.
Per-item groups would mean changing a price in forty places.

The join table carries `minSelectionOverride` / `maxSelectionOverride`,
because the same group genuinely means different things on different items:
"Sauce" is optional on a burger and mandatory on plain rice. Without
overrides, the only way to express that is a second near-identical group —
exactly what reusable groups exist to avoid.

Note `resolveGroupRules` uses `??`, not `||`. An override of `0` is
meaningful — it makes a required group optional — and `||` would discard it
in favour of the group default, silently making the override do nothing.

### 2. "Nested modifiers inside combo items" needs no table

A combo slot points at a `menu_item`, and that item already carries its own
modifier groups. Picking "Nasi Lemak" inside a set meal inherits its
spice-level question for free.

Modelling combo modifiers separately would create a second source of truth for
the same question and guarantee the two drift — the combo's copy of "spice
level" would quietly keep the old options after someone edited the item's.

### 3. There is no combo *type* column

Set meal, family set, build-your-own and buffet package are all base price +
slots. A buffet is a combo whose deltas are all zero; build-your-own is one
whose slots are wide. The type is an emergent property of the rules, not a
thing that changes behaviour, so storing it would only invite code to branch
on a label instead of reading the rules.

### 4. The pricing engine is pure

`src/modules/modifier/pricing.ts` has no database, session or tenant
dependency. It is the arithmetic that decides what a customer is charged and
it will be called from QR ordering (Phase 4), the POS (Phase 5) and Smart Bill
(Phase 6) — so it is exhaustively testable in isolation, and 37 tests do so.

Three rules in it worth stating:

**Validation iterates groups, not selections.** Checking only what was sent
means a required group omitted entirely from the payload passes — "you must
choose a size" becomes optional for anyone who edits the request.

**Deltas are added to the unit price before multiplying by quantity.** Three
burgers each with extra cheese is `3 × (base + cheese)`, never
`3 × base + cheese`.

**The unit price is floored at zero.** A misconfigured stack of negative
modifiers should make an item free, never negative — a negative line would
silently offset other lines on a bill and turn a configuration mistake into a
refund.

### Repeats are quantities, not duplicate entries

Selecting the same option twice is rejected; `quantity: 2` is the way to say
it. Allowing both would make "two entries of one" and "one entry of two" price
identically but compare differently, breaking any later attempt to match or
merge order lines — which Phase 6's bill splitting depends on.

## Group coherence is checked on every change

A group whose `minSelection` exceeds its option count can never be satisfied:
every order containing the item becomes unfulfillable, and the failure
surfaces at the till rather than at definition time.

`assertGroupIsSatisfiable` runs after **both** directions of change — editing
the rules, and adding or deleting options — inside the same transaction. An
integration test covers the rollback case: deleting the last option of a
required group throws and the option is still there afterwards.

## Money

Modifier deltas are signed integers in minor units. `priceDeltaMinorSchema`
reuses the menu's price parser for the magnitude and re-applies the sign,
because a menu price may not be negative but a delta may — "small saves 50
cents" is a discount expressed as `-50`, which keeps one arithmetic path
instead of two.

## Known gaps

- **No combo builder UI.** The combo API and service are complete and tested
  (10 integration tests cover them), but the admin screen for assembling a
  combo from slots is not built. Combos are currently created via API.
- **No modifier-group attachment UI.** `attachModifierGroupToItem` works and
  is tested, but the item form has no picker for it yet.
- **Inventory deduction is deliberately absent.** The spec lists it under
  modifier configuration, but inventory arrives in Phase 10. A dead column now
  is a column someone wires up wrongly later.
- **`modifier_option_branches` is unused by the engine.** The table and its
  policy exist and per-branch availability is modelled, but
  `loadItemModifierRules` does not yet filter by branch — it will need the
  branch context that arrives with ordering in Phase 4.

## Next: Phase 4 — Dining Session and QR Ordering

The core business object. Join a table by scanning, personal carts, per-diner
subtotals, call waiter. This is where the Phase 1 QR token becomes a real
session token, and where the pricing engine gets its first live caller.
