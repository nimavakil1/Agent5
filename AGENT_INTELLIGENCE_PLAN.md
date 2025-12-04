# ACROPAQ AI Agent Intelligence Upgrade Plan

## Executive Summary

Transform the current "dumb" agents into intelligent, company-aware AI employees that understand ACROPAQ's business, master all integrated systems, and work together as a cohesive team.

---

## Phase 1: Company Knowledge Base & Training Interface

### 1.1 Knowledge Management UI

Create a new **"AI Training Center"** in the dashboard where you can:

- **Upload Documents**: Product catalogs, SOPs, org charts, supplier agreements, pricing sheets
- **Add Text Knowledge**: Company history, business rules, decision criteria
- **Define Personas**: Who each agent should "be" (e.g., "You are the CFO of ACROPAQ...")
- **Set Business Rules**: Approval thresholds, escalation criteria, priority rules
- **Record Examples**: Show agents how to handle specific scenarios

### 1.2 Knowledge Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ACROPAQ Knowledge Base                    │
├─────────────────────────────────────────────────────────────┤
│  Company Profile     │  Business Rules    │  Integration     │
│  - History           │  - Approvals       │  Knowledge       │
│  - Products          │  - Pricing         │  - Odoo models   │
│  - Team structure    │  - Escalations     │  - Amazon APIs   │
│  - Customers         │  - Priorities      │  - Bol.com flows │
├─────────────────────────────────────────────────────────────┤
│                    Vector Database (RAG)                     │
│         Embeddings of all documents & knowledge              │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 2: Best LLM Selection (December 2025)

Based on current research, here's the optimal LLM for each task type:

### 2.1 LLM Recommendations by Task

| Task Type | Best Model | Why | Pricing |
|-----------|------------|-----|---------|
| **Manager/CEO Agent** (strategic decisions, orchestration) | **Claude Opus 4.5** | Best for complex reasoning, 80.9% SWE-bench, superior agentic capabilities | $5/M input, $25/M output |
| **Finance Agent** (Odoo, invoices, analysis) | **Claude Opus 4.5** | Excellent at structured data, tool use (69.2% TAU-bench), reliable | $5/M input, $25/M output |
| **Coding/Technical Tasks** | **GPT-5.1-Codex-Max** | SOTA diff editing, shell commands, fastest for code | Variable |
| **Long Document Analysis** | **Gemini 3 Pro** | 1M token context, 81% MMMU-Pro, best multimodal | Competitive |
| **Fast Simple Queries** | **GPT-5.1 Instant** | 2-3x faster, adaptive reasoning, cheap for simple tasks | Low cost |
| **Complex Reasoning** | **Claude Opus 4.5 Extended Thinking** or **Gemini 3 Deep Think** | Best for novel problems | Higher cost |

### 2.2 Recommended Primary Stack

```
Primary:     Claude Opus 4.5 (claude-opus-4-5-20251101)
             - Manager Agent, Finance Agent, complex decisions

Secondary:   GPT-5.1 (for speed-critical tasks)
             - Quick lookups, simple queries

Specialist:  Gemini 3 Pro (for multimodal/long context)
             - Document analysis, image processing
```

### 2.3 API Keys Required

You'll need API keys for:
1. **Anthropic** (Claude Opus 4.5) - https://console.anthropic.com
2. **OpenAI** (GPT-5.1) - Already have
3. **Google AI** (Gemini 3 Pro) - https://aistudio.google.com

---

## Phase 3: Agent Architecture Redesign

### 3.1 New Agent Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     ACROPAQ AI Team                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              CEO Agent (Manager)                     │   │
│   │  Model: Claude Opus 4.5 Extended Thinking            │   │
│   │  Role: Strategic decisions, orchestration            │   │
│   │  Knowledge: Full company context                     │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│       ┌───────────────────┼───────────────────┐             │
│       │                   │                   │             │
│   ┌───┴───┐          ┌───┴───┐          ┌───┴───┐          │
│   │Finance│          │ Sales │          │  Ops  │          │
│   │ Agent │          │ Agent │          │ Agent │          │
│   │Claude │          │Claude │          │Claude │          │
│   │Opus4.5│          │Opus4.5│          │Opus4.5│          │
│   └───┬───┘          └───┬───┘          └───┬───┘          │
│       │                   │                   │             │
│   ┌───┴───┐          ┌───┴───┐          ┌───┴───┐          │
│   │ Odoo  │          │Amazon │          │Inventory│         │
│   │Bol.com│          │Bol.com│          │Shipping │         │
│   │Invoices│         │Orders │          │Suppliers│         │
│   └───────┘          └───────┘          └───────┘          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Agent Capabilities Matrix

| Agent | Systems | Decisions Can Make | Escalates When |
|-------|---------|-------------------|----------------|
| CEO/Manager | All | Strategic, cross-department | Never (top level) |
| Finance | Odoo, Banking | Invoices <€5000, routine payments | Large amounts, disputes |
| Sales | Amazon, Bol.com | Pricing <10%, inventory allocation | Major pricing, new products |
| Ops | Inventory, Shipping | Reorders, shipping methods | Supplier issues, stockouts |
| Support | Email, Teams | Routine responses | Complaints, refunds |

---

## Phase 4: RAG Implementation

### 4.1 Document Processing Pipeline

```
Upload Document → Extract Text → Chunk → Embed → Store in Vector DB
                                          ↓
                              Query → Retrieve → Augment Prompt → LLM
```

### 4.2 Technology Stack

- **Vector Database**: Pinecone, Weaviate, or Chroma
- **Embeddings**: OpenAI text-embedding-3-large or Mistral Embed
- **Document Processing**: LlamaIndex or LangChain
- **Storage**: MongoDB (metadata) + Vector DB (embeddings)

### 4.3 Knowledge Categories to Index

1. **Products**: All product info, costs, margins, suppliers
2. **Customers**: Key accounts, preferences, history
3. **Processes**: How things work at ACROPAQ
4. **Policies**: Pricing rules, approval thresholds, escalation criteria
5. **History**: Past decisions, outcomes, learnings

---

## Phase 5: Implementation Roadmap

### Week 1-2: Foundation
- [ ] Set up Anthropic API (Claude Opus 4.5)
- [ ] Create Knowledge Base database schema
- [ ] Build "AI Training Center" UI
- [ ] Implement document upload & processing

### Week 3-4: RAG System
- [ ] Set up vector database
- [ ] Implement embedding pipeline
- [ ] Create retrieval system
- [ ] Integrate with agents

### Week 5-6: Agent Upgrade
- [ ] Switch agents to Claude Opus 4.5
- [ ] Implement company context injection
- [ ] Add memory/persistence
- [ ] Create agent personas

### Week 7-8: Integration Mastery
- [ ] Deep Odoo integration (all models)
- [ ] Amazon SP-API full integration
- [ ] Bol.com full integration
- [ ] Microsoft 365 (Outlook, Teams, SharePoint)

### Week 9-10: Testing & Refinement
- [ ] Test all agent scenarios
- [ ] Fine-tune prompts
- [ ] Add more training data
- [ ] Performance optimization

---

## Phase 6: What You Need to Provide

### 6.1 Company Documentation

Please gather and prepare:

1. **Company Overview**
   - Company history and mission
   - Organizational chart
   - Key team members and roles

2. **Products & Catalog**
   - Full product list with codes
   - Cost prices and margins
   - Supplier information
   - Product categories

3. **Business Processes**
   - Order fulfillment workflow
   - Invoice processing workflow
   - Customer service procedures
   - Inventory management rules

4. **Business Rules**
   - Pricing rules and discounts
   - Approval thresholds
   - Escalation criteria
   - Priority definitions

5. **System Access**
   - Anthropic API key (Claude)
   - Google AI API key (Gemini) - optional
   - Microsoft 365 admin access (for Outlook/Teams/SharePoint)

### 6.2 Training Examples

Prepare 10-20 examples of:
- "When a customer asks X, we respond Y"
- "When inventory drops below X, we do Y"
- "When an invoice is disputed, we do Y"

---

## Cost Estimates

### Monthly LLM Costs (Estimated)

| Model | Usage Estimate | Monthly Cost |
|-------|---------------|--------------|
| Claude Opus 4.5 | 10M tokens/month | ~$150 |
| GPT-5.1 (backup) | 5M tokens/month | ~$50 |
| Embeddings | 1M tokens/month | ~$10 |
| Vector DB | Storage + queries | ~$20 |
| **Total** | | **~$230/month** |

---

## Success Metrics

After implementation, the agents should be able to:

1. **Answer company-specific questions**: "What's our margin on product 18009?"
2. **Make informed decisions**: "Should we reorder from Supplier X or Y?"
3. **Work autonomously**: Handle routine tasks without human intervention
4. **Collaborate**: Pass context between agents seamlessly
5. **Learn**: Improve from feedback and new information

---

## Next Steps

1. **Review this plan** and provide feedback
2. **Gather documentation** listed in Phase 6
3. **Get Anthropic API key** for Claude Opus 4.5
4. **Confirm budget** for monthly LLM costs
5. **Start Phase 1** - Build the AI Training Center UI

---

## Sources

- [Claude Opus 4.5 Announcement](https://www.anthropic.com/news/claude-opus-4-5)
- [GPT-5.1 for Developers](https://openai.com/index/gpt-5-1-for-developers/)
- [Google Gemini 3 Launch](https://blog.google/products/gemini/gemini-3/)
- [Building Effective AI Agents - Anthropic](https://www.anthropic.com/research/building-effective-agents)
- [LLM Leaderboard](https://artificialanalysis.ai/leaderboards/models)
