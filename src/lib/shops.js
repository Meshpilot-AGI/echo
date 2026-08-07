/**
 * Shop allowlist gate + per-shop branding resolver.
 *
 * In beta we restrict incoming webhooks to a configured allowlist so that
 * an accidental webhook from another store (or a malicious one that can
 * forge our HMAC, unlikely but cheap mitigation) doesn't trigger real calls.
 *
 * Configuration sources (in priority order):
 *   1. ALLOWED_SHOPS env var — comma-separated myshopify domains
 *   2. config/urban-family.json — built-in Urban family store list (fallback)
 *
 * Per-shop branding is resolved from:
 *   1. STORE_BRANDING env var — JSON map keyed by myshopify domain
 *   2. config/urban-family.json — built-in Urban family branding (fallback)
 *   3. STORE_NAME / STORE_CATEGORY env vars — legacy single-tenant fallback
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load built-in family config (optional fallback) ────────────────────
let familyConfig = null;
try {
  const configPath = join(__dirname, '..', '..', 'config', 'urban-family.json');
  const raw = readFileSync(configPath, 'utf8');
  familyConfig = JSON.parse(raw);
} catch {
  // Config file is optional — env vars are the primary source.
  familyConfig = null;
}

// ── Allowlist ──────────────────────────────────────────────────────────
const parsed = (() => {
  const raw = process.env.ALLOWED_SHOPS || '';
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // Merge with built-in family config if env var is empty.
  if (list.length === 0 && familyConfig?.stores) {
    return familyConfig.stores
      .filter(s => s.active !== false)
      .map(s => s.domain.trim().toLowerCase());
  }
  return list;
})();

export const ALLOWED_SHOPS = parsed;
export const ALLOWLIST_ACTIVE = parsed.length > 0;

export function isShopAllowed(shop) {
  if (!ALLOWLIST_ACTIVE) return true; // no list = open
  if (!shop) return false;
  return parsed.includes(String(shop).trim().toLowerCase());
}

// ── Branding resolver ──────────────────────────────────────────────────
const brandingMap = (() => {
  const raw = process.env.STORE_BRANDING || '';
  if (raw) {
    try {
      const m = JSON.parse(raw);
      const out = {};
      for (const [k, v] of Object.entries(m)) {
        if (v && typeof v === 'object') {
          out[String(k).trim().toLowerCase()] = {
            name:     String(v.name     || '').trim(),
            category: String(v.category || '').trim(),
          };
        }
      }
      return out;
    } catch (err) {
      console.warn('[shops] STORE_BRANDING is not valid JSON — falling back to STORE_NAME / STORE_CATEGORY:', err.message);
    }
  }
  // Fallback to built-in family config.
  if (familyConfig?.stores) {
    const out = {};
    for (const s of familyConfig.stores) {
      if (s.domain && s.display_name) {
        out[String(s.domain).trim().toLowerCase()] = {
          name:     String(s.display_name || '').trim(),
          category: String(s.category     || 'online store').trim(),
        };
      }
    }
    return out;
  }
  return {};
})();

import { canonicalBrandIdForShopSync, canonicalBrandingForShopSync } from './hub-context.js';

/**
 * Resolve display branding for a shop.
 *
 * Lookup order (post Echo Phase 2, 2026-05-26):
 *   1. Hub-canonical name from `core.brands.display_name`, via
 *      `canonicalBrandingForShopSync()`. Populated by the startup
 *      audit. This is the source-of-truth path.
 *   2. Local override map (env `STORE_BRANDING` or built-in family
 *      JSON), kept so Echo still serves real names when the hub DB
 *      is unreachable or when an operator hasn't migrated branding
 *      to `core.brands` yet.
 *   3. Env defaults `STORE_NAME` / `STORE_CATEGORY` (legacy
 *      single-tenant fallback).
 *
 * `category` is NOT modeled in the hub today — `core.brands` has
 * `business_type` (`ecom_d2c`, `consulting`, …), which is a different
 * shape from Echo's freeform category string. Keep `category` on the
 * local-config path until a hub equivalent exists. The `branding_drift`
 * audit only watches `name`.
 */
export function getShopBranding(shop) {
  const key = String(shop || '').trim().toLowerCase();
  const hubHit = canonicalBrandingForShopSync(key);
  const localHit = brandingMap[key];
  return {
    name:     hubHit?.display_name || localHit?.name     || process.env.STORE_NAME     || '',
    category: localHit?.category   || process.env.STORE_CATEGORY || '',
  };
}

/**
 * Snapshot of the local branding map used by the boot-time
 * `branding_drift` audit. Returns `{shop_lowercase: {name, category}}`
 * — exactly the shape `auditShopBrandingAgainstHub` expects.
 */
export function getLocalBrandingSnapshot() {
  return { ...brandingMap };
}

/**
 * Resolve a shop domain to its brand_id.
 *
 * Lookup order (post Echo shared-access, 2026-05-26):
 *   1. Hub-canonical cache from `lib/hub-context.js` (populated by
 *      the boot-time `auditShopRegistryAgainstHub` call). This is the
 *      source-of-truth path — `core.brand_aliases` is the canonical
 *      mapping per architecture docs.
 *   2. Built-in `config/urban-family.json` fallback. Kept so Echo
 *      still boots in a hub-detached environment (local dev without
 *      POSTGRES_BRAIN_URL) and so a transient brain-DB outage does
 *      not blackhole live calls.
 *
 * Returns undefined when neither source knows the shop.
 */
export function brandIdForShop(shop) {
  if (!shop) return undefined;
  const key = String(shop).trim().toLowerCase();
  const hubHit = canonicalBrandIdForShopSync(key);
  if (hubHit) return hubHit;
  if (!familyConfig?.stores) return undefined;
  const hit = familyConfig.stores.find(
    s => String(s.domain).trim().toLowerCase() === key
  );
  return hit?.brand_id;
}

/**
 * Per-store calling window (DND + on/off switch).
 *
 * Resolution order:
 *   1. The store's `call_window` block in config/urban-family.json —
 *      `{ timezone, dnd_start_hour, dnd_end_hour, calls_enabled }`.
 *   2. Global env defaults `DND_START_HOUR` / `DND_END_HOUR` (and the
 *      lib/dnd.js fallbacks 20/10), `calls_enabled` defaults true.
 *
 * Returned `{ startHour, endHour }` are consumed directly by lib/dnd.js
 * `isDnd(when, { startHour, endHour })` / `adjustForDnd`. `timezone` is
 * informational today — lib/dnd.js evaluates the window in IST, which is
 * correct for every current (Indian) store; a non-IST store would need
 * dnd.js to honour the tz before being onboarded.
 */
const ENV_START_HOUR = Number(process.env.DND_START_HOUR ?? 20);
const ENV_END_HOUR   = Number(process.env.DND_END_HOUR   ?? 10);

/**
 * Resolve a shop domain to its Custom App slug (the key used in
 * SHOPIFY_WEBHOOK_SECRETS, e.g. `urban`, `storico`). Falls back to brand_id,
 * then the raw domain. Used by the Shopify webhook to look up the per-store
 * HMAC signing secret — the secrets map is keyed by app slug, but Shopify
 * sends the myshopify domain in X-Shopify-Shop-Domain.
 */
export function appSlugForShop(shop) {
  const key = String(shop || '').trim().toLowerCase();
  const store = familyConfig?.stores?.find(
    s => String(s.domain).trim().toLowerCase() === key
  );
  return store?.app_slug || store?.brand_id || key;
}

export function getStoreCallWindow(shop) {
  const key = String(shop || '').trim().toLowerCase();
  const store = familyConfig?.stores?.find(
    s => String(s.domain).trim().toLowerCase() === key
  );
  const cw = store?.call_window || {};
  return {
    startHour:    Number.isFinite(cw.dnd_start_hour) ? cw.dnd_start_hour : ENV_START_HOUR,
    endHour:      Number.isFinite(cw.dnd_end_hour)   ? cw.dnd_end_hour   : ENV_END_HOUR,
    timezone:     cw.timezone || 'Asia/Kolkata',
    callsEnabled: cw.calls_enabled !== false, // default ON; explicit false pauses the store
  };
}
