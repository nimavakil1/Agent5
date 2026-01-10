/**
 * Run BOL sales invoicing manually
 */
require('dotenv').config();
const { runBolSalesInvoicing } = require('../src/services/bol/BolSalesInvoicer');

async function main() {
  console.log('Starting BOL sales invoicing...');
  console.log('Time:', new Date().toISOString());

  let totalPosted = 0;
  let batch = 0;
  let result;

  do {
    batch++;
    console.log(`\nBatch ${batch}...`);
    result = await runBolSalesInvoicing({ limit: 100 });
    totalPosted += result.posted || 0;
    console.log(`Batch ${batch} complete: ${result.posted || 0} posted (total: ${totalPosted})`);
    console.log('Errors:', result.errors?.length || 0);
  } while (result.posted > 0 && batch < 10);

  console.log('\n=== DONE ===');
  console.log('Total posted:', totalPosted);
  console.log('Batches:', batch);
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
