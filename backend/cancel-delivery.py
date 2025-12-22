import xmlrpc.client

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'info@acropaq.com'
ODOO_PASSWORD = '3f9e62b99ae693c1973470c473410050ae7860f9'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

print('Connected to Odoo')

# Find the order
order_name = 'FBA404-0306410-8965972_BAD3'
print(f'\n=== Finding order {order_name} ===')
orders = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'search_read',
    [[['name', '=', order_name]]],
    {'fields': ['id', 'name', 'state']}
)

if not orders:
    print(f'Order {order_name} not found!')
    exit(1)

order = orders[0]
print(f"Order ID: {order['id']}, Name: {order['name']}, State: {order['state']}")

# Find pickings (deliveries) for this order
print(f'\n=== Finding deliveries for order {order["id"]} ===')
pickings = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'stock.picking', 'search_read',
    [[['sale_id', '=', order['id']]]],
    {'fields': ['id', 'name', 'state', 'picking_type_id']}
)

for p in pickings:
    print(f"Picking ID: {p['id']}, Name: {p['name']}, State: {p['state']}, Type: {p['picking_type_id']}")

# For done pickings, we need to create a return/reverse
done_pickings = [p for p in pickings if p['state'] == 'done']
if done_pickings:
    print(f'\n=== Found {len(done_pickings)} done picking(s) - attempting to cancel ===')

    for picking in done_pickings:
        print(f"\nPicking {picking['name']} (ID: {picking['id']}) is done.")
        print("Options:")
        print("1. Create a return picking (reverse the stock move)")
        print("2. Cancel the order (may not work if picking is done)")

        # Try to cancel the picking first
        try:
            print(f"\nAttempting to cancel picking {picking['id']}...")
            models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
                'stock.picking', 'action_cancel', [[picking['id']]]
            )
            print("Cancel succeeded!")
        except Exception as e:
            print(f"Cancel failed: {e}")
            print("\nYou may need to create a return picking manually in Odoo.")

# Check the order state after
print(f'\n=== Current order state ===')
order_after = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'search_read',
    [[['id', '=', order['id']]]],
    {'fields': ['id', 'name', 'state']}
)
if order_after:
    print(f"Order state: {order_after[0]['state']}")

# Try to cancel the order
print(f'\n=== Attempting to cancel the order ===')
try:
    models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
        'sale.order', 'action_cancel', [[order['id']]]
    )
    print("Order cancelled!")
except Exception as e:
    print(f"Order cancel failed: {e}")
