const express = require('express');
const OrchestratorPlan = require('../../models/OrchestratorPlan');
const CampaignDefinition = require('../../models/CampaignDefinition');
const ScheduledJob = require('../../models/ScheduledJob');
const OpenAI = require('openai');

const router = express.Router();

function toIsoOrNull(s) {
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// POST /api/orchestrator/interpret
router.post('/interpret', async (req, res) => {
  try {
    const { instruction } = req.body || {};
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ message: 'instruction required' });
    }

    // Use OpenAI to extract structured plan
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const system = `You are a planner. Convert the user's instruction into JSON with this exact shape:
{
  "action": "create_campaign",
  "schedule": { "start_time_iso": "YYYY-MM-DDTHH:mm:ssZ", "timezone": "Europe/Brussels" },
  "targeting": { "city": "", "country": "BE" },
  "product": { "sku": "" },
  "goal": { "type": "units_sold", "target": 0 },
  "channel": "pstn",
  "pacing": { "max_parallel_calls": 3, "rps": 0.5 },
  "notes": ""
}
Rules:
- Always output valid JSON, no markdown, no comments.
- If date is relative (e.g., next Monday), resolve to an ISO8601 date in Europe/Brussels.
- If city/country missing, set city to "" and country to "BE".
- goal.type defaults to "units_sold". channel defaults to "pstn".`;

    const resp = await client.responses.create({
      model: process.env.ORCHESTRATOR_MODEL || 'gpt-4o-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user', content: instruction }
      ],
      text: { format: { type: 'json' } },
    });

    let obj = null;
    try {
      const content = resp.output_text || resp.output?.[0]?.content?.[0]?.text || '';
      obj = JSON.parse(content);
    } catch (e) {
      return res.status(422).json({ message: 'Failed to parse plan', error: e.message });
    }

    // Basic normalization
    obj.schedule = obj.schedule || {};
    obj.schedule.timezone = obj.schedule.timezone || 'Europe/Brussels';
    if (obj.schedule.start_time_iso && !toIsoOrNull(obj.schedule.start_time_iso)) {
      return res.status(422).json({ message: 'Invalid start_time_iso produced' });
    }

    return res.json({ plan: obj });
  } catch (e) {
    console.error('interpret error', e);
    return res.status(500).json({ message: 'error' });
  }
});

// POST /api/orchestrator/commit
router.post('/commit', async (req, res) => {
  try {
    const { instruction, plan } = req.body || {};
    if (!instruction || !plan) return res.status(400).json({ message: 'instruction and plan required' });

    const startIso = plan?.schedule?.start_time_iso;
    const startDate = startIso ? new Date(startIso) : null;
    if (!startDate || !Number.isFinite(startDate.getTime())) {
      return res.status(400).json({ message: 'valid schedule.start_time_iso required' });
    }

    // Create CampaignDefinition using parsed plan
    const title = `Auto: ${plan.product?.sku || 'SKU'} in ${plan?.targeting?.city || 'unspecified'}`;
    const end = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000); // default 1 week window

    const campaign = await CampaignDefinition.create({
      campaign_id: `cmp-${Date.now()}`,
      title,
      start_date: startDate,
      end_date: end,
      products: plan.product?.sku ? [plan.product.sku] : [],
      promotional_logic: { source: 'orchestrator', raw_instruction: instruction },
      assigned_languages: ['de', 'en', 'fr'],
      behavioral_traits: [],
      pricing: {},
      tone: 'sales',
      target_groups: [],
      status: 'scheduled',
      channel: plan.channel || 'pstn',
      targeting: plan.targeting || {},
      pacing: plan.pacing || {},
      goal: plan.goal || {},
    });

    const orch = await OrchestratorPlan.create({ instruction, plan, status: 'scheduled', campaign_id: String(campaign._id) });

    // Create scheduled job to start the campaign
    await ScheduledJob.create({
      type: 'start_campaign',
      run_at: startDate,
      payload: { campaignObjectId: String(campaign._id) },
    });

    return res.status(201).json({ campaign, orchestrator: orch });
  } catch (e) {
    console.error('commit error', e);
    return res.status(500).json({ message: 'error' });
  }
});

module.exports = router;
