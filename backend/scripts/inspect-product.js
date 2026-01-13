require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Get the product template
  const product = await odoo.searchRead('product.template',
    [['id', '=', 12244]],
    ['id', 'name', 'default_code', 'image_1920', 'product_template_image_ids', 'product_variant_ids']
  );

  console.log('Product:', product[0]?.name);
  console.log('SKU:', product[0]?.default_code);
  console.log('Has main image:', product[0]?.image_1920 ? 'Yes' : 'No');
  console.log('Extra images IDs:', product[0]?.product_template_image_ids);

  // Get product images if any
  if (product[0]?.product_template_image_ids?.length > 0) {
    const images = await odoo.searchRead('product.image',
      [['id', 'in', product[0].product_template_image_ids]],
      ['id', 'name']
    );
    console.log('\nProduct Images:');
    images.forEach(i => console.log('  -', i.id, i.name));
  }

  // Get variants
  if (product[0]?.product_variant_ids?.length > 0) {
    const variants = await odoo.searchRead('product.product',
      [['id', 'in', product[0].product_variant_ids]],
      ['id', 'name', 'default_code', 'image_variant_1920', 'product_template_attribute_value_ids']
    );
    console.log('\nVariants:', variants.length);
    variants.forEach(v => {
      const hasImage = v.image_variant_1920 ? 'Yes' : 'No';
      console.log('  -', v.default_code || v.id, '| has variant image:', hasImage);
    });
  }
}

main().catch(console.error);
