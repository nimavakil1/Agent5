# VCS Invoicing - Critical Business Rules

## What is VCS?
VCS (VAT Calculation Service) is Amazon's tax report that contains all order/return data needed for invoicing.

## Key Concept: "isAmazonInvoiced"

**isAmazonInvoiced = true** means:
- Amazon PRINTED the invoice on behalf of Acropaq
- The invoice shows ACROPAQ as the seller (with Acropaq's VAT number BE0476248323)
- Amazon collected VAT from the customer at the correct rate (19%, 20%, 22%, etc.)
- Amazon reports this VAT via OSS under Acropaq's VAT registration
- **This VAT IS Acropaq's liability** - we must record it with the SAME tax rate

**isAmazonInvoiced = false** (Italian exceptions):
- Amazon could NOT invoice due to defective Italian VAT registration
- Acropaq must create the invoice themselves
- Apply correct OSS tax based on destination country

## Tax Rates

**CRITICAL: Use VCS tax rates, NOT 0%**

For Amazon-invoiced orders, VCS contains the actual tax Amazon charged:
- DE destination → 19%
- FR destination → 20%
- IT destination → 22%
- etc.

These are Acropaq's taxes that Amazon collected on their behalf. The Odoo invoice must match.

## Warehouse Mapping

Based on shipFromCountry (where Amazon FBA shipped from):

| Country | Warehouse Code | Description |
|---------|----------------|-------------|
| BE | CW | Central Warehouse (FBM) |
| NL | nl1 | FBA Netherlands |
| DE | de1 | FBA Germany |
| FR | fr1 | FBA France |
| PL | pl1 | FBA Poland |
| IT | it1 | FBA Italy |
| CZ | cz1 | FBA Czech |
| GB | uk1 | FBA UK |

**Acropaq has VAT registration in: BE, NL, DE, FR, PL, IT, CZ, GB**

## Processing Rules

### Sales (totalExclusive > 0)

1. Check if Odoo sale order exists (by client_order_ref = Amazon order ID)
2. If NO order exists → CREATE sale order from VCS data:
   - Set correct warehouse based on shipFromCountry
   - Set fiscal position based on shipFrom/shipTo
   - Confirm order and set qty_delivered
3. Create invoice linked to sale order
4. Apply correct tax from VCS data on each line
5. Post invoice
6. Update MongoDB status

### Returns (totalExclusive < 0)

**NEVER create a new sale order for returns!**

Creating an order would:
- Increase revenue (wrong - returns decrease revenue)
- Decrease stock (wrong - returns increase stock)

Correct flow:
1. Find the ORIGINAL sale order (the order being returned)
2. Create CREDIT NOTE linked to that order
3. If original order not found → skip or create standalone credit note

## Fiscal Positions

Determined by shipFrom/shipTo countries:
- Domestic (same country) → Country*VAT
- Cross-border EU B2C → Destination*OSS
- Cross-border EU B2B → Intra-Community (0%)
- Export (outside EU) → Export (0%)

## Journals

Based on transaction type:
- OSS sales → VOSS journal
- Export → VEX journal
- Domestic → Country-specific journal (VBE, VDE, VFR, etc.)

## Italian Exceptions

Orders from IT FBA where isAmazonInvoiced = false:
- B2C domestic (IT→IT) → IT*OSS 22%
- B2C cross-border (IT→DE) → DE*OSS 19%
- B2B cross-border → Intra-Community 0%
- Export → Export 0%

---

*Last updated: January 2026*
*This document reflects the agreed business rules for VCS invoice processing.*
