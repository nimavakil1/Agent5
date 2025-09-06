const express = require('express');
const AgentProfile = require('../../models/AgentProfile');
const { requireSession } = require('../../middleware/sessionAuth');

const router = express.Router();

router.use(requireSession);

router.get('/', async (req, res) => {
  const list = await AgentProfile.find({}).sort({ updatedAt: -1 }).lean();
  res.json(list);
});

router.post('/', async (req, res) => {
  const { name, voice, instructions, language } = req.body || {};
  if (!name) return res.status(400).json({ message: 'name required' });
  const doc = await AgentProfile.create({ name, voice: voice || '', instructions: instructions || '', language: language || '', updatedBy: req.user.email });
  res.status(201).json(doc);
});

router.get('/:id', async (req, res) => {
  const doc = await AgentProfile.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ message: 'not found' });
  res.json(doc);
});

router.put('/:id', async (req, res) => {
  const { voice, instructions, language, name } = req.body || {};
  const doc = await AgentProfile.findByIdAndUpdate(
    req.params.id,
    { $set: { voice, instructions, language, name, updatedBy: req.user.email } },
    { new: true }
  );
  if (!doc) return res.status(404).json({ message: 'not found' });
  res.json(doc);
});

module.exports = router;

