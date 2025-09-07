const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const router = express.Router();
const { getAllCustomers, createCustomer, getCustomerById, updateCustomer, deleteCustomer } = require('../services/customerService');

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

router.get('/', async (req, res) => {
  try {
    const customers = await getAllCustomers();
    res.json(customers);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get customers', error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const newCustomer = await createCustomer(req.body);
    res.status(201).json(newCustomer);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create customer', error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const customer = await getCustomerById(req.params.id);
    res.json(customer);
  } catch (error) {
    res.status(500).json({ message: 'Failed to get customer', error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const updatedCustomer = await updateCustomer(req.params.id, req.body);
    res.json(updatedCustomer);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update customer', error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    await deleteCustomer(req.params.id);
    res.status(204).send(); // No content
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete customer', error: error.message });
  }
});

// CSV Upload endpoint
router.post('/upload-csv', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No CSV file uploaded' });
  }

  const results = [];
  const errors = [];
  let imported = 0;

  try {
    // Read and parse CSV
    const csvStream = fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        // Process each row
        for (const row of results) {
          try {
            const { name, phone_number, preferred_language } = row;
            
            if (!name || !phone_number) {
              errors.push(`Missing required fields in row: ${JSON.stringify(row)}`);
              continue;
            }

            await createCustomer({
              customer_id: `customer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              name: name.trim(),
              phone_number: phone_number.trim(),
              preferred_language: preferred_language?.trim() || 'en',
              historical_offers: [],
              previous_interactions: []
            });
            
            imported++;
          } catch (err) {
            errors.push(`Error processing row ${JSON.stringify(row)}: ${err.message}`);
          }
        }

        // Clean up uploaded file
        fs.unlink(req.file.path, (err) => {
          if (err) console.error('Error deleting uploaded file:', err);
        });

        res.json({ 
          imported, 
          total: results.length, 
          errors: errors.length > 0 ? errors : undefined 
        });
      });

  } catch (error) {
    // Clean up uploaded file on error
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Error deleting uploaded file:', err);
    });
    
    res.status(500).json({ message: 'Failed to process CSV', error: error.message });
  }
});

module.exports = router;
