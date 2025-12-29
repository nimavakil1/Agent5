# Dachser API Reference for Pallet Shipping

## API Credentials
- **Customer ID:** 948ac1c2-0d6b-4c8c-b589-033ccc988538
- **X-API-Key:** 5fd2d5a6-cff7-41db-bb1e-4fad16fe282f
- **Status:** Pending activation

---

## Packing Types (for Pallets)

| Code | Description | Use in Quotation | Use in Transport Order |
|------|-------------|------------------|------------------------|
| EU | Euro Pallet | EU | EU |
| EW | Disposable Pallet (one-way) | EW | EW |
| C1 | Chep Standard Pallet | C1 | C1 |
| C2 | Chep Half Pallet | C2 | C2 |
| DD | Düsseldorfer Pallet | DD | DD |
| HE | Half EU Pallet | HE | HE |
| LP | Large Packaging | LP | LP |
| IP | Industrial Pallet | IP | IP |

---

## Packing Aids (Exchange Pallets)

| Code | Description |
|------|-------------|
| EU | Euro Pallet |
| EW | Disposable Pallet (one-way) |
| C1 | Chep Standard Pallet |
| C2 | Chep Half Pallet |
| DD | Düsseldorfer Pallet |
| HE | Half EU Pallet |
| VE | Quarter EU Pallet |
| IP | Industrial Pallet |

---

## Product Codes (Delivery Speed)

| Code | Name | Description |
|------|------|-------------|
| Y | **targoflex** | Standard transit time (2 working days) - **RECOMMENDED** |
| Z | targospeed | Next working day (dependent on km-zones) |
| S | targospeed 10 | Next day by 10:00 |
| E | targospeed 12 | Next day by 12:00 |
| V | targofix | Fixed date delivery |
| R | targofix 10 | Fixed date by 10:00 |
| W | targofix 12 | Fixed date by 12:00 |
| N | classicline | Beyond entargo countries |

---

## Terms of Delivery

| Code | Description |
|------|-------------|
| 011 | Ex works (sender pays) |
| 031 | Free delivered (sender pays delivery) |
| 035 | Ex works including delivery against invoice |

---

## Transport Status Codes

| Status | Extended | Description |
|--------|----------|-------------|
| E | - | Inbound (goods received) |
| A | - | Outbound (departed) |
| A | AL | Transferred to carrier |
| R | - | On delivery |
| K | AF | Time slot for delivery |
| K | AS | Advice/Notice |
| K | AV | Acceptance refused |
| K | FA | Wrong delivery address |

### Reason Codes (with K status)
| Code | Description |
|------|-------------|
| 100 | Notice left |
| 104 | Not ordered |
| 105 | Refusal - damaged goods |
| 106 | Incorrect goods |
| 107 | Double delivery |
| 123 | Notified by phone |
| 125 | Refusal - late delivery |
| 127 | Refusal - incomplete goods |

---

## Reference Types

| Code | Description | Used In |
|------|-------------|---------|
| 003 | Delivery Note Number | All APIs |
| 007 | Purchase Order Number | All APIs |
| 100 | Customer Order Number | All APIs |
| 077 | Booking Reference (e.g., Amazon ASN) | Quotation, Transport Order |
| SN | Domino Shipment Number | Status, History, POD |

---

## Service Types (Surcharges)

| Code | Description |
|------|-------------|
| 201 | Cartage (delivery) |
| 202 | Cartage (collection) |
| 252 | Dangerous goods surcharge |
| 257 | Tail lift surcharge |
| 258 | Delivery date surcharge |
| 25H | Height surcharge |
| 25L | Long length surcharge |

---

## Collection/Delivery Notice Options

| Code | Type | Description |
|------|------|-------------|
| CN | Collection | Automated notification by SMS/email before collection |
| DN | Delivery | Automated notification by SMS/email before delivery |
| AP | Delivery | Phone call to agree delivery appointment |

---

## Typical Use Case for Acropaq

### Creating a Pallet Shipment:
```json
{
  "product": "Y",           // targoflex - standard 2 days
  "packingType": "EU",      // Euro Pallet
  "termsOfDelivery": "031", // Free delivered
  "references": [
    { "type": "100", "value": "ORDER-12345" },  // Customer order
    { "type": "003", "value": "DN-67890" }       // Delivery note
  ]
}
```

### Tracking a Shipment:
- Use Domino Shipment Number (SN) to get status
- Status "R" = On delivery
- Status "A" with extended "AL" = Delivered/Transferred

---

## API Endpoints (Expected)

Based on the codelist references:
- `quotation` - Get price quotes
- `label` - Generate shipping labels
- `shipmentstatus` - Get current status
- `shipmenthistory` - Get full history
- `pod` - Proof of delivery
- `transportorder` - Create transport orders
- `freightcosts` - Get freight costs

---

## Notes

1. **For BE/NL pallets**: Use Euro Pallet (EU) or Disposable (EW)
2. **Standard service**: Use targoflex (Y) for 2-day delivery
3. **Tracking**: Use Domino Shipment Number (SN) reference
4. **Terms**: Use 031 (Free delivered) if we pay for shipping
