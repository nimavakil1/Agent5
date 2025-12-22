# Amazon Integration - Master Status & Development Plan

**Last Updated:** December 22, 2025

---

## Current Status Overview

| Module | Status | Method | Notes |
|--------|--------|--------|-------|
| Order Import | ✅ DONE | Make.com | Syncs orders to Odoo |
| VCS Invoices | ✅ DONE | Agent5 Tool | Creates invoices with correct OSS taxes |
| VCS Refunds | ✅ DONE | Agent5 Tool | Handles REFUND transaction types |
| Settlement Reports | ❌ TODO | Manual Upload + Agent5 | No SP-API access - manual CSV upload |
| Amazon Fee Invoices | ❌ TODO | PEPPOL + Agent5 | PEPPOL coming soon - auto-process invoices |
| FBA Inventory Sync | ❌ TODO | Agent5 Tool | Needs UI development |
| Inbound Shipments | ❌ TODO | Agent5 Tool | Needs full workflow design |
| Ratings/Reviews | ❌ TODO | Agent5 Tool | Research seller reviews |
| Cancel Orders Sync | ❌ TODO | Agent5 Tool | Sync cancelled orders |
| FBM Stock Export | ❌ TODO | Agent5 Tool | Export CW stock to Amazon |
| Tracking Update (FBM) | ❌ TODO | Agent5 Tool | Send tracking to Amazon |

---

## Module Details

### 1. Order Import ✅ DONE
- **Method:** Make.com scenario
- **Trigger:** Every 15 minutes
- **Flow:** Amazon Orders API → Odoo Sale Orders
- **Status:** Operational

### 2. VCS Tax Report Processing ✅ DONE
- **Method:** Agent5 `VcsTaxReportParser.js` + `VcsOdooInvoicer.js`
- **Features:**
  - Parses VCS CSV report
  - Creates invoices with correct OSS tax rates
  - Handles multiple tax schemes (OSS, DEEMED_RESELLER, etc.)
  - Matches SKUs using progressive stripping
  - Rate limiting (150ms) to prevent Odoo overload
  - Duplicate detection (checks FBA/FBM prefix variants)
- **UI:** `/app/amazon-vcs.html`

### 3. VCS Refunds ✅ DONE
- **Method:** Part of VCS processing
- **Transaction Type:** REFUND
- **Creates:** Credit notes in Odoo

### 4. Settlement Reports & Amazon Fee Invoices ❌ TODO
- **Method:** Manual upload (NO Make.com - requires SP-API developer account we don't have)
- **UI:** Upload settlement CSV in Agent5
- **Process:**
  1. User downloads settlement report from Seller Central
  2. Uploads to Agent5 UI
  3. Agent5 parses CSV
  4. Matches with Amazon fee invoices
  5. Reconciles with bank payment

#### Amazon Fee Invoices (PEPPOL Integration)
- **IMPORTANT:** PEPPOL activating in Belgium in days!
- **Flow after PEPPOL:**
  1. Amazon fee invoices arrive automatically in Odoo via PEPPOL
  2. Agent5 processes incoming invoices:
     - Detect Amazon invoices (by VAT number/partner)
     - Set correct journal
     - Map lines to correct expense accounts
     - Attach PDF invoice to the vendor bill record
  3. Upload settlement report to Agent5
  4. Agent5 reconciles:
     - Match fee invoices to settlement
     - Match bank payment to settlement total
     - Generate reconciliation report

- **What's in Settlement:**
  - Amazon fees (referral, FBA, storage)
  - Refunds and adjustments
  - Advertising fees
  - Net payment amount
- **Action Required:**
  - Build settlement report parser
  - Build Amazon PEPPOL invoice processor
  - Build reconciliation logic

### 5. FBA Inventory Sync ❌ TODO
- **Purpose:** Track what's in Amazon FBA warehouses
- **Data Source:** `GET_AFN_INVENTORY_DATA` report
- **Features Needed:**
  - Dashboard showing FBA stock levels
  - Sync to Odoo "Amazon FBA" warehouse
  - Low stock alerts
  - Historical tracking
  - Error reporting
- **Priority:** HIGH (needed for forecasting)

### 6. Inbound Shipments ❌ TODO
- **Purpose:** Manage FBA replenishment shipments
- **Amazon API:** FBA Inbound Eligibility + Fulfillment Inbound v2024
- **Workflow:**
  1. Create shipment plan (select products, quantities)
  2. Submit to Amazon for validation
  3. Get shipping labels from Amazon
  4. Print box labels and shipping labels
  5. Track shipment status
  6. Receive confirmation from Amazon
- **Features Needed:**
  - UI to create new shipments
  - Integration with Odoo transfers
  - Label generation
  - Status tracking dashboard
- **Priority:** HIGH (core FBA operation)
- **Note:** Amazon has new 2024 Inbound API - need to research

### 7. Ratings/Reviews ❌ TODO
- **Product Reviews:** Available via SP-API
- **Seller Feedback:** Available via SP-API (Seller Feedback API)
- **Features Needed:**
  - Import product reviews
  - Import seller feedback ratings
  - Dashboard to monitor ratings
  - Alerts for negative reviews
- **Priority:** MEDIUM

### 8. Cancel Orders Sync ❌ TODO
- **Purpose:** Sync cancelled Amazon orders to Odoo
- **Trigger:** Scheduled check or webhook
- **Actions:**
  - Cancel Odoo sale order
  - Reverse any created invoices
  - Update stock if reserved
- **Priority:** MEDIUM

### 9. FBM Stock Export ❌ TODO
- **Purpose:** Keep Amazon FBM listings in sync with CW warehouse
- **Flow:** Odoo CW Stock → Amazon Inventory Feed
- **Features Needed:**
  - Calculate available FBM quantity
  - Apply buffer/reserve logic
  - Send XML feed to Amazon
  - Track feed status
- **Priority:** HIGH (if selling FBM)

### 10. Tracking Update (FBM) ❌ TODO
- **Purpose:** Send tracking numbers to Amazon for FBM orders
- **Trigger:** When delivery is validated in Odoo
- **Flow:**
  1. Detect completed FBM delivery
  2. Extract tracking number and carrier
  3. Send shipment confirmation to Amazon
- **Priority:** HIGH (if selling FBM)

---

## Development Priority Queue

### Phase 1: Complete Current Work (December 2025)
1. ✅ VCS Invoice creation - DONE
2. ⏳ Pull rate limiting + duplicate check to server
3. 🔲 Update invoices with VCS invoice_url field

### Phase 2: Settlement & PEPPOL (Q1 2026)
4. Settlement Report parser (manual CSV upload)
5. Amazon PEPPOL invoice processor (when PEPPOL activates)
6. Settlement reconciliation with bank payments

### Phase 3: Core FBA Operations (Q1 2026)
7. FBA Inventory Sync with UI
8. Inbound Shipments Workflow (research 2024 API first)
9. FBM Stock Export (if needed)

### Phase 4: Order Management (Q1 2026)
10. Cancel Orders Sync
11. Tracking Update for FBM

### Phase 5: Analytics & Monitoring (Q2 2026)
12. Ratings/Reviews Import
13. Margin Analytics Dashboard

---

## Technical Notes

### Odoo.sh Code Access
```bash
# Clone from GitHub
git clone https://github.com/ninicocolala/acropaq /tmp/acropaq-odoo

# Switch to correct branch (modules on STG08052025, not main)
cd /tmp/acropaq-odoo && git checkout STG08052025

# Amazon EPT connector location
/tmp/acropaq-odoo/amazon_ept/
```

### Key Odoo Fields (from Amazon EPT)
```
account.move:
  - invoice_url: VCS invoice URL
  - vcs_invoice_number: VCS invoice number
  - amazon_instance_id: Marketplace
  - amz_fulfillment_by: FBA/FBM

sale.order:
  - amz_order_reference: Amazon Order ID
  - amz_instance_id: Marketplace
  - amz_fulfillment_by: FBA/FBM
```

### Amazon Products in Odoo
Special products for Amazon operations:
- `product_product_amazon_shipping_ept` - Shipping fees
- `product_product_amazon_giftwrapper_fee` - Gift wrapper
- `product_product_amazon_promotion_discount` - Promo discounts
- `product_product_amazon_shipment_discount` - Ship discounts

### Agent5 Amazon Services
```
/src/services/amazon/
  - VcsTaxReportParser.js    - Parse VCS CSV
  - VcsOdooInvoicer.js       - Create invoices in Odoo
  - VcsOrderCreator.js       - Create orders in Odoo
  - FbaInventoryReportParser.js - Parse FBA inventory
  - ReturnsReportParser.js   - Parse returns report
```

---

## Questions to Resolve

1. **Settlement Reports:**
   - Do we need to create vendor invoices for Amazon fees?
   - How should we reconcile the bank payment?

2. **FBA Inventory:**
   - Which Odoo warehouse should represent Amazon FBA?
   - How often should we sync?

3. **Inbound Shipments:**
   - Do you use Amazon partnered carrier or own carrier?
   - Need to research new 2024 Inbound API workflow

4. **FBM Stock:**
   - What's the buffer between Odoo stock and Amazon available?
   - Which warehouses feed FBM availability?
