const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { getAllCampaigns, createCampaign, updateCampaign, deleteCampaign } = require('../services/campaignService');

router.get('/', async (req, res) => {
  try {
    const campaigns = await getAllCampaigns();
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get campaigns', error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const newCampaign = await createCampaign(req.body);
    res.status(201).json(newCampaign);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create campaign', error: error.message });
  }
});

router.put('/:id', async (req, res) => {
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

router.delete('/:id', async (req, res) => {
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

module.exports = router;
