# Agent System Design - Project Memory

**Last Updated:** 2024-12-20
**Status:** Planning Phase

---

## Executive Summary

Building a multi-agent AI system for inventory and purchasing optimization for a Belgium-based e-commerce company importing from China. Sells on Amazon, Bol.com, and B2B channels.

---

## Agent Architecture

### Three-Agent System

1. **Purchasing Intelligence Agent** (exists, enhancing)
   - Demand forecasting
   - Reorder calculations
   - CNY planning
   - MOQ optimization
   - B2B order consideration (e.g., Viroux back-to-school orders)

2. **Inventory Optimization Agent** (to build)
   - Slow-mover detection
   - Price/CPC experiments (PROPOSE ONLY - human executes)
   - Write-off proposals
   - Transfer cost tracking
   - Holding cost analysis
   - Creates Odoo tasks for human action

3. **Manager Agent** (to build)
   - Daily summary at 8:00 AM CET
   - Cross-agent oversight
   - Teams notifications
   - Pending approvals tracking
   - Human task follow-up

---

## PHASE 1 WORKFLOW - Agent Proposes, Human Executes

**CRITICAL: In Phase 1, agents DO NOT touch prices directly on Amazon or Bol.com!**

```
Agent detects issue → Agent creates Odoo Task → Human approves/executes →
Human marks task complete → Agent watches sales → Agent evaluates experiment
```

### Odoo Task Workflow

1. Agent creates PROJECT TASK in Odoo:
   - Title: "Reduce SKU 18009 price on Amazon.de by 15%"
   - Assigned to: Nima (initially, later rules for other users)
   - Deadline: 48 hours
   - Priority: Based on urgency
   - Description: Context, analysis, recommendation

2. Agent monitors task daily

3. If not done in 48 hours:
   - Agent sends Teams reminder
   - Human can request extension via task notes

4. If human repeatedly misses deadlines:
   - Agent escalates to Nima

5. When human marks complete + adds notes:
   - Agent reads notes (e.g., "Reduced to €15.99 on 2024-12-20")
   - Agent starts experiment monitoring

---

## Key Business Rules

### B2B Detection
- **Rule:** In Odoo, if "Sales Team = Sales" → it's a B2B order
- B2B products need manual human action for price changes
- Purchasing agent must consider B2B customer patterns (e.g., Viroux)

### Slow-Mover Definition
- **Threshold:** >6 months of stock on hand
- **Red flag:** No sales for 1 month (immediate action needed)

### Automatic Status Detection (NOT Manual Flags!)

| Status | Auto-Detection Method |
|--------|----------------------|
| AWAITING_STOCK | Read PO delivery dates from Odoo |
| NEW_LISTING | Product created recently, no sales history yet |
| SEASONAL | Learn from historical patterns |
| DISCONTINUED | "Can be purchased = FALSE" in Odoo |

### Experiment Parameters
- **Watch period:** 14 days maximum
- **Early stop:** Can stop after 7 days if clear trend
- **Daily monitoring:** Agent watches sales daily during experiment

### Financial Parameters
- **Cost of capital:** 5% per year
- **Warehouse costs:** Provided via UI (change over time)
- **Transfer costs:** Provided via UI (vary by warehouse pair)

---

## SharePoint Integration

### Already Available (Existing Code)

| Component | File | Capabilities |
|-----------|------|--------------|
| SharePointAgent | `SharePointAgent.js` | Sites, folders, files, search, analyze docs |
| MicrosoftMCP | `MicrosoftMCP.js` | Teams messages, Mail, Calendar |
| OneDriveService | `onedriveService.js` | File uploads |

### Agent Document Reading

Agents will read SharePoint documents modified in last 90 days to understand:
- Supplier information and agreements
- Competitor analysis
- Seasonal planning
- Product specifications
- Business decisions

---

## Warehouse & Transfer Logic

### Fake Transfers
- Add checkbox "FAKE" in Odoo transfers
- Fake transfers = when PO destination ≠ actual destination
- Fake transfers don't incur real charges

### Shipping Patterns
1. **Direct to Amazon FBA:** Container from China → FBA directly
2. **Split shipments:** Part to FBA, part to CW/external warehouse
3. **Multiple supplier consolidation:** Combine orders from different suppliers

---

## Write-off Rules (Belgian GAAP)

Based on Belgian GAAP (Prudence Principle):
- Inventory valued at lower of cost or Net Realizable Value (NRV)
- Write-downs/write-offs when market value < cost
- Reversals permitted under Belgian GAAP if value recovers
- No specific "X months = must write off" legal rule

### Agent Triggers

| Trigger | Action | Approval |
|---------|--------|----------|
| No sales in 1 month | RED FLAG - immediate review | Auto-notify team |
| No sales in 3 months | Consider price experiments | Agent proposes |
| No sales in 6 months | Serious concern - propose action | Agent proposes |
| 3 failed price experiments | Hopeless case | Human approval for write-off |
| Physical damage | Immediate write-off | Human approval |

**All write-offs require human approval.**

---

## Human-Agent Communication

### Channels
- **Teams:** Primary communication (via existing MicrosoftMCP)
- **UI Text Field:** For human input to agents
- **Odoo Tasks:** For action items with accountability

### Example Interaction

```
Human (via UI): "We have a competitor selling 18009 at €14.99. What should we do?"

Agent analyzes:
- Our current price: €17.99
- Next delivery: 45 days
- Current stock: 180 days worth
- Holding cost: €X/month
- Competitor price gap: 17%
- BENEFIT calculation (not just turnover)

Agent proposes:
- Option A: Reduce to €15.49 (margin impact: X%, benefit: €Y)
- Option B: Increase CPC by €0.15 (cost: €Z/month, expected benefit: €W)
- Option C: Combination
- Recommendation: Option A based on BENEFIT calculation

Human approves → Agent creates Odoo Task → Human executes →
Human marks complete → Agent launches experiment → Daily monitoring
```

---

## Integration Points

### Amazon
- **Phase 1:** Agent proposes via Odoo task, human executes manually
- **Future:** Via Make.com for automated price/CPC changes

### Bol.com
- **Phase 1:** Agent proposes via Odoo task, human executes manually
- **Agent watches:** Sales after human confirms action taken
- **Status:** API issues being resolved with Bol team

### Odoo
- **Method:** XML-RPC API (OdooDirectClient)
- **Data:** Sales, stock, transfers, purchase orders, project tasks
- **Tasks:** Use project.task model for agent tasks

### Microsoft 365
- **SharePoint:** Read docs modified in last 90 days
- **Teams:** Send notifications via channel messages
- **Method:** Existing MicrosoftMCP integration

---

## Task Assignment Rules

### Initial Setup
- All tasks assigned to: Nima
- Nima reassigns to correct person

### Future Rules (to be provided)
- Price changes → Person A
- Content tasks → Person B
- Write-offs → Person C

### Deadlines
- Default: 48 hours
- Human can request extension via task notes
- Repeated misses → escalate to Nima

---

## UI Requirements

### Inventory Optimization Agent UI
- Slow-mover dashboard
- Experiment tracking panel
- Write-off candidates list
- Pending Odoo tasks view
- Configuration panel:
  - Warehouse costs (per pallet/month)
  - Transfer costs (per warehouse pair)
  - Slow-mover threshold
  - Experiment parameters

### Agent Communication Panel
- Text input for human messages to agent
- Agent response display
- Conversation history
- Context from SharePoint docs

---

## Manager Agent Daily Report

**Schedule:** 8:00 AM CET (previous day's report)
**Destination:** Teams channel

```
AI AGENTS DAILY SUMMARY - [Date]

PURCHASING AGENT
- Products analyzed: X
- Reorder recommendations: X
- CNY alerts: X

INVENTORY OPTIMIZATION
- Slow-movers detected: X
- Experiments running: X
- Experiments completed: X (results)
- Write-off candidates: X

ODOO TASKS
- Created yesterday: X
- Overdue tasks: X (with names)
- Completed yesterday: X

PENDING APPROVALS (X)
- [List of tasks needing action]

METRICS
- Holding cost saved: €X
- Experiments success rate: X%
```

---

## TODO List

### Phase 1: Foundation
- [ ] Create Agent Activity Log database schema
- [ ] Build Inventory Optimization Agent core
- [ ] Create slow-mover detection algorithm
- [ ] Build experiment tracking system
- [ ] Create Odoo task creation/monitoring
- [ ] Create agent communication panel UI

### Phase 2: SharePoint Integration
- [ ] Configure agent to read SharePoint docs (last 90 days)
- [ ] Index and understand document context
- [ ] Use docs for informed decision-making

### Phase 3: Manager Agent
- [ ] Build Manager Agent
- [ ] Create daily summary generator
- [ ] Schedule 8:00 AM CET job
- [ ] Configure Teams channel notification

### Phase 4: Task Follow-up
- [ ] Task monitoring (48-hour deadline)
- [ ] Teams reminder for overdue tasks
- [ ] Escalation logic for repeated misses

### Phase 5: Polish
- [ ] Belgian write-off documentation templates
- [ ] UI refinements
- [ ] Testing with real data
- [ ] Bol.com API connection fix

---

## Open Questions

1. ~~Belgian write-off legal requirements~~ ✓ Researched - prudence principle, NRV
2. Bol.com API issues - need follow-up session
3. ~~Amazon API~~ ✓ Phase 1 = manual, Make.com later
4. ~~Odoo task model~~ ✓ Use project.task
5. Teams channel for agent messages - which channel?

---

## Session Notes

### 2024-12-20 (Session 1)
- Defined three-agent architecture
- Clarified B2B detection via Odoo Sales Team field
- Set slow-mover threshold at 6 months
- Defined experiment parameters (14 days, early stop at 7)
- Manager Agent scheduled for 8:00 AM CET
- Human-agent communication via Teams channel + UI text field
- Need to handle exceptions (new products, content pending)
- Created this memory document

### 2024-12-20 (Session 2)
- **CRITICAL CHANGE:** Phase 1 = Agent proposes, Human executes
- Both Amazon AND Bol.com: Agent creates Odoo task, doesn't touch prices
- Odoo PROJECT tasks for accountability
- 48-hour deadline, human can request extension
- Repeated misses → escalate to Nima
- Agent can auto-detect status from Odoo data (not manual flags)
- SharePoint: Agent reads docs modified in last 90 days
- Existing MS365 integration found: SharePointAgent, MicrosoftMCP
- Agents calculate BENEFIT (not just turnover) for recommendations

