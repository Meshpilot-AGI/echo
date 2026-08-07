/**
 * Mesh Pilot shared-state resolver for Echo (cod_confirm).
 *
 * Mirrors the Signal pattern in
 * `src/social_agent/src/glitch_signal/shared_context.py`: hub-owned
 * `core.brand_aliases` is the canonical mapping between an external
 * identifier (here: a Shopify shop domain) and the canonical
 * `core.brands.brand_id`.
 *
 * Echo's existing `lib/shops.js::brandIdForShop` reads from a built-in
 * family JSON. That works, but it duplicates state the hub already owns
 * — when an operator adds a new brand to Mesh Pilot they shouldn't
 * also have to remember to update Echo's local config. This module is
 * the read path that lets Echo treat the hub as the source of truth.
 *
 * Architecture decision (Echo shared-access, 2026-05-26): follows
 * Signal-PHASE-2b. Identity convention diff is resolved via
 * `core.brand_aliases.system='shopify_domain'`, which the hub already
 * populates for every Urban-family + Ayurpet store. Echo just reads.
 */
import pg from 'pg';

const { Pool } = pg;

const HUB_BRAND_ALIAS_SYSTEM_SHOPIFY = 'shopify_domain';

let _pool = null;

function ensurePool() {
  if (_pool) return _pool;
  const url = process.env.POSTGRES_BRAIN_URL || process.env.HUB_DB_URL || '';
  if (!url) {
    // Hub DB not configured — caller should treat as drift, not throw.
    return null;
  }
  _pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 30_000,
  });
  // Swallow pool-level errors so a transient DB blip doesn't crash Echo.
  _pool.on('error', err => {
    console.warn('[hub-context] pg pool error (non-fatal):', err.message);
  });
  return _pool;
}

// Sync lookup cache for the canonical brand_id of a shop. Populated by
// `auditShopRegistryAgainstHub` at startup. `lib/shops.js::brandIdForShop`
// reads this before falling back to the local family JSON, so new
// callers transparently get the hub-canonical id.
const _canonicalBrandIdByShop = new Map();

// Sync cache for hub-owned branding facts keyed by canonical brand_id.
// Populated alongside the shop→brand_id audit so a single boot DB
// round-trip yields both the id mapping and the brand metadata.
// Today carries `{display_name, business_type}`; widen as more
// `core.brands` columns get callers in Echo (locale, primary_currency,
// etc.). Echo's `getShopBranding` reads through
// `canonicalBrandingForShopSync` so a shop with a hub record
// transparently picks up hub branding without changing call sites.
const _brandingByCanonicalBrandId = new Map();

/**
 * Async resolver. Hits the hub `core.brand_aliases` table directly for
 * the canonical brand_id behind a Shopify shop domain.
 *
 * Returns the canonical brand_id, or null when:
 *  - the hub DB is not configured (callers should fall back deliberately)
 *  - the shop is unknown to the hub (real drift)
 *  - the query fails (logged; same null fallthrough)
 */
export async function resolveCanonicalBrandIdForShop(shop) {
  if (!shop) return null;
  const pool = ensurePool();
  if (!pool) return null;
  const alias = String(shop).trim().toLowerCase();
  try {
    const { rows } = await pool.query(
      `SELECT brand_id
         FROM core.brand_aliases
        WHERE system = $1
          AND alias  = $2
        LIMIT 1`,
      [HUB_BRAND_ALIAS_SYSTEM_SHOPIFY, alias],
    );
    return rows[0]?.brand_id ?? null;
  } catch (err) {
    console.warn(
      `[hub-context] resolveCanonicalBrandIdForShop shop=${alias} query_failed reason=${err.message}`,
    );
    return null;
  }
}

/**
 * Sync lookup against the boot-time cache. Returns `undefined` when
 * the cache is empty (audit hasn't run yet, hub was unreachable, or
 * the shop wasn't in the audited list). Callers must handle undefined
 * deliberately — DO NOT silently treat it as "no canonical id".
 */
export function canonicalBrandIdForShopSync(shop) {
  if (!shop) return undefined;
  return _canonicalBrandIdByShop.get(String(shop).trim().toLowerCase());
}

/**
 * Boot-time audit: for each locally-known shop domain, look up the
 * canonical brand_id in the hub and emit a structured log line.
 *
 * Status values per shop:
 *   - present_in_hub       — alias row matched; cache populated
 *   - missing_in_hub       — no alias row; real drift
 *   - hub_unreachable      — POSTGRES_BRAIN_URL not configured or
 *                            query failed; cache left empty for
 *                            this shop
 *
 * Observation-only. Never throws. Echo must boot in a hub-detached
 * environment (local dev without brain DB env vars). Returns a
 * `{[shop]: {status, canonical}}` map for callers that want to act
 * on the result.
 */
export async function auditShopRegistryAgainstHub(shops, opts = {}) {
  const source = opts.source || 'shops.urban_family_json';
  const unique = Array.from(
    new Set((shops || []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean)),
  ).sort();
  const results = {};

  const pool = ensurePool();
  if (!pool) {
    console.warn(
      `[hub-context] cod_confirm.brand_drift status=hub_unreachable source=${source} reason=POSTGRES_BRAIN_URL_not_configured shops=${JSON.stringify(unique)}`,
    );
    for (const shop of unique) {
      results[shop] = { status: 'hub_unreachable', canonical: null };
    }
    return results;
  }

  let rows;
  try {
    const r = await pool.query(
      `SELECT alias, brand_id
         FROM core.brand_aliases
        WHERE system = $1
          AND alias  = ANY($2::text[])`,
      [HUB_BRAND_ALIAS_SYSTEM_SHOPIFY, unique],
    );
    rows = r.rows;
  } catch (err) {
    console.warn(
      `[hub-context] cod_confirm.brand_drift status=hub_unreachable source=${source} reason=${err.message} shops=${JSON.stringify(unique)}`,
    );
    for (const shop of unique) {
      results[shop] = { status: 'hub_unreachable', canonical: null };
    }
    return results;
  }

  const aliasMap = new Map(rows.map(r => [r.alias, r.brand_id]));

  // Second hub read: pull branding facts for the canonical brand_ids
  // we just resolved. One round-trip — fine for the boot-time audit;
  // both caches survive for the lifetime of the process. Failure here
  // is non-fatal: shop→brand_id resolution still works, branding just
  // falls back to local config (see `lib/shops.js::getShopBranding`).
  const canonicalIds = Array.from(new Set(Array.from(aliasMap.values()))).sort();
  if (canonicalIds.length) {
    try {
      const r2 = await pool.query(
        `SELECT brand_id, display_name, business_type
           FROM core.brands
          WHERE brand_id = ANY($1::text[])`,
        [canonicalIds],
      );
      for (const row of r2.rows) {
        _brandingByCanonicalBrandId.set(row.brand_id, {
          display_name: row.display_name || null,
          business_type: row.business_type || null,
        });
      }
    } catch (err) {
      console.warn(
        `[hub-context] cod_confirm.brand_branding_load_failed source=${source} reason=${err.message} canonical_ids=${JSON.stringify(canonicalIds)}`,
      );
      // Leave the branding cache empty — getShopBranding will fall
      // back to env/local-JSON gracefully.
    }
  }

  for (const shop of unique) {
    const canonical = aliasMap.get(shop);
    if (canonical) {
      _canonicalBrandIdByShop.set(shop, canonical);
      results[shop] = { status: 'present_in_hub', canonical };
      console.log(
        `[hub-context] cod_confirm.brand_drift status=present_in_hub source=${source} shop=${shop} canonical=${canonical} system=${HUB_BRAND_ALIAS_SYSTEM_SHOPIFY}`,
      );
    } else {
      results[shop] = { status: 'missing_in_hub', canonical: null };
      console.warn(
        `[hub-context] cod_confirm.brand_drift status=missing_in_hub source=${source} shop=${shop} hint=add_row_to_core.brand_aliases_system=${HUB_BRAND_ALIAS_SYSTEM_SHOPIFY}`,
      );
    }
  }
  return results;
}

/**
 * Sync read of hub branding facts for the canonical brand_id behind
 * a shop. Returns `undefined` when:
 *  - the audit hasn't run yet
 *  - the shop is unknown to the hub
 *  - the branding load failed (logged at audit time)
 *
 * Shape: `{display_name: string, business_type: string|null}`. Callers
 * should treat undefined as "use whatever local fallback you have".
 */
export function canonicalBrandingForShopSync(shop) {
  if (!shop) return undefined;
  const brandId = _canonicalBrandIdByShop.get(String(shop).trim().toLowerCase());
  if (!brandId) return undefined;
  return _brandingByCanonicalBrandId.get(brandId);
}

/**
 * Compare each local (shop, name) pair against the hub `display_name`
 * for the same shop's canonical brand_id. Logs a structured
 * `cod_confirm.branding_drift` line per shop with a status:
 *
 *   - synced            — local matches hub exactly
 *   - drift             — local and hub both exist but disagree
 *   - hub_missing       — hub has no display_name for this brand
 *   - shop_missing      — shop has no canonical brand_id resolved
 *
 * Observation-only. Returns `{[shop]: {status, hub, local}}`. Intended
 * to run once at boot, right after `auditShopRegistryAgainstHub`, so
 * the audit's brand_id cache is already warm. Echo's existing
 * fallback chain in `getShopBranding` keeps live calls working even
 * while drift is present — this surfaces the drift; resolving it is
 * an operator action.
 */
export function auditShopBrandingAgainstHub(localBranding, opts = {}) {
  const source = opts.source || 'shops.urban_family_json';
  const results = {};
  for (const [rawShop, local] of Object.entries(localBranding || {})) {
    const shop = String(rawShop || '').trim().toLowerCase();
    if (!shop) continue;
    const brandId = _canonicalBrandIdByShop.get(shop);
    if (!brandId) {
      results[shop] = { status: 'shop_missing', hub: null, local: local?.name || null };
      // Already logged by auditShopRegistryAgainstHub; no need to
      // re-emit the missing_in_hub warning here.
      continue;
    }
    const hubRow = _brandingByCanonicalBrandId.get(brandId);
    const hubName = hubRow?.display_name || null;
    const localName = local?.name || null;
    if (!hubName) {
      results[shop] = { status: 'hub_missing', hub: null, local: localName };
      console.warn(
        `[hub-context] cod_confirm.branding_drift status=hub_missing source=${source} shop=${shop} canonical=${brandId} local_name=${JSON.stringify(localName)}`,
      );
    } else if (hubName === localName) {
      results[shop] = { status: 'synced', hub: hubName, local: localName };
      console.log(
        `[hub-context] cod_confirm.branding_drift status=synced source=${source} shop=${shop} canonical=${brandId} name=${JSON.stringify(hubName)}`,
      );
    } else {
      results[shop] = { status: 'drift', hub: hubName, local: localName };
      console.warn(
        `[hub-context] cod_confirm.branding_drift status=drift source=${source} shop=${shop} canonical=${brandId} hub_name=${JSON.stringify(hubName)} local_name=${JSON.stringify(localName)} hint=hub_is_canonical_update_local_or_fix_core.brands`,
      );
    }
  }
  return results;
}

/**
 * Tear down the connection pool. Called from server.js graceful
 * shutdown.
 */
export async function closeHubPool() {
  if (_pool) {
    try { await _pool.end(); } catch { /* swallow */ }
    _pool = null;
  }
}
