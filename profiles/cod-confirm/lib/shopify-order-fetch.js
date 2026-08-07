/**
 * Fetch a Shopify order by its display name (e.g. "#1234") and project it
 * into the context shape the LiveKit agent expects.
 *
 * Used by the dev `/flow-test-livekit` endpoint to place a real PSTN call
 * against an existing order without going through the webhook → scheduler
 * path. Profile-local because the projection is COD-confirm-specific
 * (customer name + product + amount + delivery address).
 */
import { fetchWithTimeout } from '../../../src/lib/fetch.js';

export async function fetchShopifyOrderByName(prisma, shop, orderName) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) throw new Error(`No session for ${shop}`);
  const q = `{
    orders(first: 1, query: ${JSON.stringify(`name:${orderName}`)}) {
      edges {
        node {
          id name createdAt
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName phone }
          shippingAddress { address1 city phone }
          lineItems(first: 1) { edges { node { title } } }
          customAttributes { key value }
          tags
        }
      }
    }
  }`;
  const resp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const data = await resp.json();
  const o = data?.data?.orders?.edges?.[0]?.node;
  if (!o) throw new Error(`Order ${orderName} not found on ${shop}`);
  return {
    id:           o.id.split('/').pop(),
    name:         o.name,
    total:        Math.round(Number(o.currentTotalPriceSet.shopMoney.amount)),
    currency:     o.currentTotalPriceSet.shopMoney.currencyCode,
    customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ').trim() || 'Customer',
    phone:        o.customer?.phone || o.shippingAddress?.phone,
    product:      o.lineItems?.edges?.[0]?.node?.title || 'your order',
    city:         o.shippingAddress?.city || '',
    area:         o.shippingAddress?.address1 || '',
    tags:         o.tags || [],
  };
}
