import { and, asc, eq } from 'drizzle-orm'

import type { Transaction } from '@/lib/db'
import { menuCategories, menuItems } from '@/lib/db/schema'
import { loadItemModifierRulesIn } from '@/modules/modifier/modifier.service'
import type { DinerMenuItem } from './ui/order-screen'

/**
 * The menu, as a diner may see it.
 *
 * Runs inside the diner's context, where the only thing granting access is
 * the `*_diner_read` policies — SELECT, scoped to the one restaurant whose
 * table they are sitting at. Hidden and archived items are filtered out here
 * as well, because "not on the menu" is a product decision the policy layer
 * has no opinion about.
 */
export async function loadDinerMenu(
  tx: Transaction,
  restaurantId: string,
): Promise<DinerMenuItem[]> {
  const rows = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      description: menuItems.description,
      priceMinor: menuItems.priceMinor,
      categoryName: menuCategories.name,
      categoryOrder: menuCategories.displayOrder,
    })
    .from(menuItems)
    .leftJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
    .where(
      and(
        eq(menuItems.restaurantId, restaurantId),
        eq(menuItems.status, 'active'),
      ),
    )
    .orderBy(
      asc(menuCategories.displayOrder),
      asc(menuItems.displayOrder),
      asc(menuItems.name),
    )

  /**
   * Modifier rules are loaded per item rather than in one sweep. On a menu of
   * a few hundred items this is the wrong shape and will need a single
   * grouped query — but that optimisation belongs with Phase 5, where the POS
   * loads the same data under real service load and the cost is measurable
   * rather than guessed at.
   */
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      priceMinor: row.priceMinor,
      categoryName: row.categoryName,
      modifierGroups: await loadItemModifierRulesIn(tx, restaurantId, row.id),
    })),
  )
}
