import xmlrpc.client

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'info@acropaq.com'
ODOO_PASSWORD = '3f9e62b99ae693c1973470c473410050ae7860f9'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

print('Connected to Odoo')

# Get the current fiscal position
print('\n=== Current Fiscal Position ID 71 ===')
fp = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'account.fiscal.position', 'search_read',
    [[['id', '=', 71]]],
    {'fields': ['id', 'name']}
)
if fp:
    print(f"Before: {fp[0]['name']}")

    # Rename from GB*VAT | Régime Export to EX*VAT | Régime Export
    new_name = 'EX*VAT | Régime Export'
    models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
        'account.fiscal.position', 'write',
        [[71], {'name': new_name}]
    )
    print(f"After: {new_name}")

    # Verify
    fp_updated = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
        'account.fiscal.position', 'search_read',
        [[['id', '=', 71]]],
        {'fields': ['id', 'name']}
    )
    print(f"Verified: {fp_updated[0]['name']}")
else:
    print("Fiscal position ID 71 not found!")
