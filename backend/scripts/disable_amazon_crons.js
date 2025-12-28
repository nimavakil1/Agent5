require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function disableAmazonCrons() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();

  // Amazon-related cron IDs to disable
  const amazonCronIds = [620, 401, 402, 575, 408];

  console.log('Disabling Amazon Seller crons...');
  console.log('');

  for (const cronId of amazonCronIds) {
    try {
      // Get cron details first
      const [cron] = await odoo.read('ir.cron', [cronId], ['name', 'active']);
      if (!cron) {
        console.log(`Cron ${cronId} not found`);
        continue;
      }

      if (!cron.active) {
        console.log(`[SKIP] ${cronId}: ${cron.name} (already inactive)`);
        continue;
      }

      // Disable it
      await odoo.write('ir.cron', [cronId], { active: false });
      console.log(`[DISABLED] ${cronId}: ${cron.name}`);

    } catch (error) {
      console.log(`[ERROR] ${cronId}: ${error.message}`);
    }
  }

  console.log('');
  console.log('Done. Verifying...');

  // Verify
  const allCrons = await odoo.searchRead('ir.cron', [], ['id', 'name', 'active', 'model_id']);
  const eptCrons = allCrons.filter(c => {
    const modelName = c.model_id ? c.model_id[1] : '';
    const cronName = c.name || '';
    return modelName.includes('ept') ||
           cronName.toLowerCase().includes('seller') ||
           cronName.toLowerCase().includes('fba') ||
           cronName.toLowerCase().includes('fbm');
  });

  let activeCount = 0;
  let inactiveCount = 0;

  for (const cron of eptCrons) {
    if (cron.active) activeCount++;
    else inactiveCount++;
  }

  console.log(`Amazon/Emipro crons: ${activeCount} active, ${inactiveCount} inactive`);
}

disableAmazonCrons().catch(console.error);
