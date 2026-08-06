import { describe, expect, it } from 'vitest'

import { buildCategoryTree, type CategoryRow } from './category.service'

function row(
  id: string,
  parentId: string | null,
  name = id,
): CategoryRow {
  return {
    id,
    parentId,
    name,
    description: null,
    displayOrder: 0,
    status: 'active',
  }
}

describe('buildCategoryTree', () => {
  it('returns an empty tree for no rows', () => {
    expect(buildCategoryTree([])).toEqual([])
  })

  it('nests children under their parent', () => {
    const tree = buildCategoryTree([
      row('food', null),
      row('mains', 'food'),
      row('curries', 'mains'),
    ])

    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('food')
    expect(tree[0].children[0].id).toBe('mains')
    expect(tree[0].children[0].children[0].id).toBe('curries')
  })

  it('assigns depth starting at 1 for roots', () => {
    const tree = buildCategoryTree([
      row('food', null),
      row('mains', 'food'),
      row('curries', 'mains'),
    ])

    expect(tree[0].depth).toBe(1)
    expect(tree[0].children[0].depth).toBe(2)
    expect(tree[0].children[0].children[0].depth).toBe(3)
  })

  it('supports several roots', () => {
    const tree = buildCategoryTree([row('food', null), row('drinks', null)])
    expect(tree.map((n) => n.id).sort()).toEqual(['drinks', 'food'])
  })

  it('treats a row whose parent is missing as a root', () => {
    // A filtered or partial fetch should degrade to a flatter tree, never
    // silently drop items off the menu.
    const tree = buildCategoryTree([row('orphan', 'not-in-this-list')])
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('orphan')
    expect(tree[0].depth).toBe(1)
  })

  it('loses no rows', () => {
    const rows = [
      row('a', null),
      row('b', 'a'),
      row('c', 'a'),
      row('d', 'b'),
      row('e', null),
    ]

    const count = (nodes: ReturnType<typeof buildCategoryTree>): number =>
      nodes.reduce((total, n) => total + 1 + count(n.children), 0)

    expect(count(buildCategoryTree(rows))).toBe(rows.length)
  })
})
