#!/usr/bin/env python3
"""
Update Amazon B2B Partner Information

This script reads an Amazon FBM TSV file and updates Odoo orders with proper
B2B partner information (VAT numbers, company names).

The issue: Amazon EPT module imports orders but doesn't populate VAT/B2B info.

Usage:
  python3 scripts/update-amazon-b2b-partners.py /path/to/tsv-file.txt --dry-run
  python3 scripts/update-amazon-b2b-partners.py /path/to/tsv-file.txt
"""

import sys
import csv
import xmlrpc.client

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'info@acropaq.com'
ODOO_PASSWORD = '3f9e62b99ae693c1973470c473410050ae7860f9'

# Cache for country IDs
_country_cache = {}


def get_country_id(models, db, uid, password, country_code):
    """Get Odoo country ID from ISO country code."""
    if not country_code:
        return False

    if country_code in _country_cache:
        return _country_cache[country_code]

    countries = models.execute_kw(
        db, uid, password,
        'res.country', 'search_read',
        [[['code', '=', country_code.upper()]]],
        {'fields': ['id'], 'limit': 1}
    )

    if countries:
        _country_cache[country_code] = countries[0]['id']
        return countries[0]['id']

    return False


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/update-amazon-b2b-partners.py <tsv-file> [--dry-run]")
        sys.exit(1)

    tsv_file = sys.argv[1]
    dry_run = '--dry-run' in sys.argv

    print('=' * 70)
    print('Update Amazon B2B Partner Information')
    print('=' * 70)
    if dry_run:
        print('*** DRY RUN MODE - No changes will be made ***\n')

    # Connect to Odoo
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common', allow_none=True)
    uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object', allow_none=True)

    print(f'Connected to Odoo as uid: {uid}')

    # Read TSV file
    b2b_orders = []
    with open(tsv_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f, delimiter='\t')
        for row in reader:
            is_business = row.get('is-business-order', '').lower() == 'true'
            if is_business:
                b2b_orders.append({
                    'order_id': row.get('order-id', ''),
                    'buyer_company_name': row.get('buyer-company-name', ''),
                    'buyer_vat_number': row.get('buyer-vat-number', ''),
                    'invoice_business_legal_name': row.get('invoice-business-legal-name', ''),
                    'invoice_business_tax_id': row.get('invoice-business-tax-id', ''),
                    'buyer_tax_registration_id': row.get('buyer-tax-registration-id', ''),
                    'is_iba': row.get('is-iba', '').lower() == 'true',
                    'recipient_name': row.get('recipient-name', ''),
                    'ship_address_1': row.get('ship-address-1', ''),
                    'ship_address_2': row.get('ship-address-2', ''),
                    'ship_city': row.get('ship-city', ''),
                    'ship_postal_code': row.get('ship-postal-code', ''),
                    'ship_country': row.get('ship-country', ''),
                })

    print(f'\nFound {len(b2b_orders)} B2B orders in TSV file\n')

    stats = {
        'processed': 0,
        'partner_updated': 0,
        'partner_created': 0,
        'order_not_found': 0,
        'already_correct': 0,
        'errors': 0,
    }

    for order_data in b2b_orders:
        amazon_order_id = order_data['order_id']
        stats['processed'] += 1

        # Determine the VAT number (try multiple fields)
        vat_number = (
            order_data['buyer_vat_number'] or
            order_data['invoice_business_tax_id'] or
            order_data['buyer_tax_registration_id'] or
            ''
        ).strip()

        # Determine company name
        company_name = (
            order_data['invoice_business_legal_name'] or
            order_data['buyer_company_name'] or
            ''
        ).strip()

        print(f'\n[{stats["processed"]}/{len(b2b_orders)}] Order: {amazon_order_id}')
        print(f'  Company: {company_name}')
        print(f'  VAT: {vat_number}')
        print(f'  IBA: {order_data["is_iba"]}')

        try:
            # Find the order in Odoo (FBM prefix)
            order_name_patterns = [
                f'FBM{amazon_order_id}',
                amazon_order_id,
            ]

            order = None
            for pattern in order_name_patterns:
                orders = models.execute_kw(
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'sale.order', 'search_read',
                    [[['name', 'ilike', pattern]]],
                    {'fields': ['id', 'name', 'partner_id', 'partner_invoice_id', 'partner_shipping_id'], 'limit': 1}
                )
                if orders:
                    order = orders[0]
                    break

            if not order:
                print(f'  -> Order NOT FOUND in Odoo')
                stats['order_not_found'] += 1
                continue

            print(f'  -> Found: {order["name"]} (ID: {order["id"]})')

            # Get current partner info
            partner_id = order['partner_id'][0] if order.get('partner_id') else None
            if not partner_id:
                print(f'  -> No partner on order!')
                stats['errors'] += 1
                continue

            partner = models.execute_kw(
                ODOO_DB, uid, ODOO_PASSWORD,
                'res.partner', 'search_read',
                [[['id', '=', partner_id]]],
                {'fields': ['id', 'name', 'vat', 'company_type', 'is_company']}
            )[0]

            print(f'  -> Current partner: {partner["name"]} (VAT: {partner.get("vat") or "none"})')

            # Check if this is a generic Amazon partner (should not be modified)
            is_generic_partner = (
                'AMZ_B2C' in partner['name'] or
                'AMZ_B2B' in partner['name'] or
                partner['name'].startswith('Amazon |')
            )

            if is_generic_partner:
                print(f'  -> Generic Amazon partner - need to create new partner')

                if vat_number or company_name:
                    # Create a new partner for this B2B customer
                    new_partner_vals = {
                        'name': company_name or order_data['recipient_name'],
                        'is_company': True,
                        'company_type': 'company',
                        'street': order_data['ship_address_1'],
                        'street2': order_data['ship_address_2'] or False,
                        'city': order_data['ship_city'],
                        'zip': order_data['ship_postal_code'],
                        'country_id': get_country_id(models, ODOO_DB, uid, ODOO_PASSWORD, order_data['ship_country']),
                    }
                    if vat_number:
                        new_partner_vals['vat'] = vat_number

                    if not dry_run:
                        new_partner_id = models.execute_kw(
                            ODOO_DB, uid, ODOO_PASSWORD,
                            'res.partner', 'create',
                            [new_partner_vals]
                        )
                        # Update order to use new partner (all three partner fields)
                        models.execute_kw(
                            ODOO_DB, uid, ODOO_PASSWORD,
                            'sale.order', 'write',
                            [[order['id']], {
                                'partner_id': new_partner_id,
                                'partner_invoice_id': new_partner_id,
                                'partner_shipping_id': new_partner_id,
                            }]
                        )
                    action = 'Would create' if dry_run else 'Created'
                    print(f'  -> {action} new partner: {new_partner_vals["name"]} (VAT: {vat_number or "none"})')
                    stats['partner_created'] += 1
                else:
                    print(f'  -> No B2B info to create new partner')
                    stats['already_correct'] += 1
                continue

            # Check if partner already has correct VAT
            if partner.get('vat') and vat_number and partner['vat'].replace(' ', '') == vat_number.replace(' ', ''):
                print(f'  -> Already has correct VAT')
                stats['already_correct'] += 1
                continue

            # Update partner with B2B info
            update_vals = {}

            if vat_number and not partner.get('vat'):
                update_vals['vat'] = vat_number

            if company_name and not partner.get('is_company'):
                # If we have a company name and partner is not marked as company, update it
                update_vals['is_company'] = True
                update_vals['company_type'] = 'company'

            if update_vals:
                if not dry_run:
                    models.execute_kw(
                        ODOO_DB, uid, ODOO_PASSWORD,
                        'res.partner', 'write',
                        [[partner_id], update_vals]
                    )
                action = 'Would update' if dry_run else 'Updated'
                print(f'  -> {action} partner: {update_vals}')
                stats['partner_updated'] += 1
            else:
                print(f'  -> No updates needed')
                stats['already_correct'] += 1

        except Exception as e:
            print(f'  -> ERROR: {e}')
            stats['errors'] += 1

    # Summary
    print('\n' + '=' * 70)
    print('SUMMARY')
    print('=' * 70)
    print(f"B2B orders processed: {stats['processed']}")
    print(f"Partners updated: {stats['partner_updated']}")
    print(f"Partners created: {stats['partner_created']}")
    print(f"Orders not found: {stats['order_not_found']}")
    print(f"Already correct: {stats['already_correct']}")
    print(f"Errors: {stats['errors']}")

    if dry_run:
        print('\n*** This was a DRY RUN - no changes were made ***')
        print('Run without --dry-run to apply changes')


if __name__ == '__main__':
    main()
