# Security Implementation TODOs

**Created:** January 16, 2026
**Context:** Amazon SP-API Restricted Access Request submitted. These features were declared in the security questionnaire and need to be implemented.

**Request Status:** Waiting for Amazon response (~2 weeks)

---

## 1. Data Protection & Privacy

- [ ] **PII Anonymization in Odoo** - Auto-delete/anonymize customer data after 90 days
  - Applies to: shipping addresses, customer names, phone numbers
  - Implementation: Scheduled job to anonymize old order data

## 2. Access Controls

- [ ] **Implement MFA** for all Amazon data access
- [ ] **Implement Password Policy**
  - Min 12 characters
  - Complexity requirements (upper, lower, numbers, special)
  - 90-day expiration
  - Cannot reuse last 5 passwords
  - Lockout after 5 failed attempts

## 3. Infrastructure

- [ ] **Migrate MongoDB to Atlas** (currently localhost - no encryption at rest)
  - Or enable encryption at rest on current setup
- [ ] **Implement Automated Daily Backups**
- [ ] **Configure Geo-Separated Backup Storage** (EU-Central/Frankfurt)
  - Primary: EU-West (Belgium)
  - Backup: EU-Central (Frankfurt)
  - 400km minimum separation
- [ ] **Document Restore Procedure** with RTO (4hrs) / RPO (24hrs)
- [ ] **Test restore procedure quarterly**

## 4. Logging & Monitoring

- [ ] **Implement Security Logging**
  - User ID, timestamp, IP address, action performed
  - Authentication events
  - SP-API calls
  - 12-month retention
- [ ] **Implement Access Logging for Amazon Data**
- [ ] **Implement Monitoring Dashboard**
  - Real-time system health
  - Access patterns visualization
- [ ] **Implement Alert System**
  - Failed logins (3+ attempts)
  - Unrecognized IP/location access
  - Off-hours access
  - Bulk exports/unusual query patterns

## 5. Documentation

- [ ] **Document Incident Response Plan** (formal document)
- [ ] **Document Incident Investigation Procedures**

---

## Amazon Stock Sync Tasks (Blocked)

**Blocked by:** Waiting for Feeds API permission from Amazon

- [ ] Test FBM stock update (P0014 in BE marketplace chosen for test)
- [ ] Test FBA stock sync back to Odoo
- [ ] Add SKU mappings for unmatched Amazon FBM SKUs

---

## Notes

- SP-API Feeds permission required to push inventory updates
- Request submitted January 16, 2026
- Contact for security: nimavakil@gmail.com / +32479202020
