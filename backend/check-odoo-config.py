import xmlrpc.client

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'info@acropaq.com'
ODOO_PASSWORD = '3f9e62b99ae693c1973470c473410050ae7860f9'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

print('Connected to Odoo')

# Find all Export-related fiscal positions
print('\n=== Fiscal Positions with "Export" ===')
export_fps = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'account.fiscal.position', 'search_read',
    [[['name', 'ilike', 'export']]],
    {'fields': ['id', 'name', 'country_id', 'country_group_id', 'auto_apply']}
)
for fp in export_fps:
    print(f"ID {fp['id']}: {fp['name']}")
    print(f"  country_id: {fp['country_id']}")
    print(f"  country_group_id: {fp['country_group_id']}")
    print(f"  auto_apply: {fp['auto_apply']}")

# Find fiscal position with ID 71 (what we set)
print('\n=== Fiscal Position ID 71 ===')
fp71 = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'account.fiscal.position', 'search_read',
    [[['id', '=', 71]]],
    {'fields': ['id', 'name', 'country_id', 'country_group_id', 'auto_apply']}
)
for fp in fp71:
    print(f"ID {fp['id']}: {fp['name']}")
    print(f"  country_id: {fp['country_id']}")

# Find all fiscal positions for Switzerland (CH)
print('\n=== Fiscal Positions for Switzerland ===')
ch_fps = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'account.fiscal.position', 'search_read',
    [[['name', 'ilike', 'CH']]],
    {'fields': ['id', 'name']}
)
for fp in ch_fps:
    print(f"ID {fp['id']}: {fp['name']}")

# List all sale journals
print('\n=== Sale Journals ===')
journals = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'account.journal', 'search_read',
    [[['type', '=', 'sale']]],
    {'fields': ['id', 'name', 'code', 'type']}
)
for j in journals:
    print(f"ID {j['id']}: {j['name']} ({j['code']}) - {j['type']}")

# Check what journal ID 52 is
print('\n=== Journal ID 52 ===')
j52 = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'account.journal', 'search_read',
    [[['id', '=', 52]]],
    {'fields': ['id', 'name', 'code', 'type']}
)
for j in j52:
    print(f"ID {j['id']}: {j['name']} ({j['code']}) - {j['type']}")
