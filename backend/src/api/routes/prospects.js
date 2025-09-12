const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const CustomerRecord = require('../../models/CustomerRecord');
const DeliveryContact = require('../../models/DeliveryContact');
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
  // Contacts template: invoice-only columns (deliveries are available via deliveries_template.csv)
  const base = [
    'invoice_contact_name','invoice_company','invoice_vat','invoice_address','invoice_city','invoice_postal_code','invoice_country','invoice_email','invoice_website','invoice_phone','invoice_mobile_nr','invoice_language','invoice_language_confirmed','invoice_wa_preferred','invoice_tags','invoice_opt_out'
  ];
  const dynInvoice = defs.filter(d=>d.visibility==='invoice' || d.visibility==='both').map(d=>`custom_${d.key}`);
  const header = base.concat(dynInvoice);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects_template.csv"');
  res.send(header.join(',') + '\n');
});

// Deliveries-only template and upload
router.get('/deliveries_template.csv', requireSession, async (req, res) => {
  const header = [
    'parent_invoice_phone','parent_invoice_mobile','parent_email',
    'delivery_contact_name','delivery_company','delivery_address','delivery_city','delivery_postal_code','delivery_country','delivery_email','delivery_phone','delivery_mobile','delivery_language','delivery_language_confirmed','delivery_wa_preferred','delivery_tags','delivery_opt_out'
  ];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="deliveries_template.csv"');
  res.send(header.join(',') + '\n');
});

router.post('/upload_deliveries', requireSession, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No CSV file uploaded (field name: csv)' });
  const rows=[]; const errors=[]; let imported=0;
  const imported_items = [];
  const failed_items = [];
  try {
    const raw = fs.readFileSync(req.file.path,'utf8');
    const sep = (raw.split(';').length >= raw.split(',').length) ? ';' : ',';
    fs.createReadStream(req.file.path)
      .pipe(csv({ separator: sep, mapHeaders: ({ header }) => header.replace(/\uFEFF/g,'').trim(), mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value) }))
      .on('data', (row)=> rows.push(row))
      .on('end', async ()=>{
        for (let i=0;i<rows.length;i++){
          try{
            const r=rows[i];
            const keyPhone = normalizeToE164(r.parent_invoice_phone||'');
            const keyMobile = normalizeToE164(r.parent_invoice_mobile||'');
            const find = keyPhone? { 'invoice.phone': keyPhone } : (keyMobile? { 'invoice.mobile': keyMobile } : (r.parent_email? { 'invoice.email': r.parent_email } : null));
            if (!find) { const msg='missing parent key'; errors.push(`Row ${i+1}: ${msg}`); failed_items.push({ row:i+1, error_code:'MISSING_PARENT_KEY', error_message: msg, parent_key:'' }); continue; }
            const parent = await CustomerRecord.findOne(find).lean();
            if (!parent) { const msg='parent not found'; errors.push(`Row ${i+1}: ${msg}`); failed_items.push({ row:i+1, error_code:'PARENT_NOT_FOUND', error_message: msg, parent_key: (keyPhone||keyMobile||r.parent_email||'') }); continue; }
            const payload = {
              parentId: parent._id,
              code: 'delivery_'+Date.now()+('_'+i),
              contact_name: (r.delivery_contact_name||'').trim(),
              company: (r.delivery_company||'').trim(),
              address: (r.delivery_address||'').trim(),
              city: (r.delivery_city||'').trim(),
              postal_code: (r.delivery_postal_code||'').trim(),
              country: (r.delivery_country||'').trim(),
              email: (r.delivery_email||'').trim(),
              phone: normalizeToE164(r.delivery_phone||''),
              mobile: normalizeToE164(r.delivery_mobile||''),
              language: (r.delivery_language||'').trim(),
              language_confirmed: String(r.delivery_language_confirmed||'').toLowerCase()==='true' || r.delivery_language_confirmed==='1',
              wa_preferred: String(r.delivery_wa_preferred||'').toLowerCase()==='true' || r.delivery_wa_preferred==='1',
              tags: (r.delivery_tags||'').split(';').map(s=>s.trim()).filter(Boolean),
            };
            const created = await DeliveryContact.create(payload);
            // DNC handling for phone/mobile
            const toBool = (v)=>{ const s=String(v||'').trim().toLowerCase(); return s==='1'||s==='true'||s==='yes'||s==='y'; };
            if (toBool(r.delivery_opt_out)){
              if (payload.phone) await Dnc.updateOne({ phone_e164: payload.phone }, { $set: { phone_e164: payload.phone, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
              if (payload.mobile) await Dnc.updateOne({ phone_e164: payload.mobile }, { $set: { phone_e164: payload.mobile, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
            }
            imported++;
            imported_items.push({ row: i+1, parent_id: String(parent._id), delivery_id: String(created._id), code: created.code, company: created.company||'', phone: created.phone||'', mobile: created.mobile||'' });
          } catch(e){
            const msg = e.message||'error';
            const code = (String(msg).includes('duplicate key') ? 'DUPLICATE_KEY' : 'UNKNOWN_ERROR');
            errors.push(`Row ${i+1}: ${msg}`);
            failed_items.push({ row: i+1, error_code: code, error_message: msg });
          }
        }
        fs.unlink(req.file.path, ()=>{});
        res.json({ imported, total: rows.length, imported_items, failed_items, errors: errors.length?errors:undefined });
      });
  } catch(e){ fs.unlink(req.file.path,()=>{}); res.status(500).json({ message:'Failed to process CSV', error: e.message }); }
});

// Upload CSV and upsert prospects
router.post('/upload', requireSession, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No CSV file uploaded (field name: csv)' });
  const results = [];
  const errors = [];
  let imported = 0;
  const imported_items = [];
  const failed_items = [];
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
            const invLandline = normalizeToE164(r.invoice_phone || '');
            const invMobile = normalizeToE164(r.invoice_mobile_nr || '');
            const delLandline = normalizeToE164(r.delivery_1_phone || '');
            const delMobile = normalizeToE164(r.delivery1_mobile_nr || '');
            // Require at least invoice name OR company OR phone
            if (!((r.invoice_name && r.invoice_name.length) || (r.invoice_company && r.invoice_company.length) || invLandline || invMobile)) {
              const msg = 'missing invoice_name and invoice_phone';
              errors.push(`Row ${i+1}: ${msg}`);
              failed_items.push({ row: i+1, error_code:'MISSING_REQUIRED', error_message: msg, invoice_name: (r.invoice_contact_name||r.invoice_name||''), invoice_phone: (r.invoice_phone||'') });
              continue;
            }

            const invoice = {
              name: (r.invoice_contact_name||r.invoice_name||'').trim(),
              company: (r.invoice_company||'').trim(),
              vat: (r.invoice_vat||'').trim(),
              address: (r.invoice_address||'').trim(),
              city: (r.invoice_city||'').trim(),
              postal_code: (r.invoice_postal_code||'').trim(),
              country: (r.invoice_country||'').trim(),
              email: (r.invoice_email||'').trim(),
              website: (r.invoice_website||'').trim(),
              phone: invLandline,
              mobile: invMobile,
              language: (r.invoice_language||'').trim(),
              language_confirmed: String(r.invoice_language_confirmed||'').toLowerCase()==='true' || r.invoice_language_confirmed==='1',
              wa_preferred: String(r.invoice_wa_preferred||'').toLowerCase()==='true' || r.invoice_wa_preferred==='1'
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

            const delivery1 = (delLandline || delMobile || (r.delivery1_contact_name||'').trim()) ? [{
              code: 'delivery_1',
              name: (r.delivery1_contact_name||r.delivery_1_name||'').trim(),
              company: (r.delivery1_company||'').trim(),
              address: (r.delivery_1_address||'').trim(),
              city: (r.delivery_1_city||'').trim(),
              postal_code: (r.delivery_1_postal_code||'').trim(),
              country: (r.delivery_1_country||'').trim(),
              email: (r.delivery_1_email||'').trim(),
              phone: delLandline,
              mobile: delMobile,
              language: (r.delivery_1_language||'').trim(),
              language_confirmed: String(r.delivery_1_language_confirmed||'').toLowerCase()==='true' || r.delivery_1_language_confirmed==='1',
              wa_preferred: String(r.delivery1_wa_preferred||r.delivery_1_wa_preferred||'').toLowerCase()==='true' || r.delivery1_wa_preferred==='1',
              tags: (r.delivery_1_tags||'').split(';').map(s=>s.trim()).filter(Boolean),
              custom: Object.keys(deliveryCustom).length ? deliveryCustom : undefined,
            }] : [];

            // Additional deliveries: delivery2_*, delivery_2_* … up to 10
            const extra = [];
            for (let di=2; di<=10; di++){
              const nm = (r[`delivery${di}_contact_name`] || r[`delivery_${di}_name`] || '').trim();
              const comp = (r[`delivery${di}_company`] || '').trim();
              const addr = (r[`delivery_${di}_address`] || '').trim();
              const city = (r[`delivery_${di}_city`] || '').trim();
              const pc = (r[`delivery_${di}_postal_code`] || '').trim();
              const ctry = (r[`delivery_${di}_country`] || '').trim();
              const em = (r[`delivery_${di}_email`] || '').trim();
              const ph = normalizeToE164(r[`delivery_${di}_phone`] || '');
              const mob = normalizeToE164(r[`delivery${di}_mobile_nr`] || '');
              const lang = (r[`delivery_${di}_language`] || '').trim();
              const lconf = String(r[`delivery_${di}_language_confirmed`]||'').toLowerCase()==='true' || r[`delivery_${di}_language_confirmed`]==='1';
              const wa = String(r[`delivery${di}_wa_preferred`]||'').toLowerCase()==='true' || r[`delivery${di}_wa_preferred`]==='1';
              const tagsDi = (r[`delivery_${di}_tags`]||'').split(';').map(s=>s.trim()).filter(Boolean);
              const any = nm || comp || addr || city || pc || ctry || em || ph || mob;
              if (!any) continue;
              extra.push({ code:`delivery_${di}`, name:nm, company:comp, address:addr, city, postal_code:pc, country:ctry, email:em, phone:ph, mobile:mob, language:lang, language_confirmed:lconf, wa_preferred:wa, tags:tagsDi });
            }

            const tags = (r.invoice_tags||'').split(';').map(s=>s.trim()).filter(Boolean);

            // Upsert by invoice phone if present, else by name+email tuple
            const findCond = (invLandline || invMobile) ? { 'invoice.phone': (invLandline || invMobile) } : { 'invoice.name': invoice.name, 'invoice.email': invoice.email };
            const doc = await CustomerRecord.findOneAndUpdate(
              findCond,
              { $set: { invoice: { ...invoice, custom: Object.keys(invoiceCustom).length ? invoiceCustom : undefined } }, $addToSet: { tags: { $each: tags } }, $push: { delivery_addresses: { $each: delivery1 } } },
              { upsert: true, new: true }
            );

            // Upsert DeliveryContact(s) for delivery1 + extras
            if (delivery1.length){
              const d = delivery1[0];
              await DeliveryContact.updateOne({ parentId: doc._id, code: 'delivery_1' }, { $set: {
                parentId: doc._id, code: 'delivery_1', contact_name: d.name, company: d.company, address: d.address, city: d.city, postal_code: d.postal_code, country: d.country, email: d.email, phone: d.phone, mobile: d.mobile, language: d.language, language_confirmed: d.language_confirmed, wa_preferred: d.wa_preferred, tags: d.tags, custom: d.custom||{}
              } }, { upsert: true });
            }
            for (const d of extra){
              await DeliveryContact.updateOne({ parentId: doc._id, code: d.code }, { $set: {
                parentId: doc._id, code: d.code, contact_name: d.name, company: d.company, address: d.address, city: d.city, postal_code: d.postal_code, country: d.country, email: d.email, phone: d.phone, mobile: d.mobile, language: d.language, language_confirmed: d.language_confirmed, wa_preferred: d.wa_preferred, tags: d.tags
              } }, { upsert: true });
            }

            // DNC handling per-phone via opt_out flags
            const toBool = (v)=>{
              const s = String(v||'').trim().toLowerCase();
              return s==='1'||s==='true'||s==='yes'||s==='y';
            };
            const invOpt = toBool(r.invoice_opt_out);
            const delOpt = toBool(r.delivery_1_opt_out);
            if (invOpt) {
              if (invLandline) await Dnc.updateOne({ phone_e164: invLandline }, { $set: { phone_e164: invLandline, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
              if (invMobile) await Dnc.updateOne({ phone_e164: invMobile }, { $set: { phone_e164: invMobile, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
            }
            if (delOpt) {
              if (delLandline) await Dnc.updateOne({ phone_e164: delLandline }, { $set: { phone_e164: delLandline, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
              if (delMobile) await Dnc.updateOne({ phone_e164: delMobile }, { $set: { phone_e164: delMobile, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
              for (const d of extra){
                if (d.phone) await Dnc.updateOne({ phone_e164: d.phone }, { $set: { phone_e164: d.phone, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
                if (d.mobile) await Dnc.updateOne({ phone_e164: d.mobile }, { $set: { phone_e164: d.mobile, source:'upload', addedBy: req.user?.email||'upload' } }, { upsert: true });
              }
            }

            imported++;
            imported_items.push({ row: i+1, id: String(doc._id), invoice_phone: (doc.invoice?.phone||''), invoice_email: (doc.invoice?.email||''), invoice_name: (doc.invoice?.name||'') });
          } catch (e) {
            const msg = e.message||'error';
            const code = (String(msg).includes('duplicate key') ? 'DUPLICATE_KEY' : 'UNKNOWN_ERROR');
            errors.push(`Row ${i+1}: ${msg}`);
            failed_items.push({ row: i+1, error_code: code, error_message: msg, invoice_name: (r.invoice_contact_name||r.invoice_name||''), invoice_phone: (r.invoice_phone||'') });
          }
        }
        fs.unlink(req.file.path, ()=>{});
        res.json({ imported, total: results.length, imported_items, failed_items, errors: errors.length?errors:undefined });
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
      const invRow = { type:'invoice', id:c._id, name:c.invoice?.name||c.name, company: c.invoice?.company||'', phone:c.invoice?.phone||c.phone_number, language:c.invoice?.language||c.preferred_language, language_confirmed: !!c.invoice?.language_confirmed, tags:c.tags||[], opt_out: dncSet.has(c.invoice?.phone||''), archived: !!c.archived };
      const addInv = (scope==='invoice' || scope==='both');
      if (addInv) rows.push(invRow);
      (c.delivery_addresses||[]).forEach(d=>{
        const drow = { type:'delivery', id:c._id, code:d.code, name:d.name, company: d.company||'', phone:d.phone, language:d.language, language_confirmed: !!d.language_confirmed, tags:d.tags||[], opt_out: dncSet.has(d.phone||''), archived: !!c.archived };
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
    // Pagination (optional)
    if (req.query.paged === '1') {
      const page = Math.max(1, parseInt(req.query.page||'1',10));
      const pageSize = Math.max(1, parseInt(req.query.page_size||'50',10));
      const total = filtered.length;
      const startIdx = (page-1)*pageSize;
      const endIdx = Math.min(startIdx + pageSize, total);
      const items = filtered.slice(startIdx, endIdx);
      return res.json({ items, total, page, page_size: pageSize });
    }
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
    const fields = ['name','company','vat','address','city','postal_code','country','email','website','language','language_confirmed','wa_preferred'];
    fields.forEach(k=>{ if (b[k]!==undefined) set[`invoice.${k}`]=b[k]; });
    if (b.phone!==undefined) set['invoice.phone'] = normalizeToE164(b.phone||'');
    if (b.mobile!==undefined) set['invoice.mobile'] = normalizeToE164(b.mobile||'');
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
    const update = {};
    if (b.name!==undefined) update.contact_name = b.name;
    if (b.company!==undefined) update.company = b.company;
    if (b.address!==undefined) update.address = b.address;
    if (b.city!==undefined) update.city = b.city;
    if (b.postal_code!==undefined) update.postal_code = b.postal_code;
    if (b.country!==undefined) update.country = b.country;
    if (b.email!==undefined) update.email = b.email;
    if (b.language!==undefined) update.language = b.language;
    if (b.language_confirmed!==undefined) update.language_confirmed = !!b.language_confirmed;
    if (b.notes!==undefined) update.notes = b.notes;
    if (b.wa_preferred!==undefined) update.wa_preferred = !!b.wa_preferred;
    if (b.phone!==undefined) update.phone = normalizeToE164(b.phone||'');
    if (b.mobile!==undefined) update.mobile = normalizeToE164(b.mobile||'');
    if (Array.isArray(b.tags)) update.tags = b.tags;
    await DeliveryContact.updateOne({ parentId: req.params.id, code }, { $set: { parentId: req.params.id, code, ...update } }, { upsert: true });
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ message:'Failed to update delivery', error:e.message });
  }
});

// Deliveries child endpoints
router.get('/:id/deliveries', requireSession, async (req,res)=>{
  const items = await DeliveryContact.find({ parentId: req.params.id, archived: { $ne: true } }).sort({ createdAt: 1 }).lean();
  res.json(items);
});
router.post('/:id/deliveries', requireSession, async (req,res)=>{
  const b = req.body||{}; const code = String(b.code||'delivery_'+Date.now());
  const doc = await DeliveryContact.create({ parentId: req.params.id, code, contact_name:b.name||'', company:b.company||'', address:b.address||'', city:b.city||'', postal_code:b.postal_code||'', country:b.country||'', email:b.email||'', phone: normalizeToE164(b.phone||''), mobile: normalizeToE164(b.mobile||''), language:b.language||'', language_confirmed: !!b.language_confirmed, wa_preferred: !!b.wa_preferred, tags: Array.isArray(b.tags)?b.tags:[], notes:b.notes||'', custom:b.custom||{} });
  res.status(201).json(doc);
});
router.patch('/:id/deliveries/:deliveryId/archive', requireSession, async (req,res)=>{
  const { archived } = req.body||{}; await DeliveryContact.findByIdAndUpdate(req.params.deliveryId, { archived: !!archived }); res.json({ ok:true });
});
router.delete('/:id/deliveries/:deliveryId', requireSession, async (req,res)=>{
  await DeliveryContact.deleteOne({ _id: req.params.deliveryId, parentId: req.params.id }); res.json({ ok:true });
});

module.exports = router;
