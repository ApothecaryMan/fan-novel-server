export const ADMIN_USER_ROLES = ['admin', 'author', 'translator', 'reader'] as const;

export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];

function isAdminUserRole(value: string): value is AdminUserRole {
  return (ADMIN_USER_ROLES as readonly string[]).includes(value);
}

export function parseAdminUserRoles(raw: string | undefined): {
  roles: AdminUserRole[];
  invalid: string | null;
} {
  if (raw === undefined || raw.trim() === '') {
    return { roles: [], invalid: null };
  }

  const selected = new Set<AdminUserRole>();
  for (const value of raw.split(',').map((role) => role.trim())) {
    if (value === '') continue;
    if (!isAdminUserRole(value)) {
      return { roles: [], invalid: value };
    }
    selected.add(value);
  }

  return {
    roles: ADMIN_USER_ROLES.filter((role) => selected.has(role)),
    invalid: null,
  };
}
