# Amazon Complete Integration Plan

## Executive Summary

This document outlines a comprehensive integration with Amazon's APIs to enable:
1. **Exact margin calculation** per order line/product
2. **Financial reconciliation** between Amazon payments and Odoo
3. **Automated data sync** for sales, inventory, returns, and advertising
4. **AI-powered profitability optimization**

---

## 1. Amazon APIs Overview

Amazon has **TWO SEPARATE API SYSTEMS**:

| API System | Purpose | Authentication |
|------------|---------|----------------|
| **SP-API** (Selling Partner API) | Sales, orders, inventory, finances, reports | LWA OAuth 2.0 |
| **Amazon Advertising API** | Sponsored Products, Brands, Display campaigns | OAuth 2.0 |

---

## 2. Data Sources for Exact Margin Calculation

To calculate the **exact margin per order line**, we need to capture:

### Revenue Components
| Data Point | Source API | Report/Endpoint |
|------------|------------|-----------------|
| Product Sale Price | SP-API Orders | Orders API |
| Shipping Revenue | SP-API Orders | Orders API |
| Gift Wrap Revenue | SP-API Finances | Financial Events |

### Cost Components (Amazon Fees)
| Fee Type | Source | Report Type |
|----------|--------|-------------|
| **Referral Fee** (Commission) | Finances API | `ListFinancialEvents` |
| **FBA Fulfillment Fee** | Finances API / Reports | `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` |
| **Storage Fee** (Monthly) | Reports API | `GET_FBA_STORAGE_FEE_CHARGES_DATA` |
| **Long-term Storage Fee** | Reports API | `GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA` |
| **Removal Order Fee** | Finances API | Financial Events |
| **Returns Processing Fee** | Finances API | Financial Events |
| **Variable Closing Fee** | Finances API | Financial Events |
| **High-Volume Listing Fee** | Finances API | Financial Events |
| **Refund Admin Fee** | Finances API | Financial Events |
| **Advertising Cost (PPC)** | Advertising API | Campaign Reports |

### Additional Cost Data
| Cost Type | Source |
|-----------|--------|
| Product COGS | Odoo (Product Cost) |
| Inbound Shipping to FBA | Odoo (Purchase Orders) |
| Prep/Labeling Fees | Odoo (Custom Fields) |

---

## 3. Complete SP-API Capabilities

### 3.1 Orders & Fulfillment
| API | Key Operations | Use Case |
|-----|----------------|----------|
| **Orders API** | getOrders, getOrder, getOrderItems | Sync all orders to Odoo |
| **Fulfillment Outbound** | createFulfillmentOrder, getFulfillmentOrder | Multi-channel fulfillment |
| **FBA Inventory API** | getInventorySummaries | Real-time stock levels |

### 3.2 Financial Data
| API | Key Operations | Use Case |
|-----|----------------|----------|
| **Finances API** | listFinancialEvents, listFinancialEventGroups | All fees, refunds, adjustments |
| **Settlement Reports** | GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 | Bi-weekly payment reconciliation |

### 3.3 Catalog & Pricing
| API | Key Operations | Use Case |
|-----|----------------|----------|
| **Catalog Items API** | searchCatalogItems, getCatalogItem | Product data sync |
| **Product Pricing API** | getCompetitivePricing, getItemOffers | Price monitoring |
| **Product Fees API** | getMyFeesEstimates | Fee estimation for pricing |

### 3.4 Reports (Key Report Types)

#### Financial Reports
| Report Type | Description |
|-------------|-------------|
| `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | Bi-weekly settlement with all fees |
| `GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT` | VCS VAT invoice data (EU) |
| `GET_AMAZON_FULFILLED_SHIPMENTS_DATA_INVOICING` | FBA shipments for invoicing |

#### FBA Reports
| Report Type | Description |
|-------------|-------------|
| `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` | Estimated FBA fees per SKU |
| `GET_FBA_STORAGE_FEE_CHARGES_DATA` | Monthly storage fees |
| `GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA` | Long-term storage fees |
| `GET_FBA_INVENTORY_AGED_DATA` | Inventory age report |
| `GET_AFN_INVENTORY_DATA` | Current FBA inventory |
| `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA` | Returns data |

#### Sales Reports
| Report Type | Description |
|-------------|-------------|
| `GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL` | Detailed shipment data |
| `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` | All orders by date |
| `GET_SALES_AND_TRAFFIC_REPORT` | Sales and traffic metrics |

### 3.5 VCS (VAT Calculation Service) - EU Only
| Feature | Description |
|---------|-------------|
| **VAT Invoice Data Report** | Contains all data to generate VAT-compliant invoices |
| **Invoice Upload Feed** | Upload your own invoices to Amazon |
| **Amazon Invoice Generation** | Let Amazon create invoices automatically |

---

## 4. Amazon Advertising API Capabilities

### 4.1 Campaign Management
| Feature | Description |
|---------|-------------|
| **Sponsored Products** | Product-level PPC ads |
| **Sponsored Brands** | Brand awareness campaigns |
| **Sponsored Display** | Retargeting and display ads |

### 4.2 Advertising Reports
| Report Type | Metrics |
|-------------|---------|
| **Campaign Reports** | Impressions, clicks, spend, sales, ACOS, ROAS |
| **Search Term Reports** | Which keywords drive sales |
| **Product Targeting Reports** | ASIN-level performance |
| **Placement Reports** | Top of search vs rest of search |

---

## 5. Make.com Scenarios to Build

### 5.1 Core Data Sync Scenarios

#### Scenario 1: Orders Sync
```
Trigger: Schedule (every 15 min)
Actions:
  1. Amazon: Search Orders (last 15 min)
  2. For each order:
     - Amazon: Get Order Items
     - Odoo: Create/Update Sale Order
     - MongoDB: Store raw order data
```

#### Scenario 2: Settlement Report Sync
```
Trigger: Schedule (daily)
Actions:
  1. Amazon: Search for new settlement reports
  2. If found:
     - Amazon: Download Report
     - Parse CSV data
     - For each transaction:
       - Calculate fees per order
       - Update Odoo invoice with fees
       - MongoDB: Store for analytics
```

#### Scenario 3: Financial Events Sync
```
Trigger: Schedule (every 4 hours)
Actions:
  1. Amazon: Make API Call (listFinancialEvents)
  2. For each event:
     - Categorize (fee, refund, adjustment)
     - Match to order/SKU
     - Odoo: Create journal entries
     - MongoDB: Store for reporting
```

#### Scenario 4: VCS Invoice Sync (EU)
```
Trigger: Schedule (twice daily)
Actions:
  1. Amazon: Create Report (GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT)
  2. Amazon: Get Report (wait for completion)
  3. Amazon: Download Report
  4. For each invoice:
     - Odoo: Create customer invoice
     - Attach as official VAT invoice
```

#### Scenario 5: FBA Fees Sync
```
Trigger: Schedule (weekly)
Actions:
  1. Amazon: Create Report (GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA)
  2. Download and parse
  3. For each SKU:
     - Odoo: Update product with current FBA fees
     - Recalculate profit margins
```

#### Scenario 6: Inventory Sync
```
Trigger: Schedule (every 30 min)
Actions:
  1. Amazon: Make API Call (FBA Inventory)
  2. For each SKU:
     - Odoo: Update Amazon warehouse stock
     - Check for low stock alerts
```

### 5.2 Advertising Scenarios

#### Scenario 7: Advertising Campaign Sync
```
Trigger: Schedule (daily)
Actions:
  1. Amazon Ads API: Get all campaigns
  2. Amazon Ads API: Get campaign performance metrics
  3. For each campaign:
     - MongoDB: Store performance data
     - Calculate ACOS, ROAS, TACoS
```

#### Scenario 8: Advertising Cost Attribution
```
Trigger: Schedule (daily)
Actions:
  1. Amazon Ads API: Get campaign reports by SKU
  2. For each SKU:
     - Calculate daily ad spend
     - Attribute to orders from that day
     - Update margin calculation
```

### 5.3 Reconciliation Scenarios

#### Scenario 9: Payment Reconciliation
```
Trigger: Webhook (Bank transaction received)
Actions:
  1. Match payment to settlement period
  2. Amazon: Get settlement report for period
  3. Odoo: Reconcile payment with invoices
  4. Flag discrepancies for review
```

#### Scenario 10: Returns Processing
```
Trigger: Schedule (every 2 hours)
Actions:
  1. Amazon: Create Report (GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA)
  2. Download and parse
  3. For each return:
     - Odoo: Create credit note
     - Update inventory
     - Track return reason for analytics
```

---

## 6. Margin Calculation Formula

```
Net Margin = Revenue - Amazon Fees - COGS - Ad Spend - Other Costs

Where:
  Revenue = Sale Price + Shipping Revenue

  Amazon Fees =
    + Referral Fee (usually 15%)
    + FBA Pick & Pack Fee
    + FBA Weight Handling Fee
    + Storage Fees (prorated)
    + Variable Closing Fee (media only)
    + Refund Admin Fee (if applicable)

  COGS = Product Cost (from Odoo)

  Ad Spend = PPC Cost attributed to this sale

  Other Costs =
    + Inbound shipping to FBA
    + Prep/labeling
    + Returns (if applicable)
```

---

## 7. Database Schema for Amazon Data

### MongoDB Collections

```javascript
// amazon_orders
{
  orderId: "123-456-789",
  purchaseDate: ISODate("2025-01-15"),
  orderItems: [{
    asin: "B00XYZ123",
    sku: "SKU-001",
    quantity: 2,
    itemPrice: 29.99,
    shippingPrice: 0,
    fees: {
      referral: 4.50,
      fbaFulfillment: 3.87,
      variableClosing: 0
    }
  }],
  odooOrderId: 12345
}

// amazon_settlements
{
  settlementId: "123456789",
  startDate: ISODate("2025-01-01"),
  endDate: ISODate("2025-01-14"),
  totalAmount: 15234.56,
  transactions: [...],
  reconciled: true,
  odooPaymentId: 789
}

// amazon_advertising
{
  date: ISODate("2025-01-15"),
  campaignId: "123",
  campaignName: "Product Launch",
  impressions: 50000,
  clicks: 250,
  spend: 125.00,
  sales: 450.00,
  acos: 0.278,
  skuBreakdown: [...]
}

// product_margins
{
  sku: "SKU-001",
  asin: "B00XYZ123",
  date: ISODate("2025-01-15"),
  unitsSold: 10,
  revenue: 299.90,
  cogs: 100.00,
  amazonFees: 85.50,
  adSpend: 12.50,
  netMargin: 101.90,
  marginPercent: 0.34
}
```

---

## 8. Implementation Priority

### Phase 1: Foundation (High Priority)
1. Orders sync (Orders API)
2. Settlement reports sync (for payment reconciliation)
3. Financial events sync (for fee tracking)
4. VCS invoice sync (for EU compliance)

### Phase 2: Complete Financial Picture
5. FBA fee reports sync
6. Advertising cost attribution
7. Inventory sync

### Phase 3: Optimization
8. Price change automation
9. Advertising bid optimization
10. Demand forecasting integration

---

## 9. Technical Requirements

### Make.com Configuration
- Amazon Seller Central connection (SP-API)
- Amazon Advertising connection (separate)
- Odoo connection
- MongoDB connection
- Webhook endpoints for real-time events

### SP-API Access Requirements
- Developer registration
- App registration in Seller Central
- Required permissions:
  - Orders (read)
  - Inventory (read)
  - Finances (read)
  - Reports (read/write)
  - Feeds (read/write) - for VCS

### Important Notes
1. **PII Restriction**: Make.com cannot access PII (customer names, addresses) through the standard module. Use "Make an API Call" with proper authorization for restricted data.
2. **Rate Limits**: SP-API has rate limits per operation. Implement proper throttling.
3. **Settlement Reports**: Cannot be requested on demand - Amazon generates them bi-weekly.
4. **Advertising API is Separate**: Requires separate credentials and connection.

---

## 10. Sources

- [Amazon SP-API Documentation](https://developer-docs.amazon.com/sp-api)
- [SP-API Models](https://developer-docs.amazon.com/sp-api/docs/sp-api-models)
- [SP-API Settlement Reports](https://developer-docs.amazon.com/sp-api/docs/report-type-values-settlement)
- [FBA Reports](https://developer-docs.amazon.com/sp-api/docs/report-type-values-fba)
- [VCS Guide](https://developer-docs.amazon.com/sp-api/docs/vat-calculation-service-guide)
- [Finances API](https://developer-docs.amazon.com/sp-api/docs/finances-api-v0-reference)
- [Amazon Advertising API](https://advertising.amazon.com/API/docs/en-us)
- [Make.com Amazon Module](https://www.make.com/en/integrations/amazon-seller-central)
