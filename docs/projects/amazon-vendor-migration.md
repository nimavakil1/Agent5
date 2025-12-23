# Amazon Vendor Module Migration

**Project:** Migrate Amazon Vendor functionality from Odoo to Agent5 AI Platform
**Status:** Planning
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
- **Module:** Amazon EPT (Emipro)

### Installed Modules (Emipro)

| Module | Description | Author |
|--------|-------------|--------|
| `amazon_ept` | Amazon Odoo Connector | Emipro Technologies |
| `amazon_vendor_central_ept` | Amazon Vendor Central Odoo Connector | Emipro Technologies |

### Amazon-Related Models (47 total)

Key models that would need migration:

| Model | Purpose | Priority |
|-------|---------|----------|
| `amazon.seller.ept` | Seller account configuration | High |
| `amazon.instance.ept` | Marketplace instances (DE, FR, etc.) | High |
| `amazon.vendor.instance` | Vendor Central instances | Medium |
| `amazon.product.ept` | Product mappings to Odoo products | High |
| `amazon.vcs.tax.report.ept` | VCS tax reports | Already migrated |
| `amazon.vendor.sale.requisition` | Vendor purchase orders | Medium |
| `amazon.fba.live.stock.report.ept` | Live inventory | Medium |
| `amazon.inbound.shipment.ept` | FBA inbound shipments | Low |
| `amazon.removal.order.ept` | FBA removal orders | Low |

### Fields on Invoices (account.move)

| Field | Type | Description |
|-------|------|-------------|
| `amazon_instance_id` | many2one → amazon.instance.ept | Marketplace reference |
| `is_undefined_amazon_returns` | boolean | Return flag |
| `vcs_invoice_number` | char | VCS invoice ref (Emipro) |
| `x_vcs_invoice_number` | char | VCS invoice ref (Agent5 - independent) |
| `x_vcs_invoice_url` | char | VCS PDF URL (Agent5 - independent) |

### Fields on Sales Orders (sale.order)

| Field | Type | Description |
|-------|------|-------------|
| `amazon_instance_id` | many2one → amazon.vendor.instance | Vendor instance |
| `amazon_vendor_sale_requisition_id` | many2one | Requisition reference |
| `exported_in_amazon` | boolean | Export sync flag |
| `is_amazon_canceled` | boolean | Cancellation flag |
| `updated_in_amazon` | boolean | Update sync flag |

### Scheduled Actions (21 active crons)

**FBA-Acropaq crons:**
- Import FBA Shipment Report (every 8h)
- Process FBA Shipment Report (every 30min)
- Import FBA Customer Return Report (every 8h)
- Process FBA Customer Return Report (every 8h)
- Import FBA Live Stock Report (every 1h)
- Process FBA Live Stock Report (every 1h)
- Create Removal Order Report (every 8h)
- Create Stock Adjustment Report (every 8h)
- Check inbound shipment status (every 1h)

**FBM-Acropaq crons:**
- Import Amazon Orders (every 1h)
- Process Amazon Orders (every 30min)
- Import Missing Unshipped Orders (every 1h)

**System crons:**
- Shipped Order Queue processing (every 50min)
- Feed Submission History Results (every 5min)
- Auto Create Outbound Orders (every 1h)
- Auto Delete Customer PII Details (daily)
- Sync Fulfillment Centers (weekly)

---

## What Already Exists in Agent5

### VCS Tax Reports
- `/services/amazon/VcsTaxReportParser.js` - Parses VCS tax reports
- `/services/amazon/VcsOdooInvoicer.js` - Creates invoices in Odoo from VCS data
- UI: `/public/app/amazon-vcs.html`

### Settlement Reports
- `/services/amazon/SettlementReportParser.js` - Parses settlement reports
- UI: `/public/app/amazon-settlements.html`
- Stores in MongoDB: `amazon_settlements`

### FBA Reports
- `/services/amazon/FbaInventoryReportParser.js`
- `/services/amazon/ReturnsReportParser.js`

### Webhooks & API
- `/api/routes/amazon.api.js` - All Amazon API endpoints
- Webhook receivers for Make.com integration

---

## Migration Plan

### Phase 1: Analysis (Current)
- [ ] Connect to Odoo.sh and analyze Amazon Vendor module
- [ ] Document all custom fields and their usage
- [ ] Document all Python code/automation
- [ ] Identify dependencies between modules

### Phase 2: Data Migration Strategy
- [ ] Design MongoDB schema for vendor data
- [ ] Create migration scripts for existing data
- [ ] Define Odoo API interactions (what stays, what goes)

### Phase 3: Core Functionality
- [ ] Vendor order processing
- [ ] EDI/PEPPOL invoice handling
- [ ] Purchase order automation
- [ ] Product synchronization

### Phase 4: Testing & Validation
- [ ] Test data migration with subset
- [ ] Parallel run (both systems active)
- [ ] Validate financial data accuracy

### Phase 5: Cutover
- [ ] Final data migration
- [ ] Disable Odoo module
- [ ] Monitor for issues
- [ ] Uninstall Odoo module

---

## Technical Notes

### Odoo Fields to Preserve
*Document x_ prefixed custom fields used*

| Field | Model | Purpose |
|-------|-------|---------|
| `x_vcs_invoice_number` | account.move | VCS invoice reference |
| `x_vcs_invoice_url` | account.move | PDF download URL |
| `x_exported` | account.move | Export flag |
| *TBD* | | |

### Emipro Fields to Migrate/Replace
*Document EPT module fields*

| Field | Model | Purpose | Agent5 Replacement |
|-------|-------|---------|-------------------|
| `vcs_invoice_number` | account.move | VCS ref (Emipro) | Use x_vcs_invoice_number |
| `is_vcs_invoice` | account.move | VCS flag | Check x_vcs_invoice_number not null |
| `amazon_instance_id` | Multiple | Instance reference | MongoDB config |
| *TBD* | | | |

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Data loss during migration | High | Full backup before cutover |
| Broken Odoo reports | Medium | Test all reports pre-cutover |
| Accounting discrepancies | High | Parallel validation period |

---

## Open Questions

1. Which Emipro features are actually used vs just installed?
2. Are there any scheduled actions/crons that need migration?
3. What reports depend on Emipro fields?
4. How is inventory sync currently working?

---

## Related Documents

- `/docs/projects/index.md` - Project index
- `/backend/CLAUDE.md` - Claude Code notes
- `/backend/TESTING_PLAN_2025-12-21.md` - Testing plan

---

## Change Log

| Date | Change |
|------|--------|
| 2024-12-23 | Initial project document created |
