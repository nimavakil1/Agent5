
const { Shopify } = require('@shopify/shopify-api');

async function createPrefilledCartLink(products) {
  try {
    // This is a simplified example. In a real application, you would
    // fetch product IDs from Shopify based on product names or SKUs,
    // and then construct the cart link.

    // Assuming 'products' is an array of objects like { variant_id: '123', quantity: 1 }
    // Or, if products are just names, you'd need to look them up first.

    // For demonstration, let's assume we have product IDs/variant IDs
    // and quantities to construct a basic cart link.

    // Example: https://your-store.myshopify.com/cart/add?id=VARIANT_ID&quantity=QUANTITY
    // For multiple items: /cart/VARIANT_ID:QUANTITY,VARIANT_ID:QUANTITY

    const storeUrl = process.env.SHOPIFY_STORE_URL; // e.g., https://your-store.myshopify.com

    if (!storeUrl) {
      throw new Error('Shopify store URL is not configured.');
    }

    let cartItems = '';
    if (products && products.length > 0) {
      cartItems = products.map(p => `${p.variant_id}:${p.quantity}`).join(',');
    }

    const cartLink = `${storeUrl}/cart/${cartItems}`;

    return cartLink;
  } catch (error) {
    console.error('Error creating prefilled cart link:', error);
    throw error;
  }
}

module.exports = {
  createPrefilledCartLink,
};
