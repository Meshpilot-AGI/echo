/**
 * Remove legacy ORDERS_CREATE webhook subscriptions after migrating to
 * shopify.meshpilot.app. Deletes subscriptions whose callbackUrl matches
 * configured legacy prefixes.
 *
 * Usage:
 *   node src/cleanup-legacy-shopify-webhooks.mjs <shop-domain>
 *
 * Dry-run by default; pass --apply to actually delete.
 */

import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

const shop = (process.argv[2] || process.env.SHOP_DOMAIN || '').trim();
const apply = process.argv.includes('--apply');

if (!shop) {
  console.error('Usage: node src/cleanup-legacy-shopify-webhooks.mjs <shop-domain> [--apply]');
  process.exit(1);
}

// Legacy COD-confirm webhook URLs that should be retired now that
// shopify.meshpilot.app/cod-confirm is canonical. We intentionally do NOT
// touch insights.glitchexecutor.com webhooks — those belong to the ads-bot
// and are migrated separately.
const LEGACY_PREFIXES = [
  'https://shopify.glitchexecutor.com/cod-confirm/webhook/shopify/orders-create',
  'https://meshpilot.app/cod-confirm/webhook/shopify/orders-create',
];

async function graphql(shop, token, query, variables) {
  const resp = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json();
  if (!resp.ok || data.errors) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors || data)}`);
  }
  return data.data;
}

async function main() {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) {
    throw new Error(`No offline session for ${shop}.`);
  }

  const { webhookSubscriptions } = await graphql(shop, session.accessToken, `{
    webhookSubscriptions(first: 250, topics: [ORDERS_CREATE]) {
      edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
    }
  }`);

  const legacy = webhookSubscriptions.edges
    .map(e => e.node)
    .filter(n => LEGACY_PREFIXES.some(p => n.endpoint?.callbackUrl?.startsWith(p)));

  if (!legacy.length) {
    console.log(`No legacy ORDERS_CREATE webhooks found for ${shop}.`);
    return;
  }

  console.log(`Found ${legacy.length} legacy subscription(s) for ${shop}:`);
  for (const n of legacy) {
    console.log(`  - ${n.id} → ${n.endpoint.callbackUrl}`);
    if (apply) {
      await graphql(shop, session.accessToken, `
        mutation($id: ID!) {
          webhookSubscriptionDelete(id: $id) {
            deletedWebhookSubscriptionId
            userErrors { field message }
          }
        }`, { id: n.id });
      console.log(`    ✓ Deleted`);
    }
  }
  if (!apply) {
    console.log('\nDry-run complete. Re-run with --apply to delete.');
  }
}

main()
  .catch(err => { console.error('\n✗ Cleanup failed:', err.message, '\n'); process.exit(1); })
  .finally(() => prisma.$disconnect());
