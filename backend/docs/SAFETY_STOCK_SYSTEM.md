# Safety Stock System

## Overview

The Safety Stock system ensures that a buffer of inventory is always kept in the Central Warehouse (CW) and not allocated to marketplace stock (Amazon FBM, Bol.com FBR). This prevents overselling when there are delays between Odoo stock updates and marketplace synchronization.

**Formula:**
```
Marketplace Qty = max(0, CW Free Qty - Safety Stock)
```

For example:
- CW Free Stock: 25 units
- Safety Stock: 10 units
- Sent to Amazon/Bol: 15 units

## Architecture

### Data Flow

```
┌─────────────┐     ┌─────────────┐     ┌────────────────┐
│  Odoo       │────>│  MongoDB    │────>│  Marketplaces  │
│ (CW Stock)  │     │ (Cache +    │     │ (Amazon FBM,   │
│             │     │  Safety     │     │  Bol.com FBR)  │
└─────────────┘     │  Stock)     │     └────────────────┘
                    └─────────────┘
                          ↑
                    ┌─────────────┐
                    │  Agent5 UI  │
                    │ (Edit Safety│
                    │   Stock)    │
                    └─────────────┘
```

### Source of Truth

- **Agent5/MongoDB** is the master for safety stock values
- **Odoo x_safety_stock** field is kept in sync but is **read-only** in Odoo UI
- When safety stock is updated in Agent5 UI, it updates both MongoDB AND Odoo immediately

## Odoo Configuration

### Custom Field: x_safety_stock

- **Model:** `product.template`
- **Type:** Float
- **Default:** 10
- **Label:** "Safety Stock (FBM/FBR)"
- **Location:** Inventory tab > LOGISTICS section (after country_of_origin)
- **Read-only:** Yes (managed via Agent5)
- **Tooltip:** "Managed via Agent5. This value is deducted from free stock when syncing to Amazon FBM/BOL FBR."

### View Details

- **View ID:** 4821 (inherited view)
- **Display:** Integer only (no decimals)

## API Endpoints

### GET /api/odoo/products/:id
Returns product details including `safetyStock` field.

### PUT /api/odoo/products/:id
Updates product in Odoo. If `safetyStock` is included:
1. Updates Odoo `x_safety_stock` field
2. Updates MongoDB `safetyStock` field
3. Logs the change

### POST /api/odoo/products/safety-stock/bulk
Bulk update safety stock for multiple products.

**Request body:**
```json
{
  "updates": [
    { "sku": "ABC123", "safetyStock": 15 },
    { "odooId": 456, "safetyStock": 20 }
  ]
}
```

### GET /api/odoo/products/safety-stock/verify
Compare MongoDB and Odoo safety stock values. Returns any mismatches.

### POST /api/odoo/products/safety-stock/sync-from-odoo
Sync safety stock from Odoo to MongoDB (fix mismatches).

## Scheduled Jobs

### Safety Stock Verification
- **Schedule:** Daily at 3:00 AM (Europe/Brussels)
- **Function:** `verifySafetyStockSync()`
- **Location:** `/src/scheduler/index.js`
- **Purpose:** Detect mismatches between MongoDB and Odoo

**Auto-fix option:** Set `SAFETY_STOCK_AUTO_FIX=1` to automatically sync Odoo values to MongoDB when mismatches are found.

## Marketplace Stock Sync

### Amazon FBM Stock Export

**Schedule:** Every 30 minutes
**File:** `/src/services/amazon/seller/SellerFbmStockExport.js`

**Flow:**
1. Get all FBM listings from Amazon (Seller SKUs)
2. Resolve Amazon SKU → Odoo SKU using SkuResolver
3. Get CW free stock for each product from Odoo
4. Get safety stock for each product from MongoDB
5. Calculate: `amazonQty = max(0, cwFreeQty - safetyStock)`
6. Send stock updates to Amazon via Listings Items API

### Bol.com FBR Stock Sync

**Schedule:** Every 15 minutes
**File:** `/src/services/bol/BolStockSync.js`

**Flow:**
1. Request offer export from Bol.com (CSV)
2. Download and parse CSV to get FBR offers (not FBB)
3. Get CW free stock for each EAN from Odoo
4. Get safety stock for each EAN from MongoDB
5. Calculate: `bolQty = max(0, cwFreeQty - safetyStock)`
6. Update each offer's stock via Bol.com API

## Teams Notifications

### Channels

Two Teams channels receive notifications:

1. **Report Channel** (`TEAMS_FBM_REPORT_WEBHOOK_URL`)
   - Regular stock update reports
   - Sent after every sync (even if no changes, to confirm system ran)
   - Includes summary: Total SKUs, Updated, Increases, Decreases, Unchanged, Zero Stock

2. **Escalation Channel** (`TEAMS_FBM_ESCALATION_WEBHOOK_URL`)
   - Failed syncs requiring manual action
   - Includes error details and manual upload instructions
   - TSV file (Amazon) or CSV file (Bol.com) for manual upload

### Report Content

Each stock sync generates:
1. **Teams Adaptive Card** with summary statistics
2. **Excel Report** (only when changes exist) uploaded to OneDrive

**Excel columns:**
- Amazon: ASIN, Amazon SKU, Odoo SKU, Amazon QTY Before, CW QTY, CW Free QTY, Safety Stock, New Amazon QTY, Delta, Status
- Bol.com: EAN, Reference, Bol QTY Before, CW Free QTY, Safety Stock, New Bol QTY, Delta, Status

### Conditional Formatting
- Green: Stock increases (delta > 0)
- Red: Stock decreases (delta < 0)

## Error Escalation

When sync fails:

1. **Amazon FBM:**
   - Generates TSV file compatible with Seller Central
   - Uploads to OneDrive
   - Sends escalation to Teams with download link
   - Instructions for manual upload to Amazon

2. **Bol.com FBR:**
   - Generates CSV file for Bol.com
   - Uploads to OneDrive
   - Sends escalation to Teams with download link
   - Instructions for manual upload to Bol.com

## Environment Variables

```bash
# Teams Webhooks (same channel for both Amazon FBM and Bol.com)
TEAMS_FBM_REPORT_WEBHOOK_URL=https://...     # Regular reports
TEAMS_FBM_ESCALATION_WEBHOOK_URL=https://... # Error escalations

# OneDrive Report Folders
FBM_STOCK_REPORTS_FOLDER=FBM_Stock_Reports   # Amazon reports
BOL_STOCK_REPORTS_FOLDER=BOL_Stock_Reports   # Bol.com reports

# Safety Stock Verification
SAFETY_STOCK_VERIFY_ENABLED=1                # Enable nightly verification (default: enabled)
SAFETY_STOCK_AUTO_FIX=0                      # Auto-fix mismatches (default: disabled)
```

## UI Integration

### Product Detail Page

Location: `/src/public/inventory/product.html` > Logistics tab

The Safety Stock field:
- Shows current value (default: 10)
- Editable input field
- When saved, updates both MongoDB AND Odoo immediately
- Label: "Safety Stock (FBM/FBR)"

## Troubleshooting

### Safety Stock Not Being Applied

1. Check if product has `safetyStock` field in MongoDB:
   ```javascript
   db.products.findOne({ sku: "YOUR_SKU" }, { safetyStock: 1 })
   ```

2. Check if Odoo has `x_safety_stock` field:
   - Go to product in Odoo > Inventory tab > LOGISTICS section

3. Run verification endpoint:
   ```bash
   GET /api/odoo/products/safety-stock/verify
   ```

### Teams Notifications Not Working

1. Verify webhook URLs in `.env`
2. Check scheduler logs for errors
3. Test webhook manually:
   ```bash
   curl -X POST "YOUR_WEBHOOK_URL" \
     -H "Content-Type: application/json" \
     -d '{"text": "Test message"}'
   ```

### Stock Not Syncing to Marketplace

1. Check scheduler is running: `pm2 status`
2. Check scheduler logs: `pm2 logs | grep -i "stock sync"`
3. Verify SKU resolution is working (Amazon) or EAN exists in Odoo (Bol.com)

## Files Reference

| File | Purpose |
|------|---------|
| `/src/services/amazon/seller/SellerFbmStockExport.js` | Amazon FBM stock export |
| `/src/services/amazon/seller/FbmStockReportService.js` | Amazon FBM reports & Teams |
| `/src/services/amazon/seller/FbmStockFallbackGenerator.js` | Amazon TSV fallback |
| `/src/services/bol/BolStockSync.js` | Bol.com FBR stock sync |
| `/src/services/bol/BolStockReportService.js` | Bol.com reports & Teams |
| `/src/scheduler/index.js` | Scheduled job orchestration |
| `/src/api/routes/odoo.api.js` | Safety stock API endpoints |
| `/src/public/inventory/product.html` | Product UI with safety stock |

## Summary

The Safety Stock system provides:

1. **Buffer Protection:** Prevents overselling by keeping reserve inventory
2. **Unified Management:** Single place to manage safety stock (Agent5 UI)
3. **Automatic Sync:** Scheduled jobs keep marketplace stock updated
4. **Full Visibility:** Teams notifications and Excel reports for every sync
5. **Error Recovery:** Escalation channel with manual upload files when sync fails
6. **Verification:** Nightly job to detect and optionally fix sync issues
