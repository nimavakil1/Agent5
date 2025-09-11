const express = require('express');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const router = express.Router();
const { getAllCampaigns, createCampaign, updateCampaign, deleteCampaign } = require('../../services/campaignService');
const CampaignDefinition = require('../../models/CampaignDefinition');
const ScheduledJob = require('../../models/ScheduledJob');
const { requireSession } = require('../../middleware/sessionAuth');

router.get('/', async (req, res) => {
  try {
    const campaigns = await getAllCampaigns();
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get campaigns', error: error.message });
  }
});

router.post('/', requireSession, async (req, res) => {
  try {
    const newCampaign = await createCampaign(req.body);
    res.status(201).json(newCampaign);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create campaign', error: error.message });
  }
});

router.put('/:id', requireSession, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const updatedCampaign = await updateCampaign(req.params.id, req.body);
    res.json(updatedCampaign);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update campaign', error: error.message });
  }
});

router.delete('/:id', requireSession, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    await deleteCampaign(req.params.id);
    res.status(204).send(); // No content
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete campaign', error: error.message });
  }
});

// Start/pause/stop campaign
router.post('/:id/start', requireSession, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });
    const camp = await CampaignDefinition.findByIdAndUpdate(id, { status: 'running' }, { new: true });
    if (!camp) return res.status(404).json({ message: 'not found' });
    // Also schedule a goal_check in 1 minute to mimic scheduler pattern
    const next = new Date(Date.now() + 60 * 1000);
    await ScheduledJob.create({ type: 'goal_check', run_at: next, payload: { campaignObjectId: id } });
    res.json({ ok: true, status: 'running' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to start', error: e.message });
  }
});

router.post('/:id/pause', requireSession, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });
    const camp = await CampaignDefinition.findByIdAndUpdate(id, { status: 'paused' }, { new: true });
    if (!camp) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true, status: 'paused' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to pause', error: e.message });
  }
});

router.post('/:id/stop', requireSession, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });
    const camp = await CampaignDefinition.findByIdAndUpdate(id, { status: 'ended' }, { new: true });
    if (!camp) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true, status: 'ended' });
  } catch (e) {
    res.status(500).json({ message: 'Failed to stop', error: e.message });
  }
});

// Natural-language prefill to structured campaign draft
router.post('/nl-fill', requireSession, async (req, res) => {
  try {
    const prompt = String((req.body && req.body.text) || '').trim();
    if (!prompt) return res.status(400).json({ message: 'text required' });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const sys = `Extract a structured campaign JSON from the user's description.
Fields: name, description, audience.include_tags[], audience.exclude_tags[], audience.field_filters[{key,op,value}], audience.target ('invoice'|'delivery'), schedule.tz, schedule.windows[{day,start,end}], schedule.start_at (ISO), schedule.end_at (ISO), dialer.max_attempts, dialer.cooldown_hours, dialer.daily_cap, dialer.hourly_cap, script_profile, notes. Use reasonable defaults when missing.`;
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    const content = r.choices?.[0]?.message?.content || '{}';
    const json = JSON.parse(content);
    res.json(json);
  } catch (e) {
    res.status(500).json({ message: 'Failed to fill', error: e.message });
  }
});

// Minimal stats placeholder
router.get('/:id/stats', requireSession, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    // Placeholder: wire to CallAttempt aggregates later
    res.json({ calls_total: 0, connects: 0, conversions: 0, cost: 0 });
  } catch (e) {
    res.status(500).json({ message: 'Failed to fetch stats', error: e.message });
  }
});

module.exports = router;
