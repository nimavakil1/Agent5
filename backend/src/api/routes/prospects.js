const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const CustomerRecord = require('../../models/CustomerRecord');
const Dnc = require('../../models/Dnc');
const ProspectFieldDef = require('../../models/ProspectFieldDef');
const { normalizeToE164 } = require('../../util/phone');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// --- Field Definitions CRUD ---
const REQUIRE_ADMIN = (req) => (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin'));

router.get('/field-defs', requireSession, async (req, res) => {
  const defs = await ProspectFieldDef.find({}).sort({ order: 1, createdAt: 1 }).lean();
  res.json(defs);
});

router.post('/field-defs', requireSession, async (req, res) => {
  try {
    if (!REQUIRE_ADMIN(req)) return res.status(403).json({ message: 'forbidden' });
    const { key, label, type, required, options, regex, default: def, visibility, order } = req.body || {};
    if (!key || !/^[a-z0-9_]+$/.test(String(key))) return res.status(400).json({ message: 'invalid key' });
    if (!label) return res.status(400).json({ message: 'label required' });
    const allowed = ['string','number','date','enum','boolean','phone','email'];
    if (!allowed.includes(type)) return res.status(400).json({ message: 'invalid type' });
    const doc = await ProspectFieldDef.create({ key, label, type, required: !!required, options: Array.isArray(options)?options:undefined, regex, default: def, visibility: visibility||'invoice', order: Number.isFinite(order)?order:0 });
    res.status(201).json(doc);
  } catch (e) {
    if (String(e.message||'').includes('duplicate key')) return res.status(409).json({ message: 'key exists' });
    res.status(500).json({ message: 'error', error: e.message });
  }
});

router.patch('/field-defs/:id', requireSession, async (req, res) => {
  try {
    if (!REQUIRE_ADMIN(req)) return res.status(403).json({ message: 'forbidden' });
    const update = {};
    const b = req.body || {};
    const allowed = ['string','number','date','enum','boolean','phone','email'];
    if (b.key !== undefined) {
      if (!b.key || !/^[a-z0-9_]+$/.test(String(b.key))) return res.status(400).json({ message: 'invalid key' });
      update.key = b.key;
    }
    if (b.label !== undefined) update.label = b.label;
    if (b.type !== undefined) {
      if (!allowed.includes(b.type)) return res.status(400).json({ message: 'invalid type' });
      update.type = b.type;
    }
    if (b.required !== undefined) update.required = !!b.required;
    if (b.options !== undefined) update.options = Array.isArray(b.options) ? b.options : [];
    if (b.regex !== undefined) update.regex = b.regex;
    if (b.default !== undefined) update.default = b.default;
    if (b.visibility !== undefined) update.visibility = b.visibility;
    if (b.order !== undefined) update.order = Number(b.order)||0;
    const doc = await ProspectFieldDef.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: 'error', error: e.message });
  }
});

router.delete('/field-defs/:id', requireSession, async (req, res) => {
  try {
    if (!REQUIRE_ADMIN(req)) return res.status(403).json({ message: 'forbidden' });
    const r = await ProspectFieldDef.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: 'error', error: e.message });
  }
});

// Download CSV template
router.get('/template.csv', requireSession, async (req, res) => {
  const defs = await ProspectFieldDef.find({}).sort({ order: 1, createdAt: 1 }).lean();
  const base = [
    'invoice_name','invoice_company','invoice_vat','invoice_address','invoice_city','invoice_postal_code','invoice_country','invoice_email','invoice_website','invoice_phone','invoice_language','invoice_language_confirmed','invoice_tags','invoice_opt_out',
    'delivery_1_name','delivery_1_address','delivery_1_city','delivery_1_postal_code','delivery_1_country','delivery_1_email','delivery_1_phone','delivery_1_language','delivery_1_language_confirmed','delivery_1_tags','delivery_1_opt_out',
    'notes'
  ];
  const dynInvoice = defs.filter(d=>d.visibility==='invoice' || d.visibility==='both').map(d=>`custom_${d.key}`);
  const dynDelivery = defs.filter(d=>d.visibility==='delivery' || d.visibility==='both').map(d=>`delivery_1_custom_${d.key}`);
  const header = base.concat(dynInvoice).concat(dynDelivery);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects_template.csv"');
  res.send(header.join(',') + '\n');
});

// Upload CSV and upsert prospects
router.post('/upload', requireSession, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No CSV file uploaded (field name: csv)' });
  const results = [];
  const errors = [];
  let imported = 0;
  try {
    // Auto-detect delimiter (supports ";" and ","), strip BOM, trim headers
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const hasSemicolon = (raw.indexOf(';') !== -1);
    const hasComma = (raw.indexOf(',') !== -1);
    const separator = hasSemicolon && (!hasComma || raw.split(';').length >= raw.split(',').length) ? ';' : ',';

    fs.createReadStream(req.file.path)
      .pipe(csv({ separator, mapHeaders: ({ header }) => header.replace(/\uFEFF/g, '').trim(), mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value) }))
      .on('data', (row) => results.push(row))
      .on('end', async () => {
        const defs = await ProspectFieldDef.find({}).lean();
        const invKeys = new Set(defs.filter(d=>d.visibility==='invoice' || d.visibility==='both').map(d=>d.key));
        const delKeys = new Set(defs.filter(d=>d.visibility==='delivery' || d.visibility==='both').map(d=>d.key));
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          try {
            const invPhone = normalizeToE164(r.invoice_phone || '');
            const delPhone = normalizeToE164(r.delivery_1_phone || '');
            // Require at least invoice name OR company OR phone
            if (!((r.invoice_name && r.invoice_name.length) || (r.invoice_company && r.invoice_company.length) || invPhone)) {
              errors.push(`Row ${i+1}: missing invoice_name and invoice_phone`);
              continue;
            }

            const invoice = {
              name: (r.invoice_name||'').trim(),
              company: (r.invoice_company||'').trim(),
              vat: (r.invoice_vat||'').trim(),
              address: (r.invoice_address||'').trim(),
              city: (r.invoice_city||'').trim(),
              postal_code: (r.invoice_postal_code||'').trim(),
              country: (r.invoice_country||'').trim(),
              email: (r.invoice_email||'').trim(),
              website: (r.invoice_website||'').trim(),
              phone: invPhone,
              language: (r.invoice_language||'').trim(),
              language_confirmed: String(r.invoice_language_confirmed||'').toLowerCase()==='true' || r.invoice_language_confirmed==='1'
            };
            // dynamic custom fields from CSV
            const invoiceCustom = {};
            invKeys.forEach(k=>{
              const col = `custom_${k}`;
              if (r[col] !== undefined && r[col] !== '') invoiceCustom[k] = r[col];
            });
            const deliveryCustom = {};
            delKeys.forEach(k=>{
              const col = `delivery_1_custom_${k}`;
              if (r[col] !== undefined && r[col] !== '') deliveryCustom[k] = r[col];
            });

            const delivery1 = delPhone ? [{
              code: 'delivery_1',
              name: (r.delivery_1_name||'').trim(),
              address: (r.delivery_1_address||'').trim(),
              city: (r.delivery_1_city||'').trim(),
              postal_code: (r.delivery_1_postal_code||'').trim(),
              country: (r.delivery_1_country||'').trim(),
              email: (r.delivery_1_email||'').trim(),
              phone: delPhone,
              language: (r.delivery_1_language||'').trim(),
              language_confirmed: String(r.delivery_1_language_confirmed||'').toLowerCase()==='true' || r.delivery_1_language_confirmed==='1',
              tags: (r.delivery_1_tags||'').split(';').map(s=>s.trim()).filter(Boolean),
              custom: Object.keys(deliveryCustom).length ? deliveryCustom : undefined,
            }] : [];

            const tags = (r.invoice_tags||'').split(';').map(s=>s.trim()).filter(Boolean);

            // Upsert by invoice phone if present, else by name+email tuple
            const findCond = invPhone ? { 'invoice.phone': invPhone } : { 'invoice.name': invoice.name, 'invoice.email': invoice.email };
            const doc = await CustomerRecord.findOneAndUpdate(
              findCond,
              { $set: { invoice: { ...invoice, custom: Object.keys(invoiceCustom).length ? invoiceCustom : undefined } }, $addToSet: { tags: { $each: tags } }, $push: { delivery_addresses: { $each: delivery1 } } },
              { upsert: true, new: true }
            );

            // DNC handling per-phone via opt_out flags
            const toBool = (v)=>{
              const s = String(v||'').trim().toLowerCase();
              return s==='1'||s==='true'||s==='yes'||s==='y';
            };
            const invOpt = toBool(r.invoice_opt_out);
            const delOpt = toBool(r.delivery_1_opt_out);
            if (invOpt && invPhone) await Dnc.updateOne({ phone_e164: invPhone }, { $set: { phone_e164: invPhone, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
            if (delOpt && delPhone) await Dnc.updateOne({ phone_e164: delPhone }, { $set: { phone_e164: delPhone, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });

            imported++;
          } catch (e) {
            errors.push(`Row ${i+1}: ${e.message}`);
          }
        }
        fs.unlink(req.file.path, ()=>{});
        res.json({ imported, total: results.length, errors: errors.length?errors:undefined });
      });
  } catch (e) {
    fs.unlink(req.file.path, ()=>{});
    res.status(500).json({ message:'Failed to process CSV', error: e.message });
  }
});

// List prospects with derived opt-out per phone
router.get('/', requireSession, async (req, res) => {
  try {
    const q = String(req.query.q||'').trim();
    const scope = (req.query.scope||'invoice'); // invoice|delivery|both
    const tags = String(req.query.tags||'').split(/[;,]/).map(s=>s.trim()).filter(Boolean);
    const lang = String(req.query.lang||'').trim();
    const langConfirmed = req.query.lang_confirmed === '1' ? true : req.query.lang_confirmed === '0' ? false : undefined;
    const optOutFilter = req.query.opt_out === '1' ? true : req.query.opt_out === '0' ? false : undefined;
    const showArchived = req.query.show_archived === '1';

    const find = {};
    if (!showArchived) find.archived = { $ne: true };
    if (q) {
      find.$or = [
        { 'invoice.name': new RegExp(q,'i') },
        { 'invoice.company': new RegExp(q,'i') },
        { 'invoice.email': new RegExp(q,'i') },
        { 'invoice.phone': new RegExp(q.replace(/[^0-9+]/g,''),'i') },
      ];
    }
    if (tags.length) {
      find.tags = { $all: tags };
    }
    // lang/lang_confirmed filter applied after shape because of per-scope fields
    const customers = await CustomerRecord.find(find).lean();
    const phones = new Set();
    customers.forEach(c=>{ if (c.invoice?.phone) phones.add(c.invoice.phone); (c.delivery_addresses||[]).forEach(d=>{ if (d.phone) phones.add(d.phone); }); });
    const dncSet = new Set((await Dnc.find({ phone_e164: { $in: Array.from(phones) } }).lean()).map(x=>x.phone_e164));
    const rows = [];
    for (const c of customers) {
      const invRow = { type:'invoice', id:c._id, name:c.invoice?.name||c.name, phone:c.invoice?.phone||c.phone_number, language:c.invoice?.language||c.preferred_language, language_confirmed: !!c.invoice?.language_confirmed, tags:c.tags||[], opt_out: dncSet.has(c.invoice?.phone||'') };
      const addInv = (scope==='invoice' || scope==='both');
      if (addInv) rows.push(invRow);
      (c.delivery_addresses||[]).forEach(d=>{
        const drow = { type:'delivery', id:c._id, code:d.code, name:d.name, phone:d.phone, language:d.language, language_confirmed: !!d.language_confirmed, tags:d.tags||[], opt_out: dncSet.has(d.phone||'') };
        if (scope==='delivery' || scope==='both') rows.push(drow);
      });
    }
    // apply post filters for language/lang_confirmed and opt_out
    const filtered = rows.filter(r=>{
      if (lang && (r.language||'') !== lang) return false;
      if (langConfirmed !== undefined && !!r.language_confirmed !== langConfirmed) return false;
      if (optOutFilter !== undefined && !!r.opt_out !== optOutFilter) return false;
      return true;
    });
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ message:'Failed to fetch prospects', error: e.message });
  }
});

// Toggle opt-out for a phone (E.164)
router.patch('/phone/:e164/opt-out', requireSession, async (req, res) => {
  try {
    const phone = req.params.e164.startsWith('+') ? req.params.e164 : normalizeToE164(req.params.e164);
    const { opt_out, reason } = req.body||{};
    if (opt_out) {
      await Dnc.updateOne({ phone_e164: phone }, { $set: { phone_e164: phone, reason: reason||'', source:'ui', addedBy: req.user?.email||'' } }, { upsert: true });
    } else {
      await Dnc.deleteOne({ phone_e164: phone });
    }
    res.json({ phone, opt_out: !!opt_out });
  } catch (e) {
    res.status(500).json({ message:'Failed to update opt-out', error: e.message });
  }
});

// Get full prospect by id
router.get('/:id', requireSession, async (req, res) => {
  try {
    const doc = await CustomerRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message:'not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message:'Failed to fetch prospect', error: e.message });
  }
});

// Archive/unarchive a contact
router.patch('/:id/archive', requireSession, async (req, res) => {
  try {
    const { archived } = req.body || {};
    const doc = await CustomerRecord.findByIdAndUpdate(req.params.id, { archived: !!archived }, { new: true });
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json({ id: doc._id, archived: !!doc.archived });
  } catch (e) {
    res.status(500).json({ message:'Failed to update archive state', error:e.message });
  }
});

// Interaction logs for a contact (calls etc.)
router.get('/:id/logs', requireSession, async (req, res) => {
  try {
    const doc = await CustomerRecord.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message:'not found' });
    const keys = [String(doc._id)];
    if (doc.customer_id) keys.push(String(doc.customer_id));
    const CallLogEntry = require('../../models/CallLogEntry');
    const calls = await CallLogEntry.find({ customer_id: { $in: keys } }).sort({ start_time: -1 }).limit(200).lean();
    res.json({ calls });
  } catch (e) {
    res.status(500).json({ message:'Failed to fetch logs', error:e.message });
  }
});

// Update invoice details
router.patch('/:id/invoice', requireSession, async (req, res) => {
  try {
    const b = req.body||{};
    const set = {};
    const fields = ['name','company','vat','address','city','postal_code','country','email','website','language','language_confirmed'];
    fields.forEach(k=>{ if (b[k]!==undefined) set[`invoice.${k}`]=b[k]; });
    if (b.phone!==undefined) set['invoice.phone'] = normalizeToE164(b.phone||'');
    const doc = await CustomerRecord.findByIdAndUpdate(req.params.id, { $set: set }, { new:true });
    if (!doc) return res.status(404).json({ message:'not found' });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ message:'Failed to update invoice', error:e.message });
  }
});

// Update delivery by code
router.patch('/:id/delivery/:code', requireSession, async (req, res) => {
  try {
    const code = String(req.params.code);
    const b = req.body||{};
    const set = {};
    const base = 'delivery_addresses.$.';
    const fields = ['name','address','city','postal_code','country','email','language','language_confirmed','notes'];
    fields.forEach(k=>{ if (b[k]!==undefined) set[base+k]=b[k]; });
    if (b.phone!==undefined) set[base+'phone'] = normalizeToE164(b.phone||'');
    if (Array.isArray(b.tags)) set[base+'tags']=b.tags;
    const doc = await CustomerRecord.findOneAndUpdate(
      { _id: req.params.id, 'delivery_addresses.code': code },
      { $set: set },
      { new:true }
    );
    if (!doc) return res.status(404).json({ message:'not found' });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ message:'Failed to update delivery', error:e.message });
  }
});

module.exports = router;
