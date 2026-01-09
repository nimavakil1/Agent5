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

## ACRODOO - Natural Language Odoo Assistant (Jan 2025)

**Full Specifications:** See `/ACRODOO_BUILD.md` in project root

### What is ACRODOO?
ACRODOO is an AI-powered conversational interface that lets users interact with Odoo using natural language instead of navigating complex menus. It's the "intelligence layer" on top of Odoo.

### Key Files
- `/core/agents/specialized/AcrodooAgent.js` - Main agent class
- `/core/agents/specialized/AcrodooTools.js` - Tool definitions
- `/api/routes/acrodoo.api.js` - API endpoints
- `/models/AcrodooConversation.js` - Chat history model
- `/public/acrodoo/` - Frontend UI

### Architecture
```
User → Chat UI → /api/acrodoo/chat → AcrodooAgent → OdooDirectClient → Odoo
                                          ↓
                                   Claude API (Anthropic)
```

### Safety Rules (CRITICAL)
1. NEVER execute unlink/delete operations
2. ALWAYS show preview before writes
3. REQUIRE explicit user approval for writes
4. Log all operations to AuditLog
5. Offer alternatives (archive/cancel/reverse) instead of delete

### Odoo Models Reference
| Model | Use | Key Fields |
|-------|-----|------------|
| res.partner | Customers/Suppliers | name, email, phone, is_company |
| sale.order | Sales Orders | name, partner_id, date_order, amount_total, state |
| account.move | Invoices | name, invoice_date, amount_total, state, payment_state |
| stock.picking | Deliveries | name, scheduled_date, state |
| product.product | Products | name, default_code, qty_available |
| purchase.order | Purchase Orders | name, date_order, amount_total, state |

### Testing Checklist
- [ ] "Show me today's orders" → Should query sale.order
- [ ] "Find customer X" → Should search res.partner
- [ ] "Create customer Test B.V." → Should preview, then create after approval
- [ ] "Delete order 123" → Should REFUSE and suggest cancel instead
