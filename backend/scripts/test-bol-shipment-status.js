/**
 * Test script to check Bol order shipment status
 */

// Use native fetch (Node 18+)

async function checkOrders() {
  const clientId = process.env.BOL_CLIENT_ID;
  const clientSecret = process.env.BOL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Missing BOL_CLIENT_ID or BOL_CLIENT_SECRET');
    process.exit(1);
  }

  // Get token
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://login.bol.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials'
  });
  if (tokenRes.status !== 200) {
    const errText = await tokenRes.text();
    console.error('Token error:', tokenRes.status, errText);
    process.exit(1);
  }
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;
  console.log('Token obtained, length:', token ? token.length : 'undefined');

  // Recent Bol order IDs (from Odoo FBBA* orders)
  const orderIds = [
    'A000DLWE4D',
    'A000DLW6F9',
    'A000DLUT9N',
    'A000DLUUHH',
    'A000DLW28C',
    'A000DF7UT6',
    'A000DLU8TM',
    'A000DLTX6K'
  ];

  console.log('=== Checking Bol Order Shipment Status ===\n');

  for (const orderId of orderIds) {
    try {
      const res = await fetch(`https://api.bol.com/retailer/orders/${orderId}`, {
        headers: {
          'Accept': 'application/vnd.retailer.v10+json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (res.status !== 200) {
        const errorText = await res.text();
        console.log(`${orderId}: API error ${res.status} - ${errorText.substring(0, 200)}`);
        continue;
      }

      const order = await res.json();

      let totalQty = 0;
      let totalShipped = 0;
      for (const item of order.orderItems || []) {
        totalQty += item.quantity || 0;
        totalShipped += item.quantityShipped || 0;
      }

      const shipped = totalShipped > 0;
      const status = shipped ? '✅ SHIPPED' : '⏳ Not shipped';
      console.log(`${orderId}: ${status} (${totalShipped}/${totalQty} items)`);

    } catch (err) {
      console.log(`${orderId}: Error - ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 200)); // Rate limit
  }
}

checkOrders().catch(console.error);
