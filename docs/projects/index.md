# ACROPAQ Projects Index

Central index of all active and planned projects for the Agent5 AI Platform.

---

## Project Management

**All projects are tracked on GitHub Projects. Development work is organized and prioritized based on these projects.**

| Project | URL | Priority |
|---------|-----|----------|
| Amazon Seller Central Migration | https://github.com/users/nimavakil1/projects/1 | High |
| Amazon Vendor Central Migration | https://github.com/users/nimavakil1/projects/2 | HIGH - URGENT |

**Workflow:**
1. All tasks are created as GitHub Issues
2. Issues are organized into Projects for tracking
3. Development work follows the project priorities
4. Progress is tracked through issue status updates

**Quick Links:**
- All Issues: https://github.com/nimavakil1/Agent5/issues
- Seller Central Project: https://github.com/users/nimavakil1/projects/1
- Vendor Central Project: https://github.com/users/nimavakil1/projects/2

---

## Important: API Access Limitations

**No Amazon Developer Account Available**

We do NOT have direct access to Amazon SP-API. All data must be:
1. **Manual Upload** - Download CSV from Amazon Seller Central, upload to Agent5 UI
2. **Make.com Webhooks** - Limited data only (orders, basic info)

**What Make.com CAN access:**
- Basic order data (order ID, customer, items)
- Some inventory updates

**What Make.com CANNOT access (requires SP-API):**
- VCS Tax Reports
- Settlement Reports
- Detailed financial data
- Report downloads

---

## Project 1: Amazon Seller Central Migration

**Status:** Mostly Complete
**Priority:** High
**Doc:** [amazon-vendor-migration.md](./amazon-vendor-migration.md)
**GitHub Project:** https://github.com/users/nimavakil1/projects/1

### Completed Features

| Feature | Status | Notes |
|---------|--------|-------|
| VCS Tax Report Parser | DONE | `VcsTaxReportParser.js` - Manual CSV upload |
| VCS Odoo Invoice Creator | DONE | `VcsOdooInvoicer.js` |
| VCS Order Creator | DONE | `VcsOrderCreator.js` - Creates missing orders |
| Settlement Report Parser | DONE | `SettlementReportParser.js` - Manual upload |
| Settlement Report UI | DONE | `/app/amazon-settlements.html` |
| FBA Inventory Parser | DONE | `FbaInventoryReportParser.js` |
| FBA Inventory Reconciler | DONE | `FbaInventoryReconciler.js` |
| Returns Report Parser | DONE | `ReturnsReportParser.js` |
| SKU Resolution | DONE | `SkuResolver.js` - Pattern-based matching |
| EU Country Config | DONE | `EuCountryConfig.js` - 27 EU + UK |
| VCS Dashboard UI | DONE | `/app/amazon-vcs.html` |
| Reports Upload UI | DONE | `/app/amazon-reports.html` |
| Config Dashboard UI | DONE | `/app/amazon-config.html` |
| x_ field migration | DONE | Using `x_vcs_invoice_number`, `x_vcs_invoice_url` |

### In Progress / Needs Testing

| Task | Status | Notes |
|------|--------|-------|
| VCS Invoice Refactor | IN PROGRESS | GitHub Issue #2 - Use `_create_invoices()` |
| Settlement UI Testing | NEEDS TESTING | GitHub Issue #1 |

### NOT Possible (No API Access)

| Task | Status | Notes |
|------|--------|-------|
| ~~Make.com VCS Webhook~~ | N/A | Requires SP-API access |
| ~~Make.com Settlement Webhook~~ | N/A | Requires SP-API access |
| ~~Direct SP-API Integration~~ | N/A | No Amazon Developer account |
| ~~VcsInvoiceImporter.js~~ | DEAD CODE | Webhook can't receive VCS data |

### Dead Code to Remove

These files exist but cannot work without Amazon SP-API access:
- `VcsInvoiceImporter.js` - Webhook for VCS data (not accessible via Make.com)

---

## Project 2: Amazon Vendor Central Migration

**Status:** Planning / Urgent
**Priority:** HIGH
**Doc:** [amazon-vendor-migration.md](./amazon-vendor-migration.md)
**GitHub Project:** https://github.com/users/nimavakil1/projects/2

### Tasks

| Task | Status | GitHub Issue | Notes |
|------|--------|--------------|-------|
| Vendor Instance MongoDB schema | NOT STARTED | #7 | Based on `amazon_vendor_instance.py` |
| Requisition (PO) schema | NOT STARTED | #8 | Based on `amazon_vendor_sale_requisition.py` |
| Requisition → Odoo Sale Order | NOT STARTED | #9 | Create orders from vendor POs |
| Invoice Submission to Amazon | NOT STARTED | #10 | Via Make.com or manual |
| Vendor Central UI | NOT STARTED | #11 | Dashboard for vendor orders |
| Make.com PO Webhook | NOT STARTED | #12 | Receive POs from Amazon |

**Note:** Invoice submission to Amazon Vendor Central may require Emipro IAP or direct API access. Need to verify Make.com capabilities.

---

## Project 3: VCS Invoice Creation (Refactor)

**Status:** In Progress
**Priority:** HIGH - Current Focus
**GitHub Issue:** #2

### Tasks

| Task | Status | Notes |
|------|--------|-------|
| Use Odoo's native invoice-from-order | IN PROGRESS | Replace manual invoice creation |
| Update draft invoice with VCS data | NOT STARTED | Prices, taxes, references |
| Handle shipping/discount lines | NOT STARTED | Use order's product IDs |
| Test with real order | NOT STARTED | Order 305-1901951-5970703 |
| Verify `qty_invoiced` updates | NOT STARTED | Must update automatically |

---

## Data Flow Summary

### Seller Central (Current Working Flow)

```
Amazon Seller Central
        ↓
   Manual CSV Download
        ↓
   Agent5 UI Upload (/app/amazon-vcs.html, /app/amazon-settlements.html)
        ↓
   Parser (VcsTaxReportParser, SettlementReportParser)
        ↓
   MongoDB Storage
        ↓
   Odoo Integration (VcsOdooInvoicer)
        ↓
   Invoice Created in Odoo
```

### Vendor Central (Planned Flow)

```
Amazon Vendor Central
        ↓
   Make.com Webhook (if possible) OR Manual Entry
        ↓
   Agent5 API
        ↓
   MongoDB Storage (Requisitions)
        ↓
   Odoo Integration (Sale Order creation)
        ↓
   Invoice Submission to Amazon (via Make.com or Emipro)
```

---

## Quick Links

- **Production:** https://ai.acropaq.com
- **GitHub:** https://github.com/nimavakil1/Agent5
- **GitHub Issues:** https://github.com/nimavakil1/Agent5/issues
- **Odoo:** https://acropaq.odoo.com
- **Odoo.sh (modules):** https://github.com/ninicocolala/acropaq (branch: acr_prd)
- **Server SSH:** `sshpass -p 'Sage2o15@' ssh ubuntu@ai.acropaq.com`

---

## Completed Work

| Item | Date | Notes |
|------|------|-------|
| GitHub Projects Setup | 2024-12-23 | 2 projects, 12 issues created |
| Settlements Page UI | 2024-12-23 | `/app/amazon-settlements.html` created |
| Settlements Menu Item | 2024-12-23 | Added to Amazon Config page |
| Invoice-Order Linking | 2024-12-22 | 36,768 orders linked |
| VCS Tax Report Parser | 2024-12-21 | `VcsTaxReportParser.js` |
| Amazon EPT Analysis | 2024-12-23 | Full source code analysis |
| x_ Field Migration | 2024-12-23 | Independent of Emipro fields |

---

## Change Log

| Date | Change |
|------|--------|
| 2024-12-23 | Updated to reflect no Amazon Developer account reality |
| 2024-12-23 | Marked SP-API and webhook features as N/A |
| 2024-12-23 | Added GitHub Projects links |
| 2024-12-23 | Initial project document created |
