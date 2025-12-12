# Make.com Blueprints for Amazon → Agent5 Integration

These blueprint files can be imported into Make.com to sync Amazon data to Agent5.

## Prerequisites

1. **Make.com Account** - Sign up at [make.com](https://www.make.com)
2. **Amazon Seller Central Account** - Professional selling account
3. **Amazon Advertising Account** (for ads blueprints)

## How to Import Blueprints

1. Log into Make.com
2. Go to **Scenarios** → **Create a new scenario**
3. Click the **"..."** menu (top right) → **Import Blueprint**
4. Upload the `.json` file
5. Click on each module to configure connections

## Available Blueprints

| File | Description | Schedule |
|------|-------------|----------|
| `amazon-orders-sync.json` | Sync new orders | Real-time (trigger) |
| `amazon-inventory-sync.json` | Sync FBA inventory | Every 6 hours |
| `amazon-returns-sync.json` | Sync returns data | Daily |
| `amazon-financial-events-sync.json` | Sync financial events | Daily |
| `amazon-settlements-sync.json` | Sync settlement reports | Weekly |
| `amazon-fba-fees-sync.json` | Sync FBA fee reports | Monthly |
| `amazon-vat-invoices-sync.json` | Sync VAT/tax reports | Daily |
| `amazon-ads-campaigns-sync.json` | Sync ad campaigns | Daily |
| `amazon-ads-performance-sync.json` | Sync ad performance | Daily |

## Configuration Steps

### Step 1: Create Amazon Seller Central Connection

1. After importing a blueprint, click on the **Amazon Seller Central** module
2. Click **"Create a connection"**
3. Name it: `ACROPAQ Amazon Seller`
4. Select your **Region** (Europe, North America, Far East)
5. Select your **Marketplace** (e.g., Germany = `amazon.de`)
6. Click **Save**
7. You'll be redirected to Amazon - **Authorize** the connection

### Step 2: Create Amazon Advertising Connection (for ads blueprints)

1. Click on the **Amazon Advertising** module
2. Click **"Create a connection"**
3. Name it: `ACROPAQ Amazon Ads`
4. You'll be redirected to Amazon Advertising - **Authorize** the connection

### Step 3: Update Marketplace ID (if not Germany)

The blueprints default to Germany (`A1PA6795UKMFR9`). If you sell in other marketplaces, update the `marketplaceIds` in the API calls:

| Country | Marketplace ID |
|---------|---------------|
| Germany | `A1PA6795UKMFR9` |
| UK | `A1F83G8C2ARO7P` |
| France | `A13V1IB3VIYBER` |
| Italy | `APJ6JRA9NG5V4` |
| Spain | `A1RKKUPIHCS9HS` |
| Netherlands | `A1805IZSGTT6HS` |
| Belgium | `AMEN7PMS3EDWL` |
| US | `ATVPDKIKX0DER` |

### Step 4: Test & Activate

1. Click **"Run once"** to test the scenario
2. Check Agent5's Amazon config page: `https://ai.acropaq.com/app/amazon-config.html`
3. If data arrives correctly, toggle the scenario **ON**

## Agent5 Webhook Endpoints

All data is sent to these endpoints:

```
https://ai.acropaq.com/api/amazon/webhook/orders
https://ai.acropaq.com/api/amazon/webhook/inventory
https://ai.acropaq.com/api/amazon/webhook/returns
https://ai.acropaq.com/api/amazon/webhook/settlements
https://ai.acropaq.com/api/amazon/webhook/fba-fees
https://ai.acropaq.com/api/amazon/webhook/vat-invoices
https://ai.acropaq.com/api/amazon/webhook/financial-events
https://ai.acropaq.com/api/amazon/webhook/report
https://ai.acropaq.com/api/amazon/webhook/ads/campaigns
https://ai.acropaq.com/api/amazon/webhook/ads/performance
https://ai.acropaq.com/api/amazon/webhook/ads/keywords
https://ai.acropaq.com/api/amazon/webhook/ads/products
```

## Troubleshooting

### "Access Denied" from Amazon API
- Make sure your Amazon Seller Central account is a **Professional** account
- Check that you authorized Make.com with the correct permissions

### No data arriving in Agent5
- Check the Make.com execution logs for errors
- Verify the webhook URL is correct
- Test the webhook manually using the test buttons on the Agent5 config page

### Report not ready
- Some reports take time to generate (1-5 minutes)
- The blueprints include `Sleep` modules to wait for report completion
- You may need to increase the sleep time for large reports

## Support

- Agent5 Issues: Check the server logs with `pm2 logs`
- Make.com Issues: Check the scenario execution history
