import { describe, expect, it } from 'vitest';
import { ADMIN_USER_ROLES, parseAdminUserRoles } from './adminUserFilters.js';

describe('admin user role filters', () => {
  it('exports the exact canonical roles', () => {
    expect(ADMIN_USER_ROLES).toEqual(['admin', 'author', 'translator', 'reader']);
  });

  it('returns no roles for missing, empty, or whitespace input', () => {
    expect(parseAdminUserRoles(undefined)).toEqual({ roles: [], invalid: null });
    expect(parseAdminUserRoles('')).toEqual({ roles: [], invalid: null });
    expect(parseAdminUserRoles('   ')).toEqual({ roles: [], invalid: null });
  });

  it('parses a single role', () => {
    expect(parseAdminUserRoles('admin')).toEqual({ roles: ['admin'], invalid: null });
  });

  it('trims CSV values and deduplicates them in canonical order', () => {
    expect(parseAdminUserRoles(' reader, author ,reader, admin, translator ')).toEqual({
      roles: ['admin', 'author', 'translator', 'reader'],
      invalid: null,
    });
  });

  it('rejects the entire list when any role is unknown', () => {
    expect(parseAdminUserRoles('reader, owner')).toEqual({ roles: [], invalid: 'owner' });
  });
});
