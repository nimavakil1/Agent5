require('dotenv').config();
const fs = require('fs');
const csv = require('csv-parse/sync');

// The 111 missing order IDs
const MISSING_ORDER_IDS = ["405-5026340-0515510","406-6789241-1740315","406-6788268-4504364","403-9379607-9423536","408-1153632-2437963","402-3175896-1619557","404-9392622-8770703","404-7478353-1174764","404-4249374-4725910","404-2817326-2669110","403-8475135-0357936","403-6017028-8195514","403-1369103-0588303","402-6080861-3621918","402-5977887-8719559","402-4594907-7090723","402-3677764-8293135","306-1227489-2013114","304-6420591-6667566","303-2798106-9089168","171-7513890-3002741","171-6162320-1030714","171-0730141-7775519","406-1090596-4237156","405-1210040-1104322","304-4390750-8950756","303-2934861-0441917","171-8170738-6467520","171-2770469-6346716","171-1446702-0353908","302-0347860-5367530","304-4615876-4785169","302-3270182-0370745","303-5212838-6797149","408-3437160-1732313","028-2533251-8708367","407-7173824-1223567","171-7280778-4351546","028-7034663-4382759","028-3388441-7026761","407-0948810-0621903","304-5424861-0609139","304-8046249-4611537","304-4795551-4104304","302-9961351-2105939","406-8249564-6004320","303-9005955-9422721","304-7914453-5087534","305-1031445-8829124","304-3799133-0764369","028-7315451-2021127","302-1754197-5006725","302-3291142-0820325","305-7253492-7866755","305-7719602-8719536","407-5802760-3321967","028-4079040-6911569","028-8155643-7790746","303-5086106-1269949","028-9483459-8654759","403-7638711-4086702","306-9521905-0047533","306-7220062-7078765","306-5864004-8498739","306-5519311-7460329","306-3978259-8716345","306-3249520-8729964","306-1004185-0755502","306-0825923-2865132","306-0685657-7093167","306-0049962-8505905","305-4811559-8974763","305-3530847-4177162","305-1832129-2833959","305-0383375-3541118","304-7150276-7592315","304-1788777-4088333","303-9642954-3735529","303-8886163-4756330","303-8242179-8890711","303-8010612-4951537","303-5554747-5538701","302-9960876-2050724","302-5922415-7657958","302-5095086-4027529","302-5061501-9172306","302-4416015-8525938","302-3733782-9613967","302-0616236-2857123","028-4664531-8066725","028-1973384-7060324","028-1729683-1336307","028-1489993-8361166","028-0279447-3067506","302-0819431-3237153","302-0715257-7145950","306-1610188-8451535","407-0631019-0025130","408-1572985-4693924","408-6606451-6629902","404-2751749-0119545","402-7704019-3889968","028-6015573-4081163","408-3877034-5282717"];

async function lookupMissingVcs() {
  console.log('Looking up', MISSING_ORDER_IDS.length, 'missing orders in VCS files...\n');

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
      console.log('Error loading file:', error.message);
    }
  }

  console.log('\nTotal unique orders in VCS:', vcsData.size);

  // Search and categorize
  const found = [];
  const notFound = [];

  for (const orderId of MISSING_ORDER_IDS) {
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
      total: MISSING_ORDER_IDS.length,
      foundInVcs: found.length,
      notFound: notFound.length,
      byMarketplace,
      byRoute
    },
    found,
    notFound
  };

  fs.writeFileSync('/tmp/vcs_missing_lookup.json', JSON.stringify(results, null, 2));
  console.log('\nComplete results saved to /tmp/vcs_missing_lookup.json');
}

lookupMissingVcs().catch(e => console.error(e));
