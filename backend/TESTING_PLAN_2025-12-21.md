# Testing Plan - December 21, 2025

## Summary of Today's Work

Today we implemented/enhanced the following systems:

1. **Amazon VCS Tax Report System** - Parse and import VCS reports, create Odoo invoices
2. **Amazon FBA Inventory Report Parser** - Parse FBA inventory reports
3. **Amazon Returns Report Parser** - Parse FBA returns reports
4. **Odoo Invoice Creation from VCS** - Connect to Odoo and create customer invoices
5. **Purchasing Intelligence Agent** - Already fully implemented, reviewed today

---

## 1. Amazon VCS Tax Report System

### Files Created/Modified
- `/backend/src/services/amazon/VcsTaxReportParser.js` (NEW)
- `/backend/src/services/amazon/VcsOdooInvoicer.js` (NEW)
- `/backend/src/public/app/amazon-vcs.html` (NEW)
- `/backend/src/api/routes/amazon.api.js` (MODIFIED - added VCS endpoints)

### Test Cases

#### 1.1 VCS Report Upload
- [ ] Navigate to `http://localhost:3000/app/amazon-vcs.html`
- [ ] Upload a VCS Tax Report CSV file (from Seller Central)
- [ ] Verify the upload progress bar works
- [ ] Verify success message appears
- [ ] Verify summary stats update (Total Orders, Pending, Total Revenue)

#### 1.2 Pending Orders Table
- [ ] Verify pending orders appear in the table
- [ ] Test the search filter (by Order ID)
- [ ] Test the VAT Config filter dropdown (All, OSS, B2B, Export, Deemed Reseller)
- [ ] Test the Status filter dropdown
- [ ] Test the date range filters
- [ ] Verify pagination works
- [ ] Test "Select All" checkbox
- [ ] Test individual row checkboxes

#### 1.3 Export to CSV
- [ ] Click "Export CSV" button
- [ ] Verify CSV file downloads
- [ ] Open CSV and verify data is correct

#### 1.4 Preview Invoices (Dry Run)
- [ ] Click "Preview Invoices" button
- [ ] Verify loading state appears
- [ ] Verify modal appears with preview data
- [ ] Check that "Preview Mode" banner is shown
- [ ] Verify invoices list shows what would be created
- [ ] Verify stats show: Processed, Would Create, Skipped, Errors
- [ ] Close modal and verify no changes were made

#### 1.5 Create Invoices in Odoo
- [ ] Click "Create Invoices in Odoo" button
- [ ] Verify confirmation dialog appears
- [ ] Confirm and check loading state
- [ ] Verify modal shows created invoices
- [ ] **Log into Odoo and verify invoices were actually created**
- [ ] Verify order status changed to "invoiced" in the table
- [ ] Verify summary stats updated

### API Endpoints to Test
```bash
# Upload VCS report
curl -X POST http://localhost:3000/api/amazon/vcs/upload \
  -F "file=@/path/to/vcs-report.csv"

# Get pending orders
curl http://localhost:3000/api/amazon/vcs/orders/pending

# Get summary
curl http://localhost:3000/api/amazon/vcs/summary

# Preview invoices (dry run)
curl -X POST http://localhost:3000/api/amazon/vcs/create-invoices \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "dryRun": true}'

# Create invoices for real
curl -X POST http://localhost:3000/api/amazon/vcs/create-invoices \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "dryRun": false}'
```

---

## 2. Amazon FBA Inventory Report Parser

### Files Created/Modified
- `/backend/src/services/amazon/FbaInventoryReportParser.js` (NEW)
- `/backend/src/public/app/amazon-reports.html` (NEW)
- `/backend/src/api/routes/amazon.api.js` (MODIFIED - added FBA endpoints)

### Test Cases

#### 2.1 FBA Inventory Report Upload
- [ ] Navigate to `http://localhost:3000/app/amazon-reports.html`
- [ ] Select "FBA Inventory" report type
- [ ] Upload an FBA Inventory report CSV
- [ ] Verify upload succeeds
- [ ] Check summary shows: Total SKUs, Total Quantity, Warehouses

#### 2.2 Data Verification
- [ ] Verify inventory is grouped by SKU correctly
- [ ] Verify warehouse locations are detected (BER1, LIL1, etc.)
- [ ] Verify country mapping is correct (BER1 -> Germany)

### API Endpoints to Test
```bash
# Upload FBA inventory report
curl -X POST http://localhost:3000/api/amazon/fba/upload \
  -F "file=@/path/to/fba-inventory.csv"

# Get current inventory
curl http://localhost:3000/api/amazon/fba/inventory

# Get inventory by SKU
curl http://localhost:3000/api/amazon/fba/inventory?sku=SOME-SKU

# Get inventory by country
curl http://localhost:3000/api/amazon/fba/inventory?country=DE

# Get uploaded reports
curl http://localhost:3000/api/amazon/fba/reports
```

---

## 3. Amazon Returns Report Parser

### Files Created/Modified
- `/backend/src/services/amazon/ReturnsReportParser.js` (NEW)
- `/backend/src/api/routes/amazon.api.js` (MODIFIED - added Returns endpoints)

### Test Cases

#### 3.1 Returns Report Upload
- [ ] Navigate to `http://localhost:3000/app/amazon-reports.html`
- [ ] Select "FBA Returns" report type
- [ ] Upload a Returns report CSV
- [ ] Verify upload succeeds
- [ ] Check summary shows: Total Returns, Sellable, Unsellable

#### 3.2 Returns Analysis
- [ ] Verify returns are grouped by order correctly
- [ ] Verify returns are grouped by SKU correctly
- [ ] Verify return reasons are tracked
- [ ] Verify disposition (sellable/unsellable) is detected

### API Endpoints to Test
```bash
# Upload returns report
curl -X POST http://localhost:3000/api/amazon/returns/upload \
  -F "file=@/path/to/returns-report.csv"

# Get returns summary (last 30 days)
curl http://localhost:3000/api/amazon/returns/summary?days=30

# Get all returns
curl http://localhost:3000/api/amazon/returns

# Get returns by date range
curl "http://localhost:3000/api/amazon/returns?from=2024-01-01&to=2024-12-31"

# Get returns by SKU
curl http://localhost:3000/api/amazon/returns?sku=SOME-SKU

# Get returns by order
curl http://localhost:3000/api/amazon/returns?orderId=123-4567890-1234567
```

---

## 4. Odoo Invoice Creation

### Files Modified
- `/backend/src/services/amazon/VcsOdooInvoicer.js` (MODIFIED - added currency cache)
- `/backend/src/api/routes/amazon.api.js` (MODIFIED - OdooDirectClient initialization)
- `/backend/.env` (MODIFIED - added Odoo credentials)

### Environment Variables Required
```env
ODOO_URL=https://acropaq.odoo.com
ODOO_DB=ninicocolala-v16-fvl-fvl-7662670
ODOO_USERNAME=nima@acropaq.com
ODOO_PASSWORD=9ca1030fd68f798adbab7a84e50e3ae40cba27fd
```

### Test Cases

#### 4.1 Odoo Connection
- [ ] Verify server can connect to Odoo
- [ ] Check authentication works
- [ ] Verify fiscal positions are loaded
- [ ] Verify journals are loaded
- [ ] Verify currencies are loaded (EUR, GBP, SEK, PLN, etc.)

#### 4.2 Invoice Creation Logic
- [ ] Test OSS invoice (EU customer, B2C)
- [ ] Test B2B invoice (EU customer with VAT number)
- [ ] Test Export invoice (non-EU customer)
- [ ] Verify "Deemed Reseller" orders are SKIPPED (Amazon handles VAT)
- [ ] Verify invoice date matches transaction date
- [ ] Verify amounts are correct (price, tax, total)

#### 4.3 Error Handling
- [ ] Test with missing Odoo credentials (should show error)
- [ ] Test with invalid product reference (should log error, continue)
- [ ] Test with duplicate order (should skip or update)

---

## 5. Unified Reports Page

### Files Created
- `/backend/src/public/app/amazon-reports.html` (NEW)

### Test Cases

#### 5.1 Page Navigation
- [ ] Navigate to `http://localhost:3000/app/amazon-reports.html`
- [ ] Verify page loads correctly
- [ ] Check all report type options appear in dropdown

#### 5.2 Report Type Selection
- [ ] Select "VCS Tax Report" - verify description updates
- [ ] Select "FBA Inventory" - verify description updates
- [ ] Select "FBA Returns" - verify description updates
- [ ] Select "Settlement Report" - verify description updates

#### 5.3 File Upload
- [ ] Test drag & drop upload
- [ ] Test click-to-select upload
- [ ] Verify wrong file type shows error
- [ ] Verify upload progress is shown

---

## 6. Amazon Config Page Links

### Files Modified
- `/backend/src/public/app/amazon-config.html` (MODIFIED - added navigation links)

### Test Cases
- [ ] Navigate to `http://localhost:3000/app/amazon-config.html`
- [ ] Verify "VCS Tax Reports" link appears
- [ ] Click link and verify it goes to `/app/amazon-vcs.html`
- [ ] Verify "Reports Upload" link appears
- [ ] Click link and verify it goes to `/app/amazon-reports.html`

---

## 7. Index.js Exports

### Files Modified
- `/backend/src/services/amazon/index.js` (MODIFIED - added new exports)

### Test Cases
- [ ] Import all new services in a test script:
```javascript
const {
  VcsTaxReportParser,
  VcsOdooInvoicer,
  FbaInventoryReportParser,
  ReturnsReportParser,
  VAT_RATES,
  MARKETPLACE_JOURNALS,
  FISCAL_POSITIONS,
  FBA_WAREHOUSES,
  RETURN_REASONS,
  DISPOSITIONS,
} = require('./services/amazon');

// Verify each is defined
console.log('VcsTaxReportParser:', typeof VcsTaxReportParser);
console.log('VcsOdooInvoicer:', typeof VcsOdooInvoicer);
// etc.
```

---

## Debug Commands

### Check Server Logs
```bash
# Start server with verbose logging
cd /Users/nimavakil/Agent5/backend
npm run dev

# Watch logs for errors
tail -f logs/app.log
```

### Test Odoo Connection Directly
```bash
cd /Users/nimavakil/Agent5/backend
node -e "
const { OdooDirectClient } = require('./src/core/agents/integrations/OdooMCP');
const client = new OdooDirectClient();
client.authenticate().then(() => console.log('Connected!')).catch(e => console.error('Failed:', e.message));
"
```

### Test MongoDB Connection
```bash
# Check if MongoDB is running
mongosh --eval "db.adminCommand('ping')"

# Check amazon_vcs_orders collection
mongosh agent5 --eval "db.amazon_vcs_orders.find().limit(3).pretty()"
```

---

## Known Issues to Watch For

1. **Date Parsing** - VCS dates are in format "06-Dec-2025 UTC" - verify this parses correctly
2. **Currency Handling** - Non-EUR currencies need proper Odoo currency IDs
3. **Fiscal Positions** - OSS fiscal positions must exist in Odoo for each EU country
4. **Customer Creation** - May need to create customer records if they don't exist
5. **Product Mapping** - SKUs must be resolvable to Odoo product IDs

---

## Tomorrow's Priority Order

1. **Start with VCS upload** - This is the core workflow
2. **Test preview (dry run)** - Safe to test, no side effects
3. **Test actual invoice creation** - Do this on a small batch first
4. **Verify in Odoo** - Log into Odoo and check the invoices
5. **Test error cases** - Missing products, duplicate orders, etc.
6. **Test FBA Inventory** - Secondary priority
7. **Test Returns** - Tertiary priority

---

## Sample Test Files Needed

You'll need actual report files from Amazon Seller Central:
- VCS Tax Report CSV (Reports → Tax Document Library)
- FBA Inventory Report CSV (Reports → Fulfillment → Inventory)
- FBA Returns Report CSV (Reports → Fulfillment → Customer Returns)

---

## Contact Points

If issues arise:
- Check `/Users/nimavakil/Agent5/backend/logs/` for error logs
- MongoDB collections: `amazon_vcs_orders`, `amazon_vcs_reports`, `amazon_fba_inventory`, `amazon_returns`
- Odoo: https://acropaq.odoo.com (login as nima@acropaq.com)

---

*Generated: December 21, 2025*
