require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function deactivateEmiproJobs() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  
  // Get all Emipro Amazon cron jobs
  const jobs = await odoo.searchRead('ir.cron',
    [['name', 'ilike', 'amazon']],
    ['id', 'name', 'active', 'model_id', 'nextcall', 'interval_number', 'interval_type']
  );
  
  console.log(`Found ${jobs.length} Amazon cron jobs:\n`);
  
  const activeJobs = jobs.filter(j => j.active);
  console.log(`Active jobs to deactivate: ${activeJobs.length}\n`);
  
  for (const job of activeJobs) {
    console.log(`Deactivating: ${job.name} (ID: ${job.id})`);
    
    try {
      await odoo.execute('ir.cron', 'write', [[job.id], { active: false }]);
      console.log(`  ✓ Deactivated\n`);
    } catch (error) {
      console.error(`  ✗ Error: ${error.message}\n`);
    }
  }
  
  // Verify
  const stillActive = await odoo.searchRead('ir.cron',
    [['name', 'ilike', 'amazon'], ['active', '=', true]],
    ['id', 'name']
  );
  
  console.log(`\nVerification: ${stillActive.length} Amazon cron jobs still active`);
  if (stillActive.length > 0) {
    console.log('Still active:', stillActive.map(j => j.name));
  }
  
  console.log('\nDone!');
}

deactivateEmiproJobs().catch(console.error);
