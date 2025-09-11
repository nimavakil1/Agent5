const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const CustomerRecord = require('../../models/CustomerRecord');
const Dnc = require('../../models/Dnc');
const { normalizeToE164 } = require('../../util/phone');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// Download CSV template
router.get('/template.csv', requireSession, async (req, res) => {
  const header = [
    'invoice_name','invoice_company','invoice_address','invoice_city','invoice_postal_code','invoice_country','invoice_email','invoice_phone','invoice_language','invoice_language_confirmed','invoice_tags', 'invoice_opt_out',
    'delivery_1_name','delivery_1_address','delivery_1_city','delivery_1_postal_code','delivery_1_country','delivery_1_email','delivery_1_phone','delivery_1_language','delivery_1_language_confirmed','delivery_1_tags','delivery_1_opt_out',
    'notes'
  ];
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
              address: (r.invoice_address||'').trim(),
              city: (r.invoice_city||'').trim(),
              postal_code: (r.invoice_postal_code||'').trim(),
              country: (r.invoice_country||'').trim(),
              email: (r.invoice_email||'').trim(),
              phone: invPhone,
              language: (r.invoice_language||'').trim(),
              language_confirmed: String(r.invoice_language_confirmed||'').toLowerCase()==='true' || r.invoice_language_confirmed==='1'
            };
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
              tags: (r.delivery_1_tags||'').split(';').map(s=>s.trim()).filter(Boolean)
            }] : [];

            const tags = (r.invoice_tags||'').split(';').map(s=>s.trim()).filter(Boolean);

            // Upsert by invoice phone if present, else by name+email tuple
            const findCond = invPhone ? { 'invoice.phone': invPhone } : { 'invoice.name': invoice.name, 'invoice.email': invoice.email };
            const doc = await CustomerRecord.findOneAndUpdate(
              findCond,
              { $set: { invoice }, $addToSet: { tags: { $each: tags } }, $push: { delivery_addresses: { $each: delivery1 } } },
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
    const scope = (req.query.scope||'invoice'); // invoice|delivery
    const customers = await CustomerRecord.find(q?{ 'invoice.name': new RegExp(q,'i') }:{}).lean();
    const phones = new Set();
    customers.forEach(c=>{ if (c.invoice?.phone) phones.add(c.invoice.phone); (c.delivery_addresses||[]).forEach(d=>{ if (d.phone) phones.add(d.phone); }); });
    const dncSet = new Set((await Dnc.find({ phone_e164: { $in: Array.from(phones) } }).lean()).map(x=>x.phone_e164));
    const rows = [];
    for (const c of customers) {
      if (scope==='invoice') {
        rows.push({ type:'invoice', id:c._id, name:c.invoice?.name||c.name, phone:c.invoice?.phone||c.phone_number, language:c.invoice?.language||c.preferred_language, language_confirmed: !!c.invoice?.language_confirmed, tags:c.tags||[], opt_out: dncSet.has(c.invoice?.phone||'') });
      }
      (c.delivery_addresses||[]).forEach(d=>{
        rows.push({ type:'delivery', id:c._id, code:d.code, name:d.name, phone:d.phone, language:d.language, language_confirmed: !!d.language_confirmed, tags:d.tags||[], opt_out: dncSet.has(d.phone||'') });
      });
    }
    res.json(rows);
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

module.exports = router;
