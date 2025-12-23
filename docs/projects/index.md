# ACROPAQ Projects Index

Central index of all active and planned projects for the Agent5 AI Platform.

---

## Active Projects

| Project | Status | Priority | Doc |
|---------|--------|----------|-----|
| Amazon Vendor Migration | Planning | High | [amazon-vendor-migration.md](./amazon-vendor-migration.md) |
| VCS Invoice Creation | In Progress | High | See CLAUDE.md |
| Settlement Reports UI | Testing | Medium | Completed 2024-12-23 |

---

## Completed Projects

| Project | Completed | Notes |
|---------|-----------|-------|
| Settlements Page UI | 2024-12-23 | `/app/amazon-settlements.html` |
| Invoice-Order Linking | 2024-12-22 | 36,768 orders linked |
| VCS Tax Report Parser | 2024-12-21 | `/services/amazon/VcsTaxReportParser.js` |

---

## Backlog / Ideas

- [ ] Bol.com integration
- [ ] Purchasing Intelligence Agent improvements
- [ ] Multi-warehouse inventory optimization
- [ ] Customer support ticketing integration

---

## Project Management Approach

**Current:** Markdown files in `/docs/projects/`

**Recommended for visibility:**
1. **GitHub Projects** - Create project board at github.com/nimavakil1/Agent5/projects
2. **GitHub Issues** - Track tasks as issues linked to projects
3. **MD files** - Keep detailed docs synced in repo

**When to use what:**
- **Quick tasks** → TODO in code/CLAUDE.md
- **Multi-step projects** → MD file + GitHub Issues
- **Long-term tracking** → GitHub Projects board

---

## Documentation Standards

### Project Document Template

```markdown
# Project Name

**Status:** Planning | In Progress | Testing | Completed
**Priority:** High | Medium | Low
**Created:** YYYY-MM-DD
**Last Updated:** YYYY-MM-DD

---

## Overview
Brief description of what this project does.

---

## Current State
What exists now.

---

## Goals
What we want to achieve.

---

## Implementation Plan
Phases and milestones.

---

## Technical Notes
Architecture decisions, code references.

---

## Open Questions
Things to clarify.

---

## Change Log
| Date | Change |
|------|--------|
```

---

## Quick Links

- **Production:** https://ai.acropaq.com
- **GitHub:** https://github.com/nimavakil1/Agent5
- **Odoo:** https://acropaq.odoo.com
- **Server SSH:** `sshpass -p 'Sage2o15@' ssh ubuntu@ai.acropaq.com`
