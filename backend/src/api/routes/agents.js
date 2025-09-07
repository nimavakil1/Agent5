const express = require('express');
const AgentProfile = require('../../models/AgentProfile');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();

router.use(requireSession);

router.get('/', async (req, res) => {
  const includeDeleted = req.query.includeDeleted === '1';
  const filter = includeDeleted ? {} : { deletedAt: null };
  const list = await AgentProfile.find(filter).sort({ updatedAt: -1 }).lean();
  res.json(list);
});

router.post('/', async (req, res) => {
  const { name, voice, instructions, language } = req.body || {};
  if (!name) return res.status(400).json({ message: 'name required' });
  const doc = await AgentProfile.create({ name, voice: voice || '', instructions: instructions || '', language: language || '', updatedBy: req.user.email, deletedAt: null });
  res.status(201).json(doc);
});

router.get('/:id', async (req, res) => {
  const doc = await AgentProfile.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'not found' });
  res.json(doc);
});

router.put('/:id', async (req, res) => {
  const { voice, instructions, language, name } = req.body || {};
  const doc = await AgentProfile.findOneAndUpdate(
    { _id: req.params.id, deletedAt: null },
    { $set: { voice, instructions, language, name, updatedBy: req.user.email } },
    { new: true }
  );
  if (!doc) return res.status(404).json({ message: 'not found' });
  res.json(doc);
});

// Soft-delete an agent profile
router.delete('/:id', async (req, res) => {
  const doc = await AgentProfile.findByIdAndUpdate(
    req.params.id,
    { $set: { deletedAt: new Date(), updatedBy: req.user.email } },
    { new: true }
  );
  if (!doc) return res.status(404).json({ message: 'not found' });
  res.json({ ok: true });
});

module.exports = router;
