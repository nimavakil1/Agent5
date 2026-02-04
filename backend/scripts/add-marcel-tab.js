require('dotenv').config();
const { OdooDirectClient } = require('../src/core/agents/integrations/OdooMCP');

async function main() {
  const odoo = new OdooDirectClient();
  await odoo.authenticate();
  console.log('Connected to Odoo');

  // Find product.template views
  const baseViews = await odoo.searchRead('ir.ui.view',
    [['model', '=', 'product.template'], ['name', 'ilike', 'product.template']],
    ['id', 'name', 'inherit_id', 'priority', 'type'],
    { order: 'priority asc', limit: 20 }
  );

  console.log('\nProduct.template views:');
  baseViews.filter(v => v.type === 'form').forEach(v => {
    console.log(`  - ID: ${v.id}, Name: ${v.name}, Inherit: ${v.inherit_id ? v.inherit_id[0] : 'NONE'}`);
  });

  // Use product.template.product.form as the parent
  const parentView = baseViews.find(v => v.name === 'product.template.product.form');
  const inheritId = parentView ? parentView.id : 434;
  console.log('\nUsing parent view ID:', inheritId);

  // Check if our custom view already exists
  const existingCustom = await odoo.searchRead('ir.ui.view',
    [['name', '=', 'product.template.form.marcel']],
    ['id']
  );

  if (existingCustom.length > 0) {
    console.log('Custom view already exists (ID:', existingCustom[0].id + '). Deleting...');
    await odoo.execute('ir.ui.view', 'unlink', [existingCustom.map(v => v.id)]);
  }

  // Create inherited view with Marcel tab showing all images
  const archXml = `<?xml version="1.0"?>
<data>
  <xpath expr="//page[@name='inventory']" position="before">
    <page string="Marcel" name="marcel">
      <group>
        <group string="Main Product Image">
          <field name="image_1920" widget="image" options="{'size': [300, 300]}" nolabel="1"/>
        </group>
      </group>
      <separator string="Additional Product Images"/>
      <field name="product_template_image_ids" mode="kanban" nolabel="1">
        <kanban>
          <field name="id"/>
          <field name="name"/>
          <field name="image_1920"/>
          <templates>
            <t t-name="kanban-box">
              <div class="oe_kanban_global_click o_kanban_image_wrapper" style="margin: 10px; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                <field name="image_1920" widget="image" options="{'size': [200, 200]}"/>
                <div class="oe_kanban_details" style="text-align: center; margin-top: 5px;">
                  <strong><field name="name"/></strong>
                </div>
              </div>
            </t>
          </templates>
        </kanban>
      </field>
    </page>
  </xpath>
</data>`;

  const viewId = await odoo.create('ir.ui.view', {
    name: 'product.template.form.marcel',
    model: 'product.template',
    inherit_id: inheritId,
    arch: archXml,
    priority: 50
  });

  console.log('\nCreated new view with ID:', viewId);
  console.log('Tab "Marcel" has been added to ALL product.template forms!');
  console.log('\nRefresh your Odoo product page to see the new tab.');
}

main().catch(console.error);
