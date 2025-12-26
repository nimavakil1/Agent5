# Amazon Seller Central - Emipro Configuration Reference

This document captures the current Emipro (amazon_ept) configuration from Odoo to replicate in Agent5.

## Seller Account

| Field | Value |
|-------|-------|
| Name | Acropaq |
| Merchant ID | A1GJ5ZORIRYSYA |
| Company | ACROPAQ |
| Country | France |
| Amazon Selling | Both (FBA + FBM) |
| Amazon Program | Pan-EU |
| Is European Region | Yes |
| Is SP-API Seller | Yes |

### Order Settings
| Setting | Value |
|---------|-------|
| FBM Order Prefix | FBM |
| FBA Order Prefix | FBA |
| Use Default Odoo Sequence | No |
| Payment Term | Immediate Payment |
| Fulfillment Latency | 3 days |
| Auto Workflow (FBM) | Automatic Validation |
| Auto Workflow (FBA) | Automatic Validation |

### Special Products (for accounting)
| Product | ID | Internal Reference |
|---------|----|--------------------|
| Shipping Charge | 16401 | [SHIP AMAZON] |
| Gift Wrapper | 16403 | [GIFT WRAPPER FEE] |
| Promotion Discount | 16404 | [PROMOTION DISCOUNT] |
| Shipment Discount | 16405 | [SHIPMENT DISCOUNT] |
| Reimbursement | 16406 | [REIMBURSEMENT] |

### Special Partners
| Partner | ID | Purpose |
|---------|----|---------|
| Amazon Reimbursement | 5520 | Reimbursement invoices |
| FBA Pending Order | 5518 | Pending FBA orders |

---

## Marketplaces

| ID | Marketplace | Domain | Country | Currency | Marketplace ID (SP-API) |
|----|-------------|--------|---------|----------|------------------------|
| 1 | Amazon.fr | www.amazon.fr | France | EUR | A13V1IB3VIYZZH |
| 2 | Amazon.nl | www.amazon.nl | Netherlands | EUR | A1805IZSGTT6HS |
| 3 | Amazon.pl | www.amazon.pl | Poland | PLN | A1C3SOZRARQ6R3 |
| 4 | Amazon.de | www.amazon.de | Germany | EUR | A1PA6795UKMFR9 |
| 5 | Amazon.es | www.amazon.es | Spain | EUR | A1RKKUPIHCS9HS |
| 6 | Amazon.se | www.amazon.se | Sweden | SEK | A2NODRKZP88ZB9 |
| 7 | Amazon.com.tr | www.amazon.com.tr | Turkey | TRY | A33AVAJ2PDY3EV |
| 8 | Amazon.com.be | www.amazon.com.be | Belgium | EUR | AMEN7PMS3EDWL |
| 9 | Amazon.it | www.amazon.it | Italy | EUR | APJ6JRA9NG5V4 |
| 10 | Amazon.co.uk | www.amazon.co.uk | United Kingdom | GBP | A1F83G8C2ARO7P |
| 11 | Amazon.ie | www.amazon.ie | Ireland | EUR | A28R8C7NBKEWEA |
| 12 | Amazon.sa | www.amazon.sa | Saudi Arabia | SAR | A17E79C6D8DWNP |
| 13 | Amazon.ae | www.amazon.ae | UAE | AED | A2VIGQ35RCS4UG |

---

## Instances (Marketplace Configurations)

| Instance | Marketplace | Warehouse | FBA Warehouse | Sales Team | Pricelist |
|----------|-------------|-----------|---------------|------------|-----------|
| Amazon.de | Amazon.de | Central Warehouse | FBA Amazon.de | Amazon Seller (11) | Amazon.de Pricelist (EUR) |
| Amazon.fr | Amazon.fr | Central Warehouse | FBA Amazon.fr | Amazon Seller (11) | Amazon.fr Pricelist (EUR) |
| Amazon.nl | Amazon.nl | Central Warehouse | FBA Amazon.nl | Amazon Seller (11) | Amazon.nl Pricelist (EUR) |
| Amazon.es | Amazon.es | Central Warehouse | FBA Amazon.es | Amazon Seller (11) | Amazon.es Pricelist (EUR) |
| Amazon.it | Amazon.it | Central Warehouse | FBA Amazon.it | Amazon Seller (11) | Amazon.it Pricelist (EUR) |
| Amazon.pl | Amazon.pl | Central Warehouse | FBA Amazon.pl | Amazon Seller (11) | Amazon.pl Pricelist (PLN) |
| Amazon.se | Amazon.se | Central Warehouse | FBA Amazon.se | Amazon Seller (11) | Amazon.se Pricelist (SEK) |
| Amazon.co.uk | Amazon.co.uk | Central Warehouse | FBA Amazon.co.uk | Amazon Seller (11) | Amazon.co.uk Pricelist (GBP) |
| Amazon.com.be | Amazon.com.be | Central Warehouse | FBA Amazon.com.be | Amazon Seller (11) | Amazon.com.be Pricelist (EUR) |
| Amazon.com.tr | Amazon.com.tr | Central Warehouse | FBA Amazon.com.tr | Amazon Seller (11) | Amazon.com.tr Pricelist (TRY) |

---

## FBA Warehouses

| Warehouse ID | Name |
|--------------|------|
| 5 | FBA Amazon.fr |
| 6 | FBA Amazon.nl |
| 7 | FBA Amazon.pl |
| 8 | FBA Amazon.de |
| 9 | FBA Amazon.es |
| 10 | FBA Amazon.se |
| 11 | FBA Amazon.com.tr |
| 12 | FBA Amazon.com.be |
| 13 | FBA Amazon.it |
| 19 | FBA Amazon.co.uk |

---

## Cron Jobs (Automated Tasks)

Current sync settings from Emipro:
- Order Import: Every 15 minutes (last sync: active)
- Shipment Update: Active (last sync: active)
- Return Report: Every 3 days
- Shipping Report: Every 3 days
- Stock Adjustment Report: Every 3 days
- Removal Order Report: Every 3 days
- Inbound Shipment Status: Active

### VCS Settings
- VCS Activated: No (manual uploads)
- VCS Report Days: 3
- Auto Import VCS Tax Report: No
- Auto Upload Tax Invoices: No

---

## SP-API Marketplace IDs Reference

For direct SP-API integration, use these marketplace IDs:

```javascript
const MARKETPLACE_IDS = {
  'FR': 'A13V1IB3VIYZZH',
  'NL': 'A1805IZSGTT6HS',
  'PL': 'A1C3SOZRARQ6R3',
  'DE': 'A1PA6795UKMFR9',
  'ES': 'A1RKKUPIHCS9HS',
  'SE': 'A2NODRKZP88ZB9',
  'TR': 'A33AVAJ2PDY3EV',
  'BE': 'AMEN7PMS3EDWL',
  'IT': 'APJ6JRA9NG5V4',
  'UK': 'A1F83G8C2ARO7P',
  'IE': 'A28R8C7NBKEWEA',
  'SA': 'A17E79C6D8DWNP',
  'AE': 'A2VIGQ35RCS4UG'
};
```

---

## What Needs to Be Replicated in Agent5

### Already Done (via Make.com/Manual)
- [x] Order import (via Make.com webhooks)
- [x] VCS tax report parsing
- [x] VCS invoice creation in Odoo
- [x] Settlement report parsing

### To Build with Direct SP-API
1. **Order Import** - Direct polling from Orders API
2. **Order Updates** - Shipment confirmations, cancellations
3. **FBA Inventory Sync** - Stock levels from FBA
4. **Return Reports** - Automated import
5. **Tracking Sync** - Push tracking numbers to Amazon
6. **Stock Updates** - Push FBM stock to Amazon

### Requires Seller Refresh Token
To connect directly, need to authorize the app in Seller Central:
- Merchant ID: A1GJ5ZORIRYSYA
- Region: EU (europe-west1)
- All 13 marketplaces share same seller account
