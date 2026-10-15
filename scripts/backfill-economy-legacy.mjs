#!/usr/bin/env node
import pg from 'pg';

const esc = (s) => s.replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'legacy';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const q = (text, params) => pool.query(text, params);
  try {
    const { rows: users } = await q(`SELECT id, profile_decorations FROM users WHERE profile_decorations IS NOT NULL`);
    const planned = [];
    const unmapped = [];
    for (const u of users) {
      const d = u.profile_decorations;
      if (!d || typeof d !== 'object' || Array.isArray(d)) { unmapped.push({ user: u.id, value: d }); continue; }
      const items = [];
      if (typeof d.avatarFrameKey === 'string' && d.avatarFrameKey) {
        const sku = `legacy-avatar-${esc(d.avatarFrameKey)}`;
        items.push({ sku, type: 'avatar', name: `Legacy avatar frame`, metadata: { frameKey: d.avatarFrameKey, proExclusive: false }, slot: 'avatar' });
      }
      if (typeof d.profileFrameKey === 'string' && d.profileFrameKey) {
        const sku = `legacy-frame-${esc(d.profileFrameKey)}`;
        items.push({ sku, type: 'frame', name: `Legacy profile frame`, metadata: { frameKey: d.profileFrameKey, proExclusive: false }, slot: 'frame' });
      }
      // Studio customs (nameStyle, bannerGradient) need no ownership: they stay
      // in the profile_decorations cache untouched, managed via custom slots.
      if (typeof d.profileEffectName === 'string' && d.profileEffectName) {
        const sku = `legacy-effect-${esc(d.profileEffectName)}`;
        items.push({ sku, type: 'profile_effect', name: `Legacy effect`, metadata: { styleId: d.profileEffectName, proExclusive: false }, slot: 'profile_effect' });
      }
      const known = ['avatarFrameKey', 'profileFrameKey', 'nameStyle', 'bannerGradient', 'profileEffectName'];
      for (const k of Object.keys(d)) {
        if (!known.includes(k) && (d[k] !== undefined && d[k] !== null)) unmapped.push({ user: u.id, key: k, value: d[k] });
      }
      planned.push({ userId: u.id, items });
    }
    if (unmapped.length) {
      console.error(JSON.stringify({ unmapped }, null, 2));
      throw new Error(`backfill stopped: ${unmapped.length} unmapped decoration values (nothing written)`);
    }
    let itemCount = 0, invCount = 0, equipCount = 0;
    const seen = new Set();
    for (const p of planned) {
      for (const it of p.items) {
        if (!seen.has(it.sku)) {
          seen.add(it.sku);
          const r = await q(
            `INSERT INTO store_items (sku, type, name, price_points, currency, metadata, is_active) VALUES ($1,$2,$3,1,'free',$4,true) ON CONFLICT (sku) DO NOTHING RETURNING id`,
            [it.sku, it.type, it.name, JSON.stringify(it.metadata)]);
          if (r.rowCount) itemCount++;
        }
      }
    }
    const { rows: catalog } = await q(`SELECT id, sku FROM store_items WHERE sku LIKE 'legacy-%'`);
    const bySku = new Map(catalog.map((r) => [r.sku, r.id]));
    for (const p of planned) {
      for (const it of p.items) {
        const itemId = bySku.get(it.sku);
        const r = await q(
          `INSERT INTO user_inventory (user_id, item_id, source, price_paid, currency) VALUES ($1,$2,'legacy',0,'free') ON CONFLICT (user_id, item_id) DO NOTHING RETURNING id`,
          [p.userId, itemId]);
        if (r.rowCount) invCount++;
        if (it.slot) {
          const e = await q(
            `INSERT INTO user_equipped (user_id, slot, item_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, slot) DO NOTHING RETURNING slot`,
            [p.userId, it.slot, itemId]);
          if (e.rowCount) equipCount++;
        }
      }
    }
    console.log(JSON.stringify({ users: planned.length, items: itemCount, inventory: invCount, equipped: equipCount }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
