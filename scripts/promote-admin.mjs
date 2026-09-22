#!/usr/bin/env node
// Promote/demote a user by email: DB is the source of truth for roles.
// Usage:
//   DATABASE_URL=... node scripts/promote-admin.mjs user@mail.com [--role admin|reader]
//   npm run admin:promote -- user@mail.com --role admin
import 'dotenv/config';
import pg from 'pg';

const email = (process.argv[2] || '').trim().toLowerCase();
const roleFlag = process.argv.indexOf('--role');
const role = roleFlag >= 0 ? (process.argv[roleFlag + 1] || '').trim() : 'admin';

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/promote-admin.mjs user@mail.com [--role admin|reader]');
  process.exit(2);
}
if (role !== 'admin' && role !== 'reader') {
  console.error('Role must be admin or reader');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const found = await pool.query(
    'SELECT id, email, username, role FROM users WHERE lower(email)=lower($1)',
    [email],
  );
  if (found.rowCount === 0) {
    console.error(`No user found for ${email}`);
    process.exit(1);
  }
  if (role === 'reader') {
    const admins = await pool.query("SELECT id FROM users WHERE role='admin'");
    const isTargetAdmin = found.rows[0].role === 'admin';
    if (isTargetAdmin && admins.rowCount <= 1) {
      console.error('Refusing: cannot demote the last admin');
      process.exit(1);
    }
  }
  const updated = await pool.query(
    'UPDATE users SET role=$1, updated_at=NOW() WHERE lower(email)=lower($2) RETURNING id, email, username, role, updated_at',
    [role, email],
  );
  console.log(JSON.stringify(updated.rows[0], null, 2));
} catch (err) {
  console.error('Failed:', err.code ?? '', err.message ?? err);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
