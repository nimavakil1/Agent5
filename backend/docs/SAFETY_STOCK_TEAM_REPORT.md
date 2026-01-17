# Safety Stock System Implementation Report

**Date:** January 17, 2026
**System:** Agent5 Inventory Management
**Affected Channels:** Amazon FBM, Bol.com FBR

---

## Executive Summary

We have implemented a **Safety Stock** system that automatically reserves a buffer of inventory in our Central Warehouse (CW) when syncing stock to Amazon FBM and Bol.com FBR marketplaces. This prevents overselling and ensures we always have stock available for other channels or unexpected orders.

**Key Change:** When we send stock quantities to Amazon and Bol.com, we now deduct the safety stock value first.

---

## What is Safety Stock?

Safety Stock is a buffer quantity that we keep "in reserve" and don't allocate to marketplace listings.

**Example:**
- Product has **25 units** free in Central Warehouse
- Safety Stock is set to **10 units**
- We send **15 units** to Amazon/Bol.com (25 - 10 = 15)

This ensures we always have 10 units available for:
- Walk-in customers
- B2B orders
- Buffer for stock count discrepancies
- Other sales channels

---

## Default Value

All products now have a **default Safety Stock of 10 units**.

This value can be adjusted per product through the Agent5 interface.

---

## How to View/Edit Safety Stock

### In Agent5 (Recommended)
1. Go to **Inventory** > **Products**
2. Click on a product
3. Go to the **Logistics** tab
4. Find **"Safety Stock (FBM/FBR)"** field
5. Edit the value and save

Changes take effect on the next stock sync (within 15-30 minutes).

### In Odoo (View Only)
1. Go to product form
2. Look in **Inventory** tab > **LOGISTICS** section
3. Field is labeled **"Safety Stock (FBM/FBR)"**

**Note:** The field is **read-only in Odoo**. All edits must be done through Agent5 to ensure proper synchronization.

---

## Automatic Stock Sync Schedule

| Marketplace | Frequency | What Happens |
|-------------|-----------|--------------|
| Amazon FBM | Every 30 minutes | CW stock minus safety stock sent to Amazon |
| Bol.com FBR | Every 15 minutes | CW stock minus safety stock sent to Bol.com |

---

## Teams Notifications

You will now receive notifications in Microsoft Teams for stock updates.

### Two Channels:

1. **"FBM-FBR inventory update to marketplace - Report"**
   - Receives regular stock update reports
   - Shows: Total products, increases, decreases, unchanged
   - Includes downloadable Excel report when changes occur

2. **"escalations"**
   - Receives alerts when sync fails
   - Includes file for manual upload to marketplace
   - Step-by-step instructions for manual recovery

### What the Reports Show:

Every stock sync generates a summary:
- **Total SKUs/Offers** - How many products were checked
- **Updated** - How many had stock changes
- **Increases (↑)** - Stock went up on marketplace
- **Decreases (↓)** - Stock went down on marketplace
- **Unchanged** - No change needed
- **Zero Stock** - Products now showing 0 on marketplace

### Excel Report Contents:

When stock changes occur, an Excel file is generated with:

| Column | Description |
|--------|-------------|
| SKU/EAN | Product identifier |
| Marketplace QTY (Before) | What was on Amazon/Bol before |
| CW Free QTY | Current free stock in Central Warehouse |
| Safety Stock | The safety buffer for this product |
| New Marketplace QTY | What we're sending to Amazon/Bol |
| Delta | The change (+5, -3, etc.) |
| Status | Success or Failed |

Green highlighting = stock increase
Red highlighting = stock decrease

---

## Error Handling

If the automatic sync fails:

1. **Teams Alert** is sent to the "escalations" channel
2. **Manual Upload File** is attached (TSV for Amazon, CSV for Bol.com)
3. **Instructions** are provided for manual upload to Seller Central / Bol.com portal

This ensures stock can always be updated even if the API connection fails.

---

## Nightly Verification

Every night at **3:00 AM**, the system automatically:
1. Compares safety stock values between Agent5 and Odoo
2. Logs any discrepancies
3. Reports mismatches in the system logs

This ensures data integrity across systems.

---

## Frequently Asked Questions

### Q: Why can't I edit Safety Stock in Odoo?
**A:** To ensure data consistency, all safety stock edits must go through Agent5. The Agent5 system updates both the local database AND Odoo simultaneously.

### Q: What happens if I set Safety Stock to 0?
**A:** The full CW free stock will be sent to the marketplace. Use this only for products where you want maximum marketplace availability.

### Q: What if Safety Stock is higher than available stock?
**A:** The marketplace will show 0 units. For example:
- CW Free: 8 units
- Safety Stock: 10 units
- Sent to marketplace: 0 units (max of 0, not negative)

### Q: Does this affect FBA/FBB stock?
**A:** No. Safety Stock only affects:
- Amazon FBM (Fulfilled by Merchant)
- Bol.com FBR (Fulfilled by Retailer)

FBA and FBB inventory is managed by Amazon/Bol.com warehouses and is not affected.

### Q: How quickly do changes take effect?
**A:**
- Safety stock changes: Next sync cycle (15-30 minutes)
- Stock level changes from Odoo: Next sync cycle (15-30 minutes)

### Q: Can I bulk update Safety Stock for multiple products?
**A:** Yes, contact the system administrator. There is an API endpoint for bulk updates.

---

## Impact Summary

| Before | After |
|--------|-------|
| Full CW stock sent to marketplaces | CW stock minus safety buffer sent |
| No visibility into sync operations | Teams notifications for every sync |
| Manual intervention needed on failures | Automatic escalation with recovery files |
| No data verification | Nightly verification job |

---

## Support

For questions or issues with the Safety Stock system:
- Check the Teams channels for recent sync reports
- Review the Excel reports for detailed stock movements
- Contact the system administrator for bulk changes or technical issues

---

## Technical Reference

For technical documentation, see: `/docs/SAFETY_STOCK_SYSTEM.md`

---

*This report documents the Safety Stock system implemented on January 17, 2026.*
