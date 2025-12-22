import xmlrpc.client

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'info@acropaq.com'
ODOO_PASSWORD = '3f9e62b99ae693c1973470c473410050ae7860f9'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

print('Connected to Odoo')

# Get sale.order fields
fields = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'fields_get',
    [],
    {'attributes': ['string', 'type', 'relation']}
)

# Look for journal-related fields
print('\n=== Journal-related fields on sale.order ===')
for name, info in sorted(fields.items()):
    if 'journal' in name.lower():
        print(f"  {name}: {info['string']} ({info['type']})")
        if 'relation' in info:
            print(f"    -> relation: {info['relation']}")

# Check what fields exist on order 202457
print('\n=== Check order 202457 for journal field ===')
order = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'search_read',
    [[['id', '=', 202457]]],
    {'fields': ['name', 'journal_id', 'journal_invoice_id']}
)
if order:
    for o in order:
        print(f"Order: {o}")
