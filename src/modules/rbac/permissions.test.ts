import { describe, expect, it } from 'vitest'

import {
  isKnownPermission,
  PERMISSION_CODES,
  PERMISSIONS,
  resolveTemplatePermissions,
  SYSTEM_ROLE_TEMPLATES,
} from './permissions'

describe('permission registry', () => {
  it('has no duplicate codes', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length)
  })

  it('uses module.action codes consistently', () => {
    for (const permission of PERMISSIONS) {
      expect(permission.code).toBe(`${permission.module}.${permission.action}`)
      expect(permission.code).toMatch(/^[a-z]+(\.[a-z_]+)+$/)
      expect(permission.description.length).toBeGreaterThan(0)
    }
  })
})

describe('system role templates', () => {
  it('includes an owner role', () => {
    expect(SYSTEM_ROLE_TEMPLATES.some((t) => t.key === 'owner')).toBe(true)
  })

  it('has unique role keys', () => {
    const keys = SYSTEM_ROLE_TEMPLATES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  /**
   * The one that actually earns its keep. A template referencing a permission
   * that does not exist would fail at runtime on the foreign key to
   * `permissions.code` -- and it would fail during registration, so the first
   * symptom is new customers unable to sign up.
   */
  it('only references permissions that exist in the registry', () => {
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      for (const code of resolveTemplatePermissions(template)) {
        expect(
          isKnownPermission(code),
          `role "${template.key}" references unknown permission "${code}"`,
        ).toBe(true)
      }
    }
  })

  it('grants the owner every permission', () => {
    const owner = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'owner')!
    expect([...resolveTemplatePermissions(owner)].sort()).toEqual(
      [...PERMISSION_CODES].sort(),
    )
  })

  it('does not grant role administration to non-owner roles', () => {
    // Any role that can edit roles can grant itself everything, which makes
    // the whole permission model decorative.
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      if (template.key === 'owner') continue
      const granted = resolveTemplatePermissions(template)
      expect(granted).not.toContain('role.update')
      expect(granted).not.toContain('role.create')
      expect(granted).not.toContain('role.delete')
    }
  })
})

describe('phase 1 permissions', () => {
  it('registers floor and table permissions', () => {
    for (const code of [
      'floor.view',
      'floor.create',
      'floor.update',
      'floor.delete',
      'table.view',
      'table.create',
      'table.update',
      'table.delete',
      'table.rotate_qr',
    ]) {
      expect(isKnownPermission(code), `missing permission "${code}"`).toBe(true)
    }
  })

  it('lets floor staff read the room but not restructure it', () => {
    // A waiter needs to see tables to work the floor. Letting them delete a
    // table mid-service is not a capability anyone asked for.
    const waiter = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'waiter')!
    const granted = resolveTemplatePermissions(waiter)

    expect(granted).toContain('table.view')
    expect(granted).toContain('floor.view')
    expect(granted).not.toContain('table.delete')
    expect(granted).not.toContain('table.create')
  })

  it('does not give cashiers QR rotation', () => {
    // Rotating a QR invalidates every printed sticker on that table.
    const cashier = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === 'cashier')!
    expect(resolveTemplatePermissions(cashier)).not.toContain('table.rotate_qr')
  })
})
