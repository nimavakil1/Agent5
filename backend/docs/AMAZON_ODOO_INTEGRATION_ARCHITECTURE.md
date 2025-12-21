# Amazon ↔ Odoo Integration Architecture

## Overview

This document describes the complete integration replacing the €1000/year Odoo module.

---

## 1. Current Odoo Setup

### 1.1 Multi-VAT Journals

You have VAT registrations in multiple EU countries. Each has a dedicated invoice journal:

| Journal Code | Country | VAT Rate | When to Use |
|--------------|---------|----------|-------------|
| VBE | Belgium | 21% | Ship FROM Belgium |
| VDE | Germany | 19% | Ship FROM Germany |
| VNL | Netherlands | 21% | Ship FROM Netherlands |
| VIT | Italy | 22% | Ship FROM Italy |
| VFR | France | 20% | Ship FROM France |
| VGB | UK | 20% | Ship FROM UK |
| VOS | OSS | Varies | B2C cross-border within EU |

### 1.2 FBA Warehouses

| Code | Warehouse | Marketplace |
|------|-----------|-------------|
| de1 | FBA Amazon.de | Germany |
| fr1 | FBA Amazon.fr | France |
| it1 | FBA Amazon.it | Italy |
| es1 | FBA Amazon.es | Spain |
| nl1 | FBA Amazon.nl | Netherlands |
| be1 | FBA Amazon.com.be | Belgium |
| pl1 | FBA Amazon.pl | Poland |
| uk1 | FBA Amazon.co.uk | UK |
| se1 | FBA Amazon.se | Sweden |
| tr1 | FBA Amazon.com.tr | Turkey |

### 1.3 Generic B2C Customers

| Customer | Country | Use |
|----------|---------|-----|
| Generic Customer DE | Germany | B2C German sales |
| Generic Customer FR | France | B2C French sales |
| Generic Customer NL | Netherlands | B2C Dutch sales |
| (more to be added) | | |

### 1.4 Fiscal Positions

| Pattern | Use Case |
|---------|----------|
| XX*VAT \| Régime National | Domestic B2C sales (local VAT) |
| XX*VAT \| Régime Intra-Communautaire | B2B with VAT number (0% reverse charge) |
| XX*OSS \| B2C Country | B2C cross-border (OSS scheme) |

---

## 2. Data Flows

### 2.1 Orders Import (Amazon → Odoo)

```
┌─────────────────────────────────────────────────────────────┐
│ Make.com: Every 15 minutes                                  │
│ Amazon Seller Central → getOrders API                       │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent5: POST /api/amazon/sync/orders                        │
│                                                             │
│ For each order:                                             │
│ 1. Check if exists (by AmazonOrderId)                       │
│ 2. Map SKU → Odoo product (via mapping table)               │
│ 3. Determine warehouse:                                     │
│    - FBA: Use FBA warehouse based on FC (e.g., de1 for DE)  │
│    - FBM: Use Central Warehouse (CW)                        │
│ 4. Create Sale Order:                                       │
│    - Name: FBA/FBM + OrderId (e.g., FBA304-1234567-8901234) │
│    - Partner: Amazon Business EU SARL                       │
│    - client_order_ref: Amazon Order ID                      │
│    - Warehouse: Based on fulfillment                        │
│ 5. Confirm order if shipped                                 │
│ 6. Store in MongoDB for reference                           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 VCS Invoice Import (Amazon → Odoo)

```
┌─────────────────────────────────────────────────────────────┐
│ Make.com: Every 2-4 hours                                   │
│ Request: GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT              │
│ Download: Parse CSV/TSV                                     │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent5: POST /api/amazon/sync/vcs-invoices                  │
│                                                             │
│ For each VCS invoice record:                                │
│ 1. Find Sale Order by Amazon Order ID                       │
│ 2. Determine Invoice Journal:                               │
│    - ship-from-country → Journal mapping                    │
│    - DE → VDE, FR → VFR, etc.                               │
│ 3. Determine Fiscal Position:                               │
│    - B2C without VAT → XX*VAT | Régime National             │
│    - B2B with VAT → XX*VAT | Régime Intra-Communautaire     │
│    - Cross-border B2C → XX*OSS | B2C Country                │
│ 4. Find or Create Customer:                                 │
│    - B2C: Use generic customer OR create from VCS data      │
│    - B2B: Find by VAT number or create new partner          │
│ 5. Create Invoice:                                          │
│    - Copy lines from Sale Order                             │
│    - Apply VCS prices/taxes                                 │
│    - Set Amazon invoice number in reference                 │
│ 6. Link Invoice to Sale Order                               │
│ 7. Update Sale Order: x_invoiced_qty                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 FBM Stock Sync (Odoo → Amazon)

```
┌─────────────────────────────────────────────────────────────┐
│ Trigger: Every 30 minutes OR stock change webhook           │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent5: GET /api/amazon/sync/stock-levels                   │
│                                                             │
│ 1. Get all products with Amazon SKU                         │
│ 2. Get available stock from Central Warehouse (FBM)         │
│ 3. Subtract reserved qty for other channels                 │
│ 4. Return SKU → Quantity mapping                            │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Make.com: Submit Inventory Feed                             │
│ POST /feeds/2021-06-30/feeds                                │
│ feedType: POST_INVENTORY_AVAILABILITY_DATA                  │
│                                                             │
│ Feed XML:                                                   │
│ <Message>                                                   │
│   <SKU>YOUR-SKU</SKU>                                       │
│   <Quantity>50</Quantity>                                   │
│ </Message>                                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 FBM Tracking Sync (Odoo → Amazon)

```
┌─────────────────────────────────────────────────────────────┐
│ Trigger: Delivery validated in Odoo (webhook or scheduled)  │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent5: GET /api/amazon/sync/pending-shipments              │
│                                                             │
│ 1. Find FBM Sale Orders with:                               │
│    - Delivery validated                                     │
│    - updated_in_amazon = False                              │
│ 2. Get tracking info from stock.picking                     │
│ 3. Return order list with tracking                          │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Make.com: Confirm Shipment                                  │
│ POST /orders/v0/orders/{orderId}/shipment                   │
│                                                             │
│ Body:                                                       │
│ {                                                           │
│   "marketplaceId": "A1PA6795UKMFR9",                        │
│   "shipmentConfirmation": {                                 │
│     "carrierName": "DHL",                                   │
│     "trackingNumber": "1234567890"                          │
│   }                                                         │
│ }                                                           │
│                                                             │
│ Then update Odoo: updated_in_amazon = True                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.5 FBA Inventory Reconciliation (Amazon ↔ Odoo)

```
┌─────────────────────────────────────────────────────────────┐
│ Make.com: Every hour                                        │
│ GET /fba/inventory/v1/summaries                             │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent5: POST /api/amazon/sync/fba-inventory                 │
│                                                             │
│ For each SKU in FBA inventory:                              │
│ 1. Get Amazon sellable quantity                             │
│ 2. Get Odoo quantity in FBA warehouse (de1, fr1, etc.)      │
│ 3. Compare:                                                 │
│    - If different by > threshold:                           │
│      - Log discrepancy                                      │
│      - Option A: Auto-adjust Odoo stock                     │
│      - Option B: Flag for review                            │
│ 4. Store snapshot in MongoDB                                │
│                                                             │
│ Adjustment types:                                           │
│ - Positive: Amazon has more → Odoo adjustment IN            │
│ - Negative: Amazon has less → Odoo adjustment OUT           │
│   (possible reasons: damage, lost, returns not processed)   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Journal Selection Logic

The key decision for VCS invoices is which journal to use:

```javascript
function getJournalForInvoice(vcsData) {
  // ship-from-country determines VAT registration
  const shipFromCountry = vcsData.shipFromCountry;

  const journalMap = {
    'BE': 'VBE',
    'DE': 'VDE',
    'FR': 'VFR',
    'NL': 'VNL',
    'IT': 'VIT',
    'GB': 'VGB',
    'ES': 'VES', // if exists
    'PL': 'VPL', // if exists
  };

  // For countries without dedicated journal, use OSS
  return journalMap[shipFromCountry] || 'VOS';
}
```

---

## 4. Fiscal Position Logic

```javascript
function getFiscalPosition(vcsData) {
  const shipFromCountry = vcsData.shipFromCountry;
  const customerCountry = vcsData.buyerCountry;
  const hasVatNumber = !!vcsData.buyerVatNumber;

  // B2B with VAT number
  if (hasVatNumber) {
    return `${shipFromCountry}*VAT | Régime Intra-Communautaire`;
  }

  // B2C same country (domestic)
  if (shipFromCountry === customerCountry) {
    return `${shipFromCountry}*VAT | Régime National`;
  }

  // B2C cross-border (OSS)
  return `${customerCountry}*OSS | B2C ${getCountryName(customerCountry)}`;
}
```

---

## 5. Required Data Tables

### 5.1 ASIN ↔ SKU Mapping (MongoDB)

```javascript
// Collection: amazon_product_mapping
{
  asin: "B00ABC123",
  sku: "SELLER-SKU-001",
  marketplace: "A1PA6795UKMFR9", // DE marketplace
  odooProductId: 12345,
  odooDefaultCode: "ACROPAQ-001",
  active: true,
  updatedAt: ISODate("2025-01-15")
}
```

### 5.2 Marketplace Configuration

```javascript
// Collection: amazon_marketplaces
{
  marketplaceId: "A1PA6795UKMFR9",
  country: "DE",
  name: "Amazon.de",
  journalCode: "VDE",
  fbaWarehouseCode: "de1",
  genericCustomerId: 12345, // Odoo partner ID
  fiscalPositionDomestic: "DE*VAT | Régime National",
  fiscalPositionOSS: "DE*OSS | B2C Germany",
  currency: "EUR"
}
```

---

## 6. API Endpoints to Build

### Orders & Invoices
- `POST /api/amazon/sync/orders` - Process incoming orders
- `POST /api/amazon/sync/vcs-invoices` - Process VCS invoice data
- `GET /api/amazon/orders` - List synced orders
- `GET /api/amazon/invoices` - List synced invoices

### Inventory
- `GET /api/amazon/sync/stock-levels` - Get FBM stock for Amazon feed
- `POST /api/amazon/sync/fba-inventory` - Process FBA inventory data
- `GET /api/amazon/inventory/discrepancies` - List FBA stock discrepancies

### Fulfillment
- `GET /api/amazon/sync/pending-shipments` - Get FBM orders to confirm
- `POST /api/amazon/sync/confirm-shipment` - Mark order as shipped

### Configuration
- `GET /api/amazon/config/marketplaces` - List marketplace configs
- `POST /api/amazon/config/product-mapping` - Upload ASIN↔SKU mapping
- `GET /api/amazon/config/product-mapping` - Get mapping

---

## 7. Make.com Scenarios

| Scenario | Trigger | Frequency | Flow |
|----------|---------|-----------|------|
| Orders Sync | Schedule | 15 min | Amazon Orders API → Agent5 → Odoo |
| VCS Invoice Sync | Schedule | 2 hours | Amazon Reports API → Agent5 → Odoo |
| FBM Stock Update | Schedule | 30 min | Agent5 → Amazon Feeds API |
| FBM Tracking Sync | Schedule | 30 min | Agent5 → Amazon Orders API |
| FBA Inventory Sync | Schedule | 1 hour | Amazon FBA Inventory API → Agent5 → Odoo |
| Financial Events | Schedule | 4 hours | Amazon Finances API → Agent5 → MongoDB |

---

## 8. Error Handling

### 8.1 Error Types

| Error | Detection | Resolution |
|-------|-----------|------------|
| Unknown SKU | ASIN not in mapping | Flag, add to review queue |
| Missing product | SKU not found in Odoo | Flag, notify user |
| Duplicate order | Order ID already exists | Skip, log warning |
| Tax mismatch | VCS tax ≠ expected | Flag for review |
| Stock discrepancy | FBA ≠ Odoo by >10% | Flag, create adjustment |
| Invoice already exists | Invoice # exists | Skip, log |

### 8.2 Review Queue

Store errors for manual review:

```javascript
// Collection: amazon_sync_errors
{
  type: "unknown_sku",
  amazonOrderId: "304-1234567-8901234",
  data: { asin: "B00XYZ123", sku: "UNKNOWN-SKU" },
  status: "pending", // pending | resolved | ignored
  createdAt: ISODate("2025-01-15"),
  resolvedAt: null,
  resolution: null
}
```

---

## 9. Implementation Order

### Phase 1: Foundation
1. Create product mapping collection and import endpoint
2. Create marketplace configuration
3. Build ASIN → Product lookup service

### Phase 2: Orders
4. Build orders sync endpoint
5. Create Make.com orders scenario
6. Test with real orders

### Phase 3: Invoices
7. Build VCS invoice parser
8. Build invoice creation with journal/fiscal position logic
9. Create Make.com VCS scenario
10. Test invoice linking

### Phase 4: Stock
11. Build FBM stock query endpoint
12. Create Make.com stock feed scenario
13. Build FBA inventory reconciliation
14. Create Make.com FBA sync scenario

### Phase 5: Fulfillment
15. Build pending shipments query
16. Create Make.com tracking scenario
17. Test end-to-end FBM flow

---

## 10. Next Steps

1. **User provides**: ASIN↔SKU mapping file per marketplace
2. **User confirms**: Generic B2C customers for each country
3. **We build**: Product mapping import and lookup
4. **We build**: Orders sync endpoint
5. **We test**: With a few real orders
