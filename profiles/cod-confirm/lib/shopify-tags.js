/**
 * Shopify tag writeback — the COD-confirm profile's outcome side effect.
 *
 * The 4 terminal tools (confirm_order, cancel_order, request_human_agent,
 * request_callback) all converge here: read existing tags + note, append,
 * write back via GraphQL. The append (not replace) behaviour is critical —
 * an earlier version wiped existing tags when the read failed silently
 * (see issue #12). This version aborts on any read failure rather than
 * proceeding with empty fallbacks.
 *
 * Profile-local because the *fact* that a successful tool call writes a
 * Shopify tag is COD-confirm-specific. An appointment-remind profile would
 * write to Google Calendar instead; a lead-qualify profile would write to a
 * CRM. The engine knows nothing about Shopify.
 */
import { fetchWithTimeout } from '../../../src/lib/fetch.js';

export async function updateOrderTag(prisma, { shop, orderId, tag, note }) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) throw new Error(`No offline Shopify session for ${shop} — tag writeback failed`);

  const gid = `gid://shopify/Order/${orderId}`;
  const mutation = `mutation($id: ID!, $tags: [String!]!, $note: String) {
    orderUpdate(input: { id: $id, tags: $tags, note: $note }) {
      order { id tags }
      userErrors { field message }
    }
  }`;

  // Fetch current tags/note to append (not replace). If this read fails or
  // comes back malformed, ABORT — do not proceed to orderUpdate with empty
  // fallbacks, because the subsequent write would wipe the existing tags/note
  // (issue #12).
  const currResp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ order(id: "${gid}") { id tags note } }` }),
  });
  if (!currResp.ok) {
    throw new Error(`Shopify current-order read failed: HTTP ${currResp.status}`);
  }
  let curr;
  try {
    curr = await currResp.json();
  } catch (err) {
    throw new Error(`Shopify current-order read returned non-JSON: ${err.message}`);
  }
  if (curr?.errors?.length) {
    throw new Error('Shopify current-order read errors: ' + curr.errors.map(e => e.message).join('; '));
  }
  if (!curr?.data?.order) {
    throw new Error(`Shopify current-order read returned no order for ${gid}`);
  }
  const existingTags = curr.data.order.tags || [];
  const existingNote = curr.data.order.note || '';
  const newTags = [...new Set([...existingTags, tag])];
  const newNote = [existingNote, note].filter(Boolean).join('\n\n').trim();

  const resp = await fetchWithTimeout(`https://${shop}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': session.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables: { id: gid, tags: newTags, note: newNote } }),
  });
  if (!resp.ok) {
    throw new Error(`Shopify orderUpdate failed: HTTP ${resp.status}`);
  }
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`Shopify orderUpdate returned non-JSON: ${err.message}`);
  }
  if (data.errors?.length) {
    const errStr = data.errors.map(e => e.extensions?.code === 'ACCESS_DENIED'
      ? `ACCESS_DENIED (need ${e.extensions?.requiredAccess})`
      : e.message).join('; ');
    throw new Error(`Shopify API error: ${errStr}`);
  }
  if (data.data?.orderUpdate?.userErrors?.length) {
    throw new Error('userErrors: ' + JSON.stringify(data.data.orderUpdate.userErrors));
  }
  console.log(`[shopify] ${gid} ✓ tagged ${tag}`);
}
