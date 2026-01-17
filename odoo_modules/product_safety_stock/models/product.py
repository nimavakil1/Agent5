# -*- coding: utf-8 -*-
from odoo import models, fields


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    x_safety_stock = fields.Float(
        string='Safety Stock (Amazon FBM)',
        default=10.0,
        help='Safety stock quantity to reserve. This amount is deducted from '
             'available stock when syncing to Amazon FBM marketplace.'
    )


class ProductProduct(models.Model):
    _inherit = 'product.product'

    x_safety_stock = fields.Float(
        string='Safety Stock (Amazon FBM)',
        related='product_tmpl_id.x_safety_stock',
        store=True,
        readonly=False,
        help='Safety stock quantity to reserve. This amount is deducted from '
             'available stock when syncing to Amazon FBM marketplace.'
    )
