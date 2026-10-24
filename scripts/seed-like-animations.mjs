#!/usr/bin/env node
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

// Comment like effects: every variant is an owned catalog row (no free
// default — the unequipped plain heart is the default). animationKey mirrors
// the client's likeAnimationKey(): numbers stringify, names pass through.
const ITEMS = [
  { sku: 'like-anim-1', name: 'شرارات', price: 100, key: '1' },
  { sku: 'like-anim-2', name: 'قلوب طايرة', price: 100, key: '2' },
  { sku: 'like-anim-5', name: 'أشعة', price: 100, key: '5' },
  { sku: 'like-anim-6', name: 'قلوب صدى', price: 100, key: '6' },
  { sku: 'like-anim-7', name: 'نجوم', price: 100, key: '7' },
  { sku: 'like-anim-burst', name: 'قلوب صغيرة', price: 100, key: 'burst' },
  { sku: 'like-anim-wave', name: 'موجة', price: 100, key: 'wave' },
  { sku: 'like-anim-3', name: 'كونفيتي', price: 200, key: '3' },
  { sku: 'like-anim-8', name: 'نافورة', price: 200, key: '8' },
  { sku: 'like-anim-9', name: 'مطر قلوب', price: 200, key: '9' },
  { sku: 'like-anim-10', name: 'مدار وانفجار', price: 200, key: '10' },
  { sku: 'like-anim-fountain', name: 'نافورة القلوب', price: 200, key: 'fountain' },
  { sku: 'like-anim-4', name: 'انفجار كامل', price: 300, key: '4' },
  { sku: 'like-anim-11', name: 'ضربة أرضية', price: 300, key: '11' },
  { sku: 'like-anim-explode', name: 'انفجار ضخم', price: 300, key: 'explode' },
  { sku: 'like-anim-storm', name: 'عاصفة قلوب', price: 300, key: 'storm' },
  { sku: 'like-anim-12', name: 'ماكس', price: 500, key: '12' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  try {
    let created = 0;
    for (const it of ITEMS) {
      const r = await pool.query(
        `INSERT INTO store_items (sku, type, name, price_points, currency, metadata, is_active) VALUES ($1,'like_animation',$2,$3,'free',$4,true) ON CONFLICT (sku) DO NOTHING RETURNING id`,
        [it.sku, it.name, it.price, JSON.stringify({ animationKey: it.key, proExclusive: false })]);
      if (r.rowCount) created++;
    }
    console.log(JSON.stringify({ scanned: ITEMS.length, created }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
