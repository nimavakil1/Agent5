const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { getAllCustomers, createCustomer, getCustomerById, updateCustomer, deleteCustomer } = require('../services/customerService');

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

module.exports = router;
