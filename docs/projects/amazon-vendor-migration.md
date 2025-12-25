# Amazon Vendor Module Migration

**Project:** Migrate Amazon Vendor functionality from Odoo to Agent5 AI Platform
**Status:** Planning (Analysis Phase Complete)
**Created:** 2024-12-23
**Last Updated:** 2024-12-23

---

## Overview

Migrate the Amazon Vendor (Emipro/EPT) module from Odoo 16 to Agent5, allowing complete independence from third-party Odoo modules. Once migrated, the module can be uninstalled from Odoo.

---

## Current State in Odoo

### Odoo.sh Access
- **Platform:** Odoo.sh
- **Version:** Odoo 16
- **Database:** `ninicocolala-v16-fvl-fvl-7662670`
- **GitHub Repo:** `https://github.com/ninicocolala/acropaq` (branch: `acr_prd`)
- **Module:** Amazon EPT (Emipro)

### Installed Modules (Emipro)

| Module | Version | Description | Price |
|--------|---------|-------------|-------|
| `amazon_ept` | 16.0.1.2.37 | Amazon Odoo Connector | €479 |
| `amazon_vendor_central_ept` | 16.0.0.0.1 | Amazon Vendor Central | Included |
| `common_connector_library` | - | Shared library | Dependency |

### Dependencies
- `common_connector_library` - Shared connector utilities
- `iap` - Odoo IAP for API communication
- `rating` - Customer ratings

---

## Source Code Analysis (from GitHub)

### Module: amazon_ept (Seller Central)

**Path:** `/amazon_ept/`

**64 Model Files:**
- `amazon_seller.py` - Seller account configuration
- `instance.py` - Marketplace instances
- `product.py` - Product mappings
- `sale_order.py` - Sales order integration
- `account_move.py` - Invoice integration with VCS
- `vcs_tax_report_ept.py` - VCS report processing
- `settlement_report.py` - Settlement reconciliation
- `shipping_report.py` - Shipping reports
- `amazon_fba_live_stock_report_ept.py` - FBA inventory
- `removal_order.py` - FBA removal orders
- `stock_adjustment_report.py` - Stock adjustments

**Key account.move Fields (Invoices):**
```python
amazon_instance_id = fields.Many2one("amazon.instance.ept")
seller_id = fields.Many2one("amazon.seller.ept")
amz_fulfillment_by = fields.Selection([('FBA', 'FBA'), ('FBM', 'FBM')])
amz_sale_order_id = fields.Many2one("sale.order")
invoice_url = fields.Char()  # VCS PDF URL
vcs_invoice_number = fields.Char()  # VCS invoice reference
invoice_sent = fields.Boolean()  # Sent to Amazon flag
ship_city, ship_postal_code, ship_state_id, ship_country_id
bill_city, bill_postal_code, bill_state_id, bill_country_id
```

**VCS Processing Logic (`vcs_tax_report_ept.py`):**
1. Download encrypted VCS report from Amazon
2. Decode via Emipro IAP service
3. Parse CSV with DictReader
4. Match orders by `amz_order_reference`
5. Update invoices with `invoice_url` and `vcs_invoice_number`

### Module: amazon_vendor_central_ept (Vendor Central)

**Path:** `/amazon_vendor_central_ept/`

**16 Model Files:**
- `amazon_vendor_instance.py` - Vendor account configuration
- `amazon_vendor_sale_requisition.py` - Purchase orders from Amazon
- `amazon_vendor_sale_requisition_line.py` - PO line items
- `sale_order.py` - Order linking
- `account_move.py` - Invoice submission to Amazon
- `stock_picking.py` - Shipment handling
- `amazon_vendor_data_queue.py` - Order import queue

**Vendor Instance Configuration:**
```python
vendor_name = fields.Char(required=True)
vendor_code = fields.Char(required=True)
selling_party_id = fields.Char()
warehouse_id = fields.Many2one("stock.warehouse")
region = fields.Selection([('india', 'India'), ('europe', 'Europe'), ('north_america', 'North America')])
pricelist_id = fields.Many2one('product.pricelist')
delivery_type = fields.Selection([('we_pay', 'We Pay'), ('we_not_pay', 'We not Pay')])
is_auto_confirm_order = fields.Boolean()
```

**Vendor Requisition (Purchase Order) States:**
```python
STATES = [('new', 'New'), ('acknowledged', 'Acknowledged'), ('closed', 'Closed')]
PURCHASE_ORDER_TYPE = [('regularorder', 'Regular Order'), ('consignedorder', 'Consigned Order'),
                        ('newproductintroduction', 'New Product Introduction'), ('rushorder', 'Rush Order')]
```

**Invoice Submission to Amazon (account_move.py):**
- Prepare invoice JSON with remit_to_party, ship_to_party, bill_to_party
- Submit via Emipro IAP to Amazon Vendor API
- Track with `is_invoice_submitted` flag

---

## What Already Exists in Agent5

### VCS Tax Reports (COMPLETE)
- `/services/amazon/VcsTaxReportParser.js` - Parses VCS tax reports
- `/services/amazon/VcsOdooInvoicer.js` - Creates invoices in Odoo from VCS data
- UI: `/public/app/amazon-vcs.html`
- **Note:** This duplicates what `vcs_tax_report_ept.py` does, but with our own independent fields

### Settlement Reports (COMPLETE)
- `/services/amazon/SettlementReportParser.js` - Parses settlement reports
- UI: `/public/app/amazon-settlements.html`
- Stores in MongoDB: `amazon_settlements`

### FBA Reports (COMPLETE)
- `/services/amazon/FbaInventoryReportParser.js`
- `/services/amazon/ReturnsReportParser.js`

### Webhooks & API
- `/api/routes/amazon.api.js` - All Amazon API endpoints
- Webhook receivers for Make.com integration

---

## Migration Priority Analysis

### HIGH PRIORITY (Currently in use, business-critical)

| Feature | Odoo Module | Agent5 Status | Notes |
|---------|-------------|---------------|-------|
| VCS Tax Reports | `amazon_ept` | **DONE** | Using independent `x_` fields |
| Settlement Reports | `amazon_ept` | **DONE** | Stored in MongoDB |
| FBA Inventory | `amazon_ept` | **DONE** | Parser exists |
| Returns Reports | `amazon_ept` | **DONE** | Parser exists |

### MEDIUM PRIORITY (Used but can continue in Odoo short-term)

| Feature | Odoo Module | Agent5 Status | Notes |
|---------|-------------|---------------|-------|
| Vendor Purchase Orders | `amazon_vendor_central_ept` | NOT STARTED | Requisition → Sale Order flow |
| Vendor Invoice Submission | `amazon_vendor_central_ept` | NOT STARTED | Submit invoices to Amazon |
| Product Mappings | Both modules | PARTIAL | Using Odoo product IDs |
| Order Import (FBA/FBM) | `amazon_ept` | VIA ODOO | Crons still running |

### LOW PRIORITY (Rarely used or can be deferred)

| Feature | Odoo Module | Notes |
|---------|-------------|-------|
| FBA Inbound Shipments | `amazon_ept` | Only for FBA sends |
| Removal Orders | `amazon_ept` | Inventory removal from FBA |
| Rating Reports | `amazon_ept` | Customer feedback |
| Active Product Listings | `amazon_ept` | Catalog sync |

---

## API Access Limitations

### No Amazon Developer Account

**Critical Constraint:** We do NOT have an Amazon Developer account and cannot access Amazon SP-API directly.

**Current Situation:**
- Emipro modules use their IAP (In-App Purchase) service to proxy API calls
- All Amazon SP-API calls go through Emipro's `global_variables.REQUEST_URL`
- VCS report decryption is done by Emipro's service

**Make.com Limitations:**
Make.com can access some Amazon data but NOT everything:

| Data Type | Make.com Access | Notes |
|-----------|-----------------|-------|
| Basic Orders | YES | Order ID, customer, items |
| VCS Tax Reports | NO | Requires SP-API |
| Settlement Reports | NO | Requires SP-API |
| Vendor Central POs | UNKNOWN | Need to verify |
| Invoice Submission | UNKNOWN | Need to verify |

**Agent5 Workaround:**
- VCS and Settlement reports: Manual CSV upload via Agent5 UI
- Orders: Receive via Make.com webhook (limited data)
- Vendor Central: May need to keep Emipro dependency

### Emipro IAP Dependency (Vendor Central)

For Vendor Central specifically, we may need to keep using Emipro's IAP for:
- Invoice submission to Amazon
- PO acknowledgment
- ASN (Advance Shipment Notification)

This is because Make.com may not have access to Amazon Vendor API endpoints.

---

## Fields on Odoo Models

### Fields on Invoices (account.move)

| Field | Type | Module | Description |
|-------|------|--------|-------------|
| `amazon_instance_id` | many2one → amazon.instance.ept | amazon_ept | Marketplace reference |
| `seller_id` | many2one → amazon.seller.ept | amazon_ept | Seller reference |
| `amz_fulfillment_by` | selection | amazon_ept | FBA or FBM |
| `invoice_url` | char | amazon_ept | VCS PDF URL |
| `vcs_invoice_number` | char | amazon_ept | VCS invoice ref (Emipro) |
| `invoice_sent` | boolean | amazon_ept | Sent to Amazon flag |
| `is_invoice_submitted` | boolean | amazon_vendor_central_ept | Vendor submission flag |
| `x_vcs_invoice_number` | char | Agent5 (custom) | VCS invoice ref (independent) |
| `x_vcs_invoice_url` | char | Agent5 (custom) | VCS PDF URL (independent) |

### Fields on Sales Orders (sale.order)

| Field | Type | Module | Description |
|-------|------|--------|-------------|
| `amazon_vendor_sale_requisition_id` | many2one | amazon_vendor_central_ept | Requisition reference |
| `amazon_instance_id` | many2one → amazon.vendor.instance | amazon_vendor_central_ept | Vendor instance |
| `amz_instance_id` | many2one → amazon.instance.ept | amazon_ept | Seller instance |
| `amz_order_reference` | char | amazon_ept | Amazon Order ID |

---

## Migration Plan

### Phase 1: Analysis ✅ COMPLETE
- [x] Connect to Odoo.sh GitHub repo
- [x] Analyze Amazon EPT module source code
- [x] Analyze Amazon Vendor Central EPT source code
- [x] Document all fields and their usage
- [x] Identify Emipro IAP dependencies

### Phase 2: Parallel Independence (CURRENT)
- [ ] Ensure VCS uses only `x_` prefixed fields (already done)
- [ ] Ensure Settlement reports are fully in MongoDB
- [ ] Document which Odoo crons can be disabled
- [ ] Test full VCS workflow without Emipro fields

### Phase 3: Vendor Central Migration
- [ ] Design MongoDB schema for vendor orders
- [ ] Implement requisition import from Amazon
- [ ] Implement sale order creation
- [ ] Implement invoice submission to Amazon

### Phase 4: ~~Direct Amazon SP-API Integration~~ NOT POSSIBLE
~~- [ ] Set up AWS credentials~~
~~- [ ] Implement SP-API client for reports~~
~~- [ ] Replace Make.com webhooks with direct polling~~
~~- [ ] Remove Emipro IAP dependency~~

**Note:** This phase is not possible without an Amazon Developer account. Current workflow uses manual CSV uploads for VCS and Settlement reports.

### Phase 5: Cutover
- [ ] Disable Emipro module crons
- [ ] Monitor for 30 days
- [ ] Uninstall Emipro modules
- [ ] Archive Emipro-specific fields

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Emipro IAP unavailable | High | Agent5 already handles VCS independently |
| Data loss during migration | High | MongoDB backup + Odoo backup |
| Broken Odoo reports | Medium | Phase 2 validation before removal |
| SP-API rate limits | Medium | Implement exponential backoff |
| Vendor order failures | High | Keep Odoo module active until tested |

---

## Answers to Open Questions

1. **Which Emipro features are actually used?**
   - VCS Tax Reports → **Migrated to Agent5**
   - Settlement Reports → **Migrated to Agent5**
   - Vendor Purchase Orders → Still in Odoo
   - FBA/FBM Order Import → Via Odoo crons

2. **Are there scheduled actions that need migration?**
   - 21 crons are active, but most can be replaced with Agent5 polling

3. **What reports depend on Emipro fields?**
   - VCS reports now use `x_` fields, so Emipro fields can be ignored
   - Some accounting views may show Emipro fields

4. **How is inventory sync currently working?**
   - `amazon_fba_live_stock_report_ept.py` imports FBA stock
   - Agent5 has its own parser for this

---

## Related Documents

- `/docs/projects/index.md` - Project index
- `/backend/CLAUDE.md` - Claude Code notes
- `/backend/TESTING_PLAN_2025-12-21.md` - Testing plan
- **GitHub Source:** https://github.com/ninicocolala/acropaq (branch: acr_prd)

---

## Change Log

| Date | Change |
|------|--------|
| 2024-12-23 | Updated to document API access limitations (no Amazon Developer account) |
| 2024-12-23 | Marked Phase 4 (SP-API) as NOT POSSIBLE |
| 2024-12-23 | Added Make.com limitation table |
| 2024-12-23 | Initial project document created |
| 2024-12-23 | Complete source code analysis from GitHub repo |
