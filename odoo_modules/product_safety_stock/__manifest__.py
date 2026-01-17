{
    'name': 'Product Safety Stock (Amazon FBM)',
    'version': '16.0.1.0.0',
    'category': 'Inventory',
    'summary': 'Adds safety stock field for Amazon FBM sync',
    'description': '''
        Adds x_safety_stock field to product.product model.
        This value is deducted from available stock when syncing to Amazon FBM.
        Default value: 10
    ''',
    'author': 'Agent5',
    'depends': ['product', 'stock'],
    'data': [
        'views/product_views.xml',
    ],
    'installable': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
