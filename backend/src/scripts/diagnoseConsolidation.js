/**
 * Diagnose consolidation grouping
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { connectDb, getDb } = require('../db');

function getVendorGroup(marketplaceCode) {
  const VENDOR_GROUPS = {
    'EU': { marketplaces: ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'UK'] }
  };
  for (const [group, config] of Object.entries(VENDOR_GROUPS)) {
    if (config.marketplaces.includes(marketplaceCode)) return group;
  }
  return 'EU';
}

function createConsolidationGroupId(vendorGroup, partyId, deliveryWindowEnd) {
  const vg = vendorGroup || 'UNKNOWN';
  const fcCode = partyId?.toUpperCase() || 'UNKNOWN';
  const dateStr = deliveryWindowEnd
    ? new Date(deliveryWindowEnd).toISOString().split('T')[0]
    : 'nodate';
  return `${vg}_${fcCode}_${dateStr}`;
}

async function main() {
  await connectDb();
  const db = getDb();

  const query = {
    channel: 'amazon-vendor',
    'amazonVendor.purchaseOrderState': { $in: ['New', 'Acknowledged'] },
    'amazonVendor.shipmentStatus': 'not_shipped',
    'odoo.deliveryStatus': { $ne: 'full' },
    _testData: { $ne: true }
  };

  const orders = await db.collection('unified_orders').find(query).toArray();
  console.log('Total orders:', orders.length);

  const groups = {};
  for (const order of orders) {
    const poNumber = order.sourceIds?.amazonVendorPONumber;
    const partyId = order.amazonVendor?.shipToParty?.partyId || 'UNKNOWN';
    const deliveryEnd = order.amazonVendor?.deliveryWindow?.endDate;
    const marketplaceCode = order.marketplace?.code || 'UNKNOWN';
    const vendorGroup = getVendorGroup(marketplaceCode);
    const hasOverride = order.amazonVendor?.consolidationOverride;

    const groupId = hasOverride
      ? `${createConsolidationGroupId(vendorGroup, partyId, deliveryEnd)}_SEP_${poNumber}`
      : createConsolidationGroupId(vendorGroup, partyId, deliveryEnd);

    if (!groups[groupId]) {
      groups[groupId] = { groupId, orders: [], isSeparate: hasOverride };
    }
    groups[groupId].orders.push(poNumber);
  }

  console.log('\nGroups:');
  for (const [gid, g] of Object.entries(groups)) {
    const sep = g.isSeparate ? ' [SEPARATE]' : '';
    console.log(`  ${gid}: ${g.orders.join(', ')}${sep}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
