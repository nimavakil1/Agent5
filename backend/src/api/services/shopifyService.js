
// Admin REST helper using Admin API access token
function shopifyAdminBase() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '');
  if (!domain) throw new Error('SHOPIFY_STORE_DOMAIN not set');
  const version = process.env.SHOPIFY_API_VERSION || '2024-07';
  const base = `https://${domain}/admin/api/${version}`;
  return base;
}

function adminHeaders() {
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!token) throw new Error('SHOPIFY_ADMIN_ACCESS_TOKEN not set');
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  };
}

function logDebug(label, payload) {
  if (process.env.DEBUG_SHOPIFY === '1') {
    try {
      const safe = typeof payload === 'string' ? payload : JSON.stringify(payload);
      console.log(`[shopify] ${label}:`, safe.slice(0, 2000));
    } catch (_) {}
  }
}

async function adminFetch(path, options = {}) {
  const url = `${shopifyAdminBase()}${path}`;
  const reqInit = { headers: { ...adminHeaders(), ...(options.headers || {}) }, method: options.method || 'GET', body: options.body ? JSON.stringify(options.body) : undefined };
  logDebug('Admin REST request', { url, method: reqInit.method, body: reqInit.body });
  const res = await fetch(url, reqInit);
  logDebug('Admin REST response status', `${res.status} ${res.statusText}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Shopify API ${res.status} ${res.statusText}: ${txt}`);
  }
  const json = await res.json();
  logDebug('Admin REST response json', json);
  return json;
}

// Admin GraphQL for reliable SKU search
function shopifyAdminGraphQLEndpoint() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '');
  if (!domain) throw new Error('SHOPIFY_STORE_DOMAIN not set');
  const version = process.env.SHOPIFY_API_VERSION || '2024-07';
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

async function adminGraphQL(query, variables = {}) {
  const url = shopifyAdminGraphQLEndpoint();
  const req = { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ query, variables }) };
  logDebug('Admin GQL request', { url, query, variables });
  const res = await fetch(url, req);
  logDebug('Admin GQL response status', `${res.status} ${res.statusText}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Shopify Admin GQL ${res.status} ${res.statusText}: ${txt}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify Admin GQL errors: ${JSON.stringify(json.errors)}`);
  logDebug('Admin GQL response json', json);
  return json.data;
}

function fromGid(gid) {
  const m = String(gid || '').match(/ProductVariant\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function getVariantIdBySku(sku) {
  const query = `#graphql
    query Vars($q: String!) {
      productVariants(first: 10, query: $q) {
        edges { node { id sku title product { id title status } } }
      }
    }
  `;
  const data = await adminGraphQL(query, { q: `sku:${JSON.stringify(String(sku))}` });
  const edges = data?.productVariants?.edges || [];
  if (!edges.length) throw new Error(`Variant not found for SKU ${sku}`);
  // Find exact SKU match first
  const exact = edges.map(e=>e.node).find(n => (n.sku || '').toString().trim().toLowerCase() === String(sku).trim().toLowerCase());
  const node = exact || edges[0].node;
  const id = fromGid(node.id);
  if (!id) throw new Error(`Could not parse variant id for SKU ${sku}`);
  return id;
}

async function createPrefilledCartLink(products) {
  try {
    // This is a simplified example. In a real application, you would
    // fetch product IDs from Shopify based on product names or SKUs,
    // and then construct the cart link.

    // Assuming 'products' is an array of objects like { variant_id: '123', quantity: 1 }
    // Or, if products are just names, you'd need to look them up first.

    // For demonstration, let's assume we have product IDs/variant IDs
    // and quantities to construct a basic cart link.

    // Example: https://your-store.myshopify.com/cart/add?id=VARIANT_ID&quantity=QUANTITY
    // For multiple items: /cart/VARIANT_ID:QUANTITY,VARIANT_ID:QUANTITY

    const storeUrl = process.env.SHOPIFY_STORE_URL || (process.env.SHOPIFY_STORE_DOMAIN ? `https://${process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//,'')}` : ''); // e.g., https://your-store.myshopify.com

    if (!storeUrl) {
      throw new Error('Shopify store URL is not configured.');
    }

    let cartItems = '';
    if (products && products.length > 0) {
      // Support either variant_id provided or sku
      const items = [];
      for (const p of products) {
        const qty = Number(p.quantity || 1) || 1;
        const variantId = p.variant_id ? p.variant_id : (p.sku ? await getVariantIdBySku(p.sku) : null);
        if (!variantId) throw new Error('Each product must include variant_id or sku');
        items.push(`${variantId}:${qty}`);
      }
      cartItems = items.join(',');
    }

    const cartLink = `${storeUrl}/cart/${cartItems}`;

    return cartLink;
  } catch (error) {
    console.error('Error creating prefilled cart link:', error);
    throw error;
  }
}

module.exports = {
  createPrefilledCartLink,
  getVariantIdBySku,
  adminFetch,
};

// ---------- Storefront API (Checkout) ----------

function storefrontBase() {
  const domain = (process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '');
  if (!domain) throw new Error('SHOPIFY_STORE_DOMAIN not set');
  const version = process.env.SHOPIFY_API_VERSION || '2024-07';
  return `https://${domain}/api/${version}/graphql.json`;
}

function storefrontHeaders() {
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  if (!token) throw new Error('SHOPIFY_STOREFRONT_ACCESS_TOKEN not set');
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Storefront-Access-Token': token,
  };
}

async function storefrontGraphQL(query, variables = {}) {
  const resInit = {
    method: 'POST',
    headers: storefrontHeaders(),
    body: JSON.stringify({ query, variables }),
  };
  logDebug('Storefront request', { url: storefrontBase(), query, variables });
  const res = await fetch(storefrontBase(), resInit);
  logDebug('Storefront response status', `${res.status} ${res.statusText}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Storefront ${res.status} ${res.statusText}: ${txt}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Storefront GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  logDebug('Storefront response json', json);
  return json.data;
}

function toVariantGid(id) {
  // Accept numeric id or gid; return gid format
  const s = String(id);
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/ProductVariant/${s}`;
}

async function createCheckoutWebUrl(items = [], discountCode = '') {
  // Use Storefront Cart API (modern) to get checkoutUrl
  if (!Array.isArray(items) || items.length === 0) throw new Error('items required');
  const lines = [];
  for (const it of items) {
    const qty = Number(it.quantity || 1) || 1;
    let vid = it.variant_id;
    if (!vid && it.sku) {
      const numeric = await getVariantIdBySku(it.sku);
      vid = numeric;
    }
    if (!vid) throw new Error('Each item must include variant_id or sku');
    lines.push({ quantity: qty, merchandiseId: toVariantGid(vid) });
  }

  const mutation = `#graphql
    mutation CartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { id checkoutUrl }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    input: {
      lines,
      discountCodes: discountCode ? [discountCode] : [],
    },
  };
  const data = await storefrontGraphQL(mutation, variables);
  const out = data.cartCreate;
  const errs = out?.userErrors || [];
  if (errs.length) throw new Error('cartCreate userErrors: ' + JSON.stringify(errs));
  const url = out?.cart?.checkoutUrl;
  if (!url) throw new Error('No checkoutUrl returned');
  return url;
}

module.exports.createCheckoutWebUrl = createCheckoutWebUrl;
