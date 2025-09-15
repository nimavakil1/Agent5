const AuditLog = require('../models/AuditLog');
const CustomerRecord = require('../models/CustomerRecord');
const Product = require('../models/Product');
const ScheduledJob = require('../models/ScheduledJob');
const { createPrefilledCartLink, getVariantIdBySku, adminFetch, createCheckoutWebUrl } = require('../api/services/shopifyService');
const { sendEmail, sendWhatsAppTemplate } = require('../api/services/brevoService');

function getToolsSpec() {
  return [
    {
      name: 'schedule_callback',
      description: 'Schedule a callback in a time window for a prospect/customer',
      input_schema: {
        type: 'object',
        required: ['to'],
        properties: {
          to: { type: 'string', description: 'E.164 phone number to call' },
          window_start: { type: 'string', description: 'ISO datetime when window starts (optional if due_at provided)' },
          window_end: { type: 'string', description: 'ISO datetime when window ends (optional)' },
          due_at: { type: 'string', description: 'ISO datetime when to attempt first call' },
          campaign_id: { type: 'string' },
          customer_name: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    {
      name: 'update_customer_profile',
      description: 'Update customer invoice details (address, VAT, language) safely with audit log',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string' },
          phone: { type: 'string' },
          invoice: {
            type: 'object',
            properties: {
              name: { type: 'string' }, company: { type: 'string' }, vat: { type: 'string' },
              address: { type: 'string' }, city: { type: 'string' }, postal_code: { type: 'string' }, country: { type: 'string' },
              email: { type: 'string' }, phone: { type: 'string' }, mobile: { type: 'string' },
              language: { type: 'string' }, language_confirmed: { type: 'boolean' },
            },
          },
        },
      },
    },
    {
      name: 'get_product_info',
      description: 'Get product variant info (price, currency, availability) by SKU or variant_id',
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          variant_id: { type: 'number' }
        }
      }
    },
    {
      name: 'create_prospect',
      description: 'Insert a new prospect/customer record',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone_number: { type: 'string' },
          preferred_language: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          invoice: { type: 'object' },
        },
        required: ['phone_number']
      }
    },
    {
      name: 'shopify_create_customer',
      description: 'Create a customer in Shopify Admin',
      input_schema: { type: 'object', properties: { email: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, phone: { type: 'string' } } }
    },
    {
      name: 'shopify_create_draft_order',
      description: 'Create a Shopify draft order and return its invoice URL',
      input_schema: {
        type: 'object',
        required: ['line_items'],
        properties: {
          line_items: { type: 'array', items: { type: 'object', properties: { variant_id: { type: 'number' }, quantity: { type: 'number' } }, required: ['variant_id','quantity'] } },
          email: { type: 'string' },
          customer_id: { type: 'number' },
          shipping_address: { type: 'object' },
          discount: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'number' }, title: { type: 'string' }, description: { type: 'string' } } },
        }
      }
    },
    {
      name: 'shopify_build_checkout',
      description: 'Create a checkout URL for given SKUs or variant_ids',
      input_schema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, variant_id: { type: 'number' }, quantity: { type: 'number' } } } },
          discount_code: { type: 'string' },
        }
      }
    },
    {
      name: 'send_email',
      description: 'Send an email to a recipient using Brevo',
      input_schema: { type: 'object', required: ['to','subject','html'], properties: { to: { type: 'string' }, subject: { type: 'string' }, html: { type: 'string' } } }
    },
    {
      name: 'send_whatsapp_template',
      description: 'Send a WhatsApp template message via Brevo',
      input_schema: { type: 'object', required: ['recipient','template','language'], properties: { recipient: { type: 'string' }, template: { type: 'string' }, language: { type: 'string' }, components: { type: 'array' } } }
    },
  ];
}

async function callTool(name, params = {}, { user = { id: 'system', email: 'system@local' }, idempotencyKey = '' } = {}) {
  if (name === 'schedule_callback') {
    const to = String(params?.to || '').trim();
    if (!to) throw new Error('to is required');
    const dueAt = params?.due_at ? new Date(params.due_at) : new Date();
    const payload = {
      to,
      campaign_id: params?.campaign_id || '',
      customer_name: params?.customer_name || '',
      notes: params?.notes || '',
      window_start: params?.window_start || null,
      window_end: params?.window_end || null,
      idem: idempotencyKey || '',
    };
    const job = await ScheduledJob.create({ type: 'callback', run_at: dueAt, payload });
    try { await AuditLog.create({ user_id: user.id, user_email: user.email, action: 'mcp.schedule_callback', resource: 'ScheduledJob', resource_id: job._id, details: payload, success: true }); } catch(_) {}
    return { ok: true, job_id: String(job._id) };
  }

  if (name === 'update_customer_profile') {
    const q = {};
    if (params?.customer_id) q._id = params.customer_id;
    if (!q._id && params?.phone) q['invoice.phone'] = params.phone;
    if (!q._id && !q['invoice.phone']) throw new Error('customer_id or phone required');
    const updates = {};
    if (params?.invoice && typeof params.invoice === 'object') {
      for (const k of ['name','company','vat','address','city','postal_code','country','email','phone','mobile','language','language_confirmed']) {
        if (k in params.invoice) updates[`invoice.${k}`] = params.invoice[k];
      }
    }
    if (Object.keys(updates).length === 0) throw new Error('no updates provided');
    const before = await CustomerRecord.findOne(q).lean();
    if (!before) throw new Error('customer not found');
    const after = await CustomerRecord.findOneAndUpdate(q, { $set: updates }, { new: true });
    try { await AuditLog.create({ user_id: user.id, user_email: user.email, action: 'mcp.update_customer_profile', resource: 'CustomerRecord', resource_id: String(after._id), details: { updates, idem: idempotencyKey || '' }, success: true }); } catch(_) {}
    return { ok: true, customer_id: String(after._id) };
  }

  if (name === 'get_product_info') {
    const sku = params?.sku ? String(params.sku) : '';
    const variantId = params?.variant_id ? Number(params.variant_id) : 0;
    let prod = null;
    if (variantId) prod = await Product.findOne({ variant_id: variantId }).lean();
    if (!prod && sku) prod = await Product.findOne({ sku }).lean();
    if (!prod && sku) {
      try { const vid = await getVariantIdBySku(sku); if (vid) prod = await Product.findOne({ variant_id: Number(vid) }).lean(); } catch(_) {}
    }
    if (!prod) throw new Error('product_not_found');
    return { variant_id: prod.variant_id, sku: prod.sku, title: prod.title, variant_title: prod.variant_title, price: prod.price, currency: prod.currency, available: prod.available, inventory_quantity: prod.inventory_quantity, image: prod.image };
  }

  if (name === 'create_prospect') {
    const body = {};
    if (params?.name) body.name = String(params.name);
    if (params?.phone_number) body.phone_number = String(params.phone_number);
    if (params?.preferred_language) body.preferred_language = String(params.preferred_language);
    if (Array.isArray(params?.tags)) body.tags = params.tags.map(String);
    if (params?.invoice && typeof params.invoice === 'object') body.invoice = params.invoice;
    const doc = await CustomerRecord.create(body);
    try { await AuditLog.create({ user_id: user.id, user_email: email, action: 'mcp.create_prospect', resource: 'CustomerRecord', resource_id: String(doc._id), details: body, success: true }); } catch(_) {}
    return { ok: true, customer_id: String(doc._id) };
  }

  if (name === 'shopify_create_customer') {
    const payload = { customer: { email: params?.email, first_name: params?.first_name, last_name: params?.last_name, phone: params?.phone } };
    const data = await adminFetch('/customers.json', { method: 'POST', body: payload });
    return { ok: true, customer: data.customer || data };
  }

  if (name === 'shopify_create_draft_order') {
    const { line_items, email, customer_id, shipping_address, discount } = params || {};
    if (!Array.isArray(line_items) || !line_items.length) throw new Error('line_items required');
    const payload = { draft_order: { line_items } };
    if (email) payload.draft_order.email = String(email);
    if (customer_id) payload.draft_order.customer = { id: Number(customer_id) };
    if (shipping_address && typeof shipping_address === 'object') payload.draft_order.shipping_address = shipping_address;
    if (discount && discount.value) {
      const vt = discount.type === 'fixed_amount' ? 'fixed_amount' : 'percentage';
      payload.draft_order.applied_discount = { value_type: vt, value: String(Math.abs(Number(discount.value)||0)), title: discount.title || 'manual_discount', description: discount.description || '' };
    }
    const data = await adminFetch('/draft_orders.json', { method: 'POST', body: payload });
    const out = data.draft_order || data;
    return { ok: true, id: out.id, name: out.name, invoice_url: out.invoice_url || null, status: out.status };
  }

  if (name === 'shopify_build_checkout') {
    const items = Array.isArray(params?.items) ? params.items : [];
    if (!items.length) throw new Error('items required');
    const url = await createCheckoutWebUrl(items, params?.discount_code || '');
    return { ok: true, checkout_url: url };
  }

  if (name === 'send_email') {
    const to = String(params?.to||''); const subject = String(params?.subject||''); const html = String(params?.html||'');
    if (!to || !subject || !html) throw new Error('to, subject, html required');
    const r = await sendEmail(to, subject, html);
    return { ok: true, id: r?.messageId || null };
  }

  if (name === 'send_whatsapp_template') {
    const recipient = String(params?.recipient||''); const template = String(params?.template||''); const language = String(params?.language||'en'); const components = Array.isArray(params?.components)?params.components:[];
    if (!recipient || !template) throw new Error('recipient and template required');
    const r = await sendWhatsAppTemplate(recipient, template, language, components);
    return { ok: true, result: r };
  }

  throw new Error('tool_not_found');
}

module.exports = { getToolsSpec, callTool };
