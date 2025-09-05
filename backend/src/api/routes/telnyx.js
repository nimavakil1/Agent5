
const express = require('express');
const router = express.Router();

router.post('/events', (req, res) => {
  console.log('Received Telnyx webhook:', req.body);
  res.sendStatus(200);
});

module.exports = router;
