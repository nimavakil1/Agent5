/**
 * System API routes
 *
 * Endpoints for system monitoring, job statuses, and health checks.
 */

const express = require('express');
const router = express.Router();
const JobStatus = require('../../models/JobStatus');

/**
 * @route GET /api/system/job-statuses
 * @desc Get all job statuses for dashboard
 */
router.get('/job-statuses', async (req, res) => {
  try {
    const jobs = await JobStatus.find({})
      .sort({ category: 1, name: 1 })
      .lean();

    res.json({
      success: true,
      jobs: jobs.map(j => ({
        id: j.jobId,
        name: j.name,
        category: j.category,
        status: j.status,
        lastUpdate: j.lastUpdate,
        lastSuccess: j.lastSuccess,
        lastError: j.lastError,
        error: j.error,
        metadata: j.metadata
      }))
    });
  } catch (error) {
    console.error('Error fetching job statuses:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route POST /api/system/job-status
 * @desc Update a job status (internal use)
 */
router.post('/job-status', async (req, res) => {
  try {
    const { jobId, name, status, error, category, metadata } = req.body;

    if (!jobId || !name || !status) {
      return res.status(400).json({ success: false, error: 'jobId, name, and status are required' });
    }

    const job = await JobStatus.updateJobStatus(jobId, name, status, error, category, metadata);

    res.json({ success: true, job });
  } catch (error) {
    console.error('Error updating job status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @route GET /api/system/health
 * @desc Basic health check
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

module.exports = router;
