require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');

const ALL_ORDER_IDS = ["402-6819718-3689940","405-7668060-9687549","407-7977232-3148356","406-3788725-6686734","305-2515977-4840365","404-1453717-7463508","403-2732315-9551524","406-6687375-7578748","306-9710118-5002757","306-1863091-8078748","028-4755315-6869104","305-3697272-4854744","306-8833006-1831517","407-4398969-6367509","405-9688425-7212369","305-3882509-3560307","408-2008832-1801166","171-3993131-0629916","306-4762737-4445945","306-6807390-9520350","302-1107761-2749130","403-4722617-9551543","171-2766156-7130700","406-2774640-2364353","408-4528102-6190720","028-5133767-6877912","407-7315844-7265912","407-8845531-3980311","306-1607327-1583524","408-2603266-8275526","405-2107161-1985115","404-9046811-3257101","404-7855039-4530743","404-6534272-6997106","404-4785055-5581104","404-2089502-8037118","404-1629243-7773942","403-8377281-4121116","403-7936300-9042746","402-9891381-8261903","402-9628735-7567567","402-7313237-9922711","402-7255193-6791554","402-6430535-7106738","402-6020381-7843554","402-4469866-3773146","402-4469866-3773146","306-9918877-2158711","306-9345381-5955503","306-8525194-9408330","306-6052664-9159558","306-4577341-4206710","306-1951731-9129933","306-0339527-1782734","306-0083754-7315501","305-9568449-3467563","305-8877608-2281139","305-8799263-5440357","305-8563639-4001133","305-7570023-5675521","305-7424532-2447506","305-7059980-7167513","305-6585905-1774741","305-5441953-3374718","305-4459799-9653125","305-4170320-3146765","305-2863653-0904316","305-0925679-0728368","304-9837286-7630747","304-9789389-7169120","304-9771985-3469118","304-9668786-9293136","304-8548163-5390752","304-5837880-3447512","304-5458375-5573105","304-3408651-8475528","304-3155106-5782710","304-2828435-1344338","304-2543067-3839552","304-0793720-9467545","304-0733778-3025113","303-9779113-2271528","303-7682757-3099552","303-5019804-4460329","303-4790363-1071563","303-1934630-7305140","303-0762492-4377160","303-0328412-5756332","302-9231726-2697936","302-8129951-0447518","302-6511463-2772361","302-5157911-7018721","302-5028201-3007520","302-3241617-2545906","302-2444688-2684345","302-2101787-0764357","171-8838362-3507505","171-7011105-5790754","171-5254816-7801914","028-7565359-0209102","028-6803661-0326727","028-6545835-5620342","028-6470478-1358752","028-5802679-7877906","028-3531747-9863542","028-3269120-3967565","028-2976173-8817901","028-2354504-2770702","407-4016096-5817920","404-4862606-5257135","402-8123733-0476355","306-1607327-1583524","305-2501197-5144368"];

async function lookupVcsFiles() {
  console.log('Loading VCS files...\n');

  const vcsFile1 = '/Users/nimavakil/Downloads/taxReport_c26b0feaf8d3ff691909ff5ae0bc274897c92e8b (1).csv';
  const vcsFile2 = '/Users/nimavakil/Downloads/taxReport_07c4ec70eff1c89a26c1d786aba98e822e0691c0 (1).csv';

  const vcsData = new Map();

  for (const file of [vcsFile1, vcsFile2]) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const records = csv.parse(content, { columns: true, skip_empty_lines: true });
      console.log('Loaded:', file.split('/').pop(), '-', records.length, 'records');

      for (const row of records) {
        const orderId = row['Order ID'];
        if (orderId && row['Transaction Type'] === 'SHIPMENT') {
          vcsData.set(orderId, {
            marketplace: row['Marketplace ID'],
            shipFromCountry: row['Ship From Country'],
            shipToCountry: row['Ship To Country'],
            taxScheme: row['Tax Reporting Scheme'],
            currency: row['Currency']
          });
        }
      }
    } catch (error) {
      console.log('Error:', error.message);
    }
  }

  console.log('\nTotal unique orders in VCS:', vcsData.size);

  // Search and categorize
  const found = [];
  const notFound = [];

  for (const orderId of ALL_ORDER_IDS) {
    const vcs = vcsData.get(orderId);
    if (vcs) {
      found.push({ orderId, ...vcs });
    } else {
      notFound.push(orderId);
    }
  }

  console.log('\n========================================');
  console.log('RESULTS');
  console.log('========================================');
  console.log('Found in VCS:', found.length);
  console.log('Not found:', notFound.length);

  // Group by marketplace and ship from/to
  const byMarketplace = {};
  const byRoute = {};

  for (const item of found) {
    byMarketplace[item.marketplace] = (byMarketplace[item.marketplace] || 0) + 1;
    const route = `${item.shipFromCountry} -> ${item.shipToCountry}`;
    byRoute[route] = (byRoute[route] || 0) + 1;
  }

  console.log('\nBy Marketplace:');
  Object.entries(byMarketplace).sort((a,b) => b[1] - a[1]).forEach(([mp, count]) => {
    console.log('  ', mp, ':', count);
  });

  console.log('\nBy Route (Ship From -> To):');
  Object.entries(byRoute).sort((a,b) => b[1] - a[1]).forEach(([route, count]) => {
    console.log('  ', route, ':', count);
  });

  // Show not found
  if (notFound.length > 0) {
    console.log('\n========================================');
    console.log('NOT FOUND IN VCS FILES (' + notFound.length + ')');
    console.log('========================================');
    notFound.forEach(id => console.log('  ', id));
  }

  // Save complete results
  const results = {
    summary: {
      total: ALL_ORDER_IDS.length,
      foundInVcs: found.length,
      notFound: notFound.length,
      byMarketplace,
      byRoute
    },
    found,
    notFound
  };

  fs.writeFileSync('/tmp/vcs_complete_lookup.json', JSON.stringify(results, null, 2));
  console.log('\nComplete results saved to /tmp/vcs_complete_lookup.json');
}

lookupVcsFiles().catch(e => console.error(e));
