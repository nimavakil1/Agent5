#!/usr/bin/env python3
"""
Fix Invoice Taxes - Posted Invoices (Python version)

This script fixes wrong taxes on POSTED Amazon Seller invoices.
Uses Python's xmlrpc which properly handles None returns from Odoo.

Process:
1. Reset invoice to draft
2. Fix the tax on invoice lines
3. Re-post the invoice

Usage:
  python3 scripts/fix-invoice-taxes-posted-python.py --dry-run    # Preview only
  python3 scripts/fix-invoice-taxes-posted-python.py              # Apply fixes
"""

import sys
import time
import xmlrpc.client

ODOO_URL = 'https://acropaq.odoo.com'
ODOO_DB = 'ninicocolala-v16-fvl-fvl-7662670'
ODOO_USERNAME = 'nima@acropaq.com'
ODOO_PASSWORD = '9ca1030fd68f798adbab7a84e50e3ae40cba27fd'

# Belgian VAT 21% - the wrong tax being applied
BE_VAT_21 = 1

# Domestic VAT tax IDs by country
DOMESTIC_TAXES = {
    'DE': 135,  # DE*VAT 19%
    'FR': 122,  # FR*VAT 20%
    'IT': 180,  # IT*VAT 22%
    'NL': 136,  # NL*VAT 21%
    'PL': 194,  # PL*VAT 23%
    'CZ': 187,  # CZ*VAT 21%
    'GB': 182,  # GB*VAT 20%
}

# Invoice prefixes to country mapping
INVOICE_PREFIX_TO_COUNTRY = {
    'VDE': 'DE',
    'VFR': 'FR',
    'VIT': 'IT',
    'VNL': 'NL',
    'VPL': 'PL',
    'VCZ': 'CZ',
    'VGB': 'GB',
}


def main():
    dry_run = '--dry-run' in sys.argv

    print('=' * 70)
    print('Fix Invoice Taxes - Posted Invoices (Python)')
    print('=' * 70)
    if dry_run:
        print('*** DRY RUN MODE - No changes will be made ***\n')

    # Connect to Odoo with allow_none=True for proper None handling
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common', allow_none=True)
    uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object', allow_none=True)

    print(f'Connected to Odoo as uid: {uid}\n')

    stats = {
        'checked': 0,
        'posted_fixed': 0,
        'lines_fixed': 0,
        'skipped': 0,
        'reset_errors': 0,
        'repost_errors': 0,
        'errors': 0,
    }

    # Process each country's invoices
    for prefix, country_code in INVOICE_PREFIX_TO_COUNTRY.items():
        correct_tax_id = DOMESTIC_TAXES.get(country_code)
        if not correct_tax_id:
            continue

        print(f'\nProcessing {prefix} POSTED invoices ({country_code} -> tax ID {correct_tax_id})...')

        # Find POSTED invoices with this prefix - Only Nov and Dec 2025
        invoices = models.execute_kw(
            ODOO_DB, uid, ODOO_PASSWORD,
            'account.move', 'search_read',
            [[
                ['name', 'like', f'{prefix}%'],
                ['state', '=', 'posted'],
                ['move_type', '=', 'out_invoice'],
                ['invoice_date', '>=', '2025-11-01'],
                ['invoice_date', '<=', '2025-12-31'],
            ]],
            {'fields': ['id', 'name'], 'order': 'id desc'}
        )

        print(f'  Found {len(invoices)} posted {prefix} invoices')

        for invoice in invoices:
            stats['checked'] += 1
            invoice_id = invoice['id']
            invoice_name = invoice['name']

            try:
                # Get invoice lines with their current taxes
                invoice_lines = models.execute_kw(
                    ODOO_DB, uid, ODOO_PASSWORD,
                    'account.move.line', 'search_read',
                    [[['move_id', '=', invoice_id], ['display_type', '=', 'product']]],
                    {'fields': ['id', 'name', 'tax_ids']}
                )

                # Check if any lines have Belgian VAT (the wrong tax)
                lines_needing_fix = 0
                for line in invoice_lines:
                    current_tax_ids = line.get('tax_ids') or []
                    if BE_VAT_21 in current_tax_ids:
                        lines_needing_fix += 1

                if lines_needing_fix == 0:
                    stats['skipped'] += 1
                    continue

                # Reset to draft first
                if not dry_run:
                    try:
                        models.execute_kw(
                            ODOO_DB, uid, ODOO_PASSWORD,
                            'account.move', 'button_draft',
                            [[invoice_id]]
                        )
                    except Exception as reset_error:
                        # Odoo server has allow_none=False, so it fails to serialize None returns
                        # Check if the error is about None marshalling - if so, the operation likely succeeded
                        error_str = str(reset_error)
                        if 'cannot marshal None' in error_str:
                            # Operation probably succeeded, verify state
                            check = models.execute_kw(
                                ODOO_DB, uid, ODOO_PASSWORD,
                                'account.move', 'search_read',
                                [[['id', '=', invoice_id]]],
                                {'fields': ['state']}
                            )
                            if check and check[0].get('state') == 'draft':
                                pass  # Success, continue with fix
                            else:
                                stats['reset_errors'] += 1
                                print(f'    ERROR resetting {invoice_name} to draft: state not draft after reset')
                                continue
                        else:
                            stats['reset_errors'] += 1
                            print(f'    ERROR resetting {invoice_name} to draft: {reset_error}')
                            continue

                # Fix all lines with wrong tax
                lines_fixed_this_invoice = 0
                for line in invoice_lines:
                    current_tax_ids = line.get('tax_ids') or []
                    if BE_VAT_21 in current_tax_ids:
                        if not dry_run:
                            models.execute_kw(
                                ODOO_DB, uid, ODOO_PASSWORD,
                                'account.move.line', 'write',
                                [[line['id']], {'tax_ids': [(6, 0, [correct_tax_id])]}]
                            )
                        lines_fixed_this_invoice += 1
                        stats['lines_fixed'] += 1

                # Re-post the invoice
                if not dry_run:
                    try:
                        models.execute_kw(
                            ODOO_DB, uid, ODOO_PASSWORD,
                            'account.move', 'action_post',
                            [[invoice_id]]
                        )
                    except Exception as repost_error:
                        # Handle Odoo's allow_none=False issue
                        error_str = str(repost_error)
                        if 'cannot marshal None' in error_str:
                            # Check if posted successfully
                            check = models.execute_kw(
                                ODOO_DB, uid, ODOO_PASSWORD,
                                'account.move', 'search_read',
                                [[['id', '=', invoice_id]]],
                                {'fields': ['state']}
                            )
                            if not check or check[0].get('state') != 'posted':
                                stats['repost_errors'] += 1
                                print(f'    ERROR re-posting {invoice_name}: state not posted after action_post')
                        else:
                            stats['repost_errors'] += 1
                            print(f'    ERROR re-posting {invoice_name}: {repost_error}')
                        # Invoice is now in draft with correct taxes - continue anyway

                if lines_fixed_this_invoice > 0:
                    stats['posted_fixed'] += 1
                    if stats['posted_fixed'] <= 50 or stats['posted_fixed'] % 100 == 0:
                        action = 'Would fix' if dry_run else 'Fixed'
                        print(f"    [{stats['posted_fixed']}] {invoice_name}: {action} {lines_fixed_this_invoice} lines")

                # Rate limiting
                if not dry_run and stats['posted_fixed'] % 20 == 0:
                    time.sleep(0.2)

            except Exception as error:
                stats['errors'] += 1
                print(f'    ERROR processing {invoice_name}: {error}')

    # Final summary
    print('\n' + '=' * 70)
    print('SUMMARY')
    print('=' * 70)
    print(f"Invoices checked: {stats['checked']}")
    print(f"Posted invoices fixed: {stats['posted_fixed']}")
    print(f"Total lines fixed: {stats['lines_fixed']}")
    print(f"Skipped (no fix needed): {stats['skipped']}")
    print(f"Reset-to-draft errors: {stats['reset_errors']}")
    print(f"Re-post errors: {stats['repost_errors']}")
    print(f"General errors: {stats['errors']}")

    if dry_run:
        print('\n*** This was a DRY RUN - no changes were made ***')
        print('Run without --dry-run to apply changes')


if __name__ == '__main__':
    main()
