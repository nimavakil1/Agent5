# Claude Code Project Notes

## Production Server Access

**SSH Command:**
```bash
sshpass -p 'Sage2o15@' ssh -o StrictHostKeyChecking=no ubuntu@ai.acropaq.com
```

**Server Details:**
- Host: `ai.acropaq.com`
- User: `ubuntu`
- Password: `Sage2o15@`
- Agent5 Path: `/home/ubuntu/Agent5`
- Process Manager: PM2

**Common Commands:**
```bash
# Pull latest code
sshpass -p 'Sage2o15@' ssh -o StrictHostKeyChecking=no ubuntu@ai.acropaq.com "cd /home/ubuntu/Agent5 && git pull"

# Restart the app
sshpass -p 'Sage2o15@' ssh -o StrictHostKeyChecking=no ubuntu@ai.acropaq.com "cd /home/ubuntu/Agent5 && pm2 restart all"

# Check logs
sshpass -p 'Sage2o15@' ssh -o StrictHostKeyChecking=no ubuntu@ai.acropaq.com "cd /home/ubuntu/Agent5 && pm2 logs --lines 50"

# Check status
sshpass -p 'Sage2o15@' ssh -o StrictHostKeyChecking=no ubuntu@ai.acropaq.com "pm2 status"
```

## Production URL
**https://ai.acropaq.com** (no /v2 - that's TicketingSDT, not this project)

## Pending Testing

**IMPORTANT:** There is a testing plan that needs to be completed:
- **File:** `/Users/nimavakil/Agent5/backend/TESTING_PLAN_2025-12-21.md`
- **Created:** December 21, 2025
- **Contents:** Comprehensive testing plan for Amazon VCS, FBA Inventory, Returns parsers, and Odoo invoice creation

When the user mentions testing or asks about what needs to be done, refer to this testing plan.

## Recent Development (Dec 21, 2025)

### Amazon Integration
- VCS Tax Report upload and parsing (`/services/amazon/VcsTaxReportParser.js`)
- FBA Inventory Report parsing (`/services/amazon/FbaInventoryReportParser.js`)
- Returns Report parsing (`/services/amazon/ReturnsReportParser.js`)
- Odoo invoice creation from VCS data (`/services/amazon/VcsOdooInvoicer.js`)
- UI pages: `/public/app/amazon-vcs.html`, `/public/app/amazon-reports.html`

### Odoo Credentials (in .env)
```
ODOO_URL=https://acropaq.odoo.com
ODOO_DB=ninicocolala-v16-fvl-fvl-7662670
ODOO_USERNAME=info@acropaq.com  # IMPORTANT: Always use info@acropaq.com, NEVER nima@acropaq.com
```

### Independent Fields Policy
All Odoo fields and views created by Agent5 must be independent of third-party modules:
- Custom fields use `x_` prefix (e.g., `x_vcs_invoice_url`)
- Views are modified directly via Developer Mode / XML-RPC, not via custom modules
- This ensures clean Odoo upgrades without third-party dependencies

## Purchasing Intelligence Agent

Fully implemented in:
- `/core/agents/specialized/PurchasingIntelligenceAgent.js`
- `/core/agents/services/ForecastEngine.js`
- `/core/agents/services/SeasonalCalendar.js`
- `/core/agents/services/SupplyChainManager.js`
- `/core/agents/services/StockoutAnalyzer.js`
- `/api/routes/purchasing.api.js`
