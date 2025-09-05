
const CampaignDefinition = require('../../models/CampaignDefinition');

async function getAllCampaigns() {
  try {
    const campaigns = await CampaignDefinition.find();
    return campaigns;
  } catch (error) {
    console.error('Error getting all campaigns:', error);
    throw error;
  }
}

async function createCampaign(campaignData) {
  try {
    const newCampaign = new CampaignDefinition(campaignData);
    await newCampaign.save();
    return newCampaign;
  } catch (error) {
    console.error('Error creating campaign:', error);
    throw error;
  }
}

async function updateCampaign(id, campaignData) {
  try {
    const updatedCampaign = await CampaignDefinition.findByIdAndUpdate(id, campaignData, { new: true, runValidators: true });
    if (!updatedCampaign) {
      throw new Error('Campaign not found');
    }
    return updatedCampaign;
  } catch (error) {
    console.error('Error updating campaign:', error);
    throw error;
  }
}

async function deleteCampaign(id) {
  try {
    const deletedCampaign = await CampaignDefinition.findByIdAndDelete(id);
    if (!deletedCampaign) {
      throw new Error('Campaign not found');
    }
    return deletedCampaign;
  } catch (error) {
    console.error('Error deleting campaign:', error);
    throw error;
  }
}

module.exports = {
  getAllCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
};
