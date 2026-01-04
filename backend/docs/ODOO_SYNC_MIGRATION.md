# OdooSyncService Migration Guide

## Overview

The `OdooSyncService` maintains a MongoDB mirror of frequently-accessed Odoo data. This enables fast queries without hitting the Odoo API, reducing latency and avoiding rate limits.

**Benefits:**
- **10-100x faster queries** - MongoDB queries vs Odoo XML-RPC
- **No rate limiting** - Local database has no API limits
- **Cross-entity lookups** - Join data across models easily
- **Offline resilience** - Queries work even if Odoo is temporarily unavailable

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Agent5 Code   │────▶│  OdooSyncService │────▶│   MongoDB   │
│  (read queries) │     │   (query layer)  │     │   Mirror    │
└─────────────────┘     └──────────────────┘     └─────────────┘
                                                        ▲
                                                        │ Sync
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Agent5 Code   │────▶│ OdooDirectClient │────▶│    Odoo     │
│ (write actions) │     │  (write-through) │     │     API     │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

### Sync Schedule

| Type | Frequency | Purpose |
|------|-----------|---------|
| Incremental | Every 10 min | Sync records changed since last sync |
| Full | Daily at 3 AM | Complete resync to catch drift |
| Write-through | Immediate | Sync after Agent5 writes to Odoo |

## Synced Models

| Odoo Model | MongoDB Collection | Key Fields |
|------------|-------------------|------------|
| `sale.order` | `odoo_orders` | name, clientOrderRef, partnerId, state |
| `res.partner` | `odoo_partners` | name, email, vat, customerRank |
| `product.product` | `odoo_products` | sku, barcode, qtyAvailable |
| `stock.picking` | `odoo_deliveries` | name, origin, state, carrierTrackingRef |
| `account.move` | `odoo_invoices` | name, ref, invoiceOrigin, state |
| `stock.warehouse` | `odoo_warehouses` | code, name |
| `purchase.order` | `odoo_purchase_orders` | name, partnerId, state |

## Migration Patterns

### Pattern 1: Simple Read Query

**Before (Direct Odoo call):**
```javascript
const { OdooDirectClient } = require('./core/agents/integrations/OdooMCP');

async function findOrder(amazonOrderId) {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  const orders = await odoo.searchRead('sale.order',
    [['client_order_ref', '=', amazonOrderId]],
    ['id', 'name', 'state', 'partner_id']
  );
  return orders[0] || null;
}
```

**After (MongoDB mirror):**
```javascript
const { getOdooSyncService } = require('./services/odoo/OdooSyncService');

async function findOrder(amazonOrderId) {
  const syncService = getOdooSyncService();
  return await syncService.findOrderByAmazonId(amazonOrderId);
}
```

### Pattern 2: Product Lookup by SKU

**Before:**
```javascript
const products = await odoo.searchRead('product.product',
  [['default_code', '=', sku]],
  ['id', 'name', 'qty_available', 'list_price']
);
```

**After:**
```javascript
const syncService = getOdooSyncService();
const product = await syncService.findProductBySku(sku);
// Returns: { odooId, name, sku, qtyAvailable, listPrice, ... }
```

### Pattern 3: Custom Query

**Before:**
```javascript
const orders = await odoo.searchRead('sale.order',
  [['state', '=', 'sale'], ['team_id', '=', 11]],
  ['id', 'name', 'amount_total'],
  { limit: 100, order: 'date_order desc' }
);
```

**After:**
```javascript
const syncService = getOdooSyncService();
const orders = await syncService.query('sale.order',
  { state: 'sale', teamId: 11 },
  { limit: 100, sort: { dateOrder: -1 } }
);
```

### Pattern 4: Write-Through (Create/Update)

When Agent5 writes to Odoo, use write-through to immediately update the MongoDB mirror:

**Before:**
```javascript
// Creates in Odoo but MongoDB mirror is stale until next sync
const orderId = await odoo.create('sale.order', orderData);
```

**After:**
```javascript
const syncService = getOdooSyncService();

// Creates in Odoo AND immediately syncs to MongoDB
const { odooId, synced } = await syncService.createAndSync('sale.order', orderData);

// Or for updates:
const updated = await syncService.writeThrough('sale.order', odooId, updateData);
```

### Pattern 5: Fallback to Odoo

For data that must be real-time or isn't synced:

```javascript
const syncService = getOdooSyncService();

// Try MongoDB first, fallback to Odoo if missing
const order = await syncService.getByOdooId('sale.order', odooId, {
  refreshIfMissing: true  // Will fetch from Odoo if not in MongoDB
});
```

## Available Query Methods

### Convenience Methods

```javascript
const syncService = getOdooSyncService();

// Orders
await syncService.findOrderByAmazonId('305-1234567-8901234');

// Partners
await syncService.findPartnerByVat('BE0123456789');

// Products
await syncService.findProductBySku('SKU123');
await syncService.findProductByBarcode('1234567890123');

// Deliveries
await syncService.findDeliveriesBySaleId(odooOrderId);

// Invoices
await syncService.findInvoicesByOrigin('FBA305-1234567-8901234');
```

### Generic Query Methods

```javascript
// Get by Odoo ID
const order = await syncService.getByOdooId('sale.order', 12345);

// Find by any field
const partners = await syncService.findByField('res.partner', 'email', 'test@example.com');

// Custom query with MongoDB filter
const results = await syncService.query('sale.order', {
  state: 'sale',
  dateOrder: { $gte: new Date('2024-01-01') },
  teamId: { $in: [11, 5, 16] }
}, {
  limit: 50,
  sort: { dateOrder: -1 },
  projection: { name: 1, amountTotal: 1, partnerId: 1 }
});

// Count
const count = await syncService.count('sale.order', { state: 'sale' });
```

## Field Name Mapping

Odoo field names are transformed to camelCase in MongoDB:

| Odoo Field | MongoDB Field |
|------------|---------------|
| `client_order_ref` | `clientOrderRef` |
| `partner_id` | `partnerId` / `partnerName` |
| `date_order` | `dateOrder` |
| `amount_total` | `amountTotal` |
| `qty_available` | `qtyAvailable` |
| `write_date` | `writeDate` |

Many-to-one fields (like `partner_id`) are split:
- `partnerId` - The numeric ID
- `partnerName` - The display name

## When to Use Direct Odoo Calls

Still use `OdooDirectClient` for:

1. **Write operations** - Always write to Odoo (use write-through for sync)
2. **Unsyncced models** - Models not in `MODEL_CONFIGS`
3. **Real-time critical data** - When even 10-minute-old data is unacceptable
4. **Complex Odoo operations** - Workflows, actions, computed fields
5. **One-time scripts** - No need to sync for ad-hoc queries

```javascript
// These should still use OdooDirectClient:
await odoo.execute('sale.order', 'action_confirm', [[orderId]]);
await odoo.execute('stock.picking', 'action_done', [[pickingId]]);
```

## Status & Diagnostics

```javascript
const syncService = getOdooSyncService();

// Get sync status for all models
const status = await syncService.getSyncStatus();
// Returns: { 'sale.order': { lastSyncAt, lastSyncCount, totalRecords }, ... }

// Check data freshness
const freshness = await syncService.checkFreshness('sale.order', 60);
// Returns: { total: 50000, stale: 120, fresh: 49880, stalePercentage: '0.2' }
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/odoo-sync/status` | GET | Get sync status for all models |
| `/api/odoo-sync/trigger` | POST | Trigger manual sync (`{ type: 'incremental' | 'full' }`) |

## Adding New Models

To sync additional Odoo models, add configuration to `MODEL_CONFIGS` in `OdooSyncService.js`:

```javascript
'model.name': {
  collection: 'odoo_collection_name',
  fields: ['id', 'name', 'field1', 'field2', 'write_date'],
  indexes: [
    { key: { odooId: 1 }, unique: true },
    { key: { fieldName: 1 } }
  ],
  transform: (record) => ({
    odooId: record.id,
    name: record.name,
    // Transform Odoo fields to MongoDB fields
    writeDate: record.write_date ? new Date(record.write_date) : null
  })
}
```

## Best Practices

1. **Always use the singleton**: `getOdooSyncService()` returns a singleton instance
2. **Prefer convenience methods**: Use `findOrderByAmazonId()` over raw queries
3. **Use write-through for writes**: Keeps MongoDB in sync immediately
4. **Check field names**: Remember to use camelCase MongoDB field names
5. **Handle missing data**: Use `refreshIfMissing: true` for critical lookups
6. **Don't sync everything**: Only sync frequently-queried data
