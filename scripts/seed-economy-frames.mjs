#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import pg from 'pg';

function arrayBody(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const eq = text.indexOf('=', start);
  const open = text.indexOf('[', eq);
  let depth = 0;
  let end = open;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[' || text[i] === '{') depth++;
    if (text[i] === ']' || text[i] === '}') { depth--; if (depth === 0 && text[i] === ']') { end = i; break; } }
  }
  return text.slice(open, end + 1);
}

function parseArray(text, name) {
  const body = arrayBody(text, `export const ${name}`);
  if (!body) return [];
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((s) => s.includes('/') || !s.includes(':'));
}

function parseEffectNames(text, arrayName) {
  const body = arrayBody(text, `export const ${arrayName}`);
  if (!body) return [];
  return [...body.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
}

function parseFrameKeys(text, arrayName) {
  const body = arrayBody(text, `export const ${arrayName}`);
  if (!body) return [];
  return [...body.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
}

function parseFrameEntries(text, arrayName) {
  const body = arrayBody(text, `export const ${arrayName}`);
  if (!body) return [];
  return [...body.matchAll(/\{[^{}]*name:\s*'([^']+)'[^{}]*key:\s*'([^']+)'[^}]*\}/g)].map((m) => ({ name: m[1], key: m[2] }));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
  const explicit = process.argv.slice(2).filter((a) => a.startsWith('--manifest=')).map((a) => a.slice('--manifest='.length));
  const manifests = explicit.length ? explicit : [
    '../Fan Novel/src/features/decorations/decorationManifests.ts',
  ];
  if (args['--include-dev'] === 'true' && !explicit.length) {
    manifests.push(
      '../Fan Novel/src/features/decorations/devAvatarFrames.manifest.ts',
      '../Fan Novel/src/features/decorations/devProfileFrames.manifest.ts',
      '../Fan Novel/src/features/decorations/devProfileEffects.manifest.ts',
    );
  }
  const price = Number(args['--price'] ?? 100);
  const priceAvatar = Number(args['--price-avatar'] ?? price);
  const priceFrame = Number(args['--price-frame'] ?? price);
  const priceEffect = Number(args['--price-effect'] ?? price);
  const priceBadge = Number(args['--price-badge'] ?? price);
  const currency = args['--currency'] ?? 'free';
  for (const p of [priceAvatar, priceFrame, priceEffect, priceBadge]) {
    if (!Number.isInteger(p) || p <= 0) throw new Error('prices must be positive integers');
  }
  if (!['free', 'pro'].includes(currency)) throw new Error("--currency must be free|pro");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const text = manifests.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  if (!text.trim()) throw new Error('no manifest content found');
  const items = [];
  const seenAvatar = new Set();
  for (const key of [...parseArray(text, 'FAN_AVATAR_FRAME_KEYS'), ...parseArray(text, 'DEV_AVATAR_FRAME_KEYS')]) {
    if (seenAvatar.has(key)) continue;
    seenAvatar.add(key);
    items.push({ sku: `frame-avatar-${slug(key)}`, type: 'avatar', price: priceAvatar, name: key.split('/').pop(), metadata: { frameKey: key, proExclusive: false } });
  }
  const frameRows = new Map();
  for (const key of [...parseArray(text, 'FAN_PROFILE_FRAME_KEYS'), ...parseFrameKeys(text, 'DEV_PROFILE_FRAMES')]) {
    if (!frameRows.has(key)) frameRows.set(key, { key, name: key.split('/').pop() });
  }
  for (const e of [...parseFrameEntries(text, 'FAN_PROFILE_FRAMES')]) {
    if (frameRows.has(e.key)) frameRows.get(e.key).name = e.name;
  }
  for (const { key, name } of frameRows.values()) {
    items.push({ sku: `frame-profile-${slug(key)}`, type: 'frame', price: priceFrame, name, metadata: { frameKey: key, proExclusive: false } });
  }
  const seenEffect = new Set();
  for (const name of [...parseEffectNames(text, 'FAN_PROFILE_EFFECTS'), ...parseEffectNames(text, 'DEV_PROFILE_EFFECTS')]) {
    if (seenEffect.has(name)) continue;
    seenEffect.add(name);
    items.push({ sku: `effect-${slug(name)}`, type: 'profile_effect', price: priceEffect, name, metadata: { styleId: name, proExclusive: false } });
  }
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  try {
    let created = 0;
    for (const it of items) {
      const r = await pool.query(
        `INSERT INTO store_items (sku, type, name, price_points, currency, metadata, is_active) VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (sku) DO NOTHING RETURNING id`,
        [it.sku, it.type, it.name, it.price, currency, JSON.stringify(it.metadata)]);
      if (r.rowCount) created++;
    }
    console.log(JSON.stringify({ scanned: items.length, created }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
