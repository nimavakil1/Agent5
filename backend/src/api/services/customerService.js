const CustomerRecord = require('../../models/CustomerRecord');

async function getAllCustomers() {
  try {
    const customers = await CustomerRecord.find();
    return customers;
  } catch (error) {
    console.error('Error getting all customers:', error);
    throw error;
  }
}

async function createCustomer(customerData) {
  try {
    const newCustomer = new CustomerRecord(customerData);
    await newCustomer.save();
    return newCustomer;
  } catch (error) {
    console.error('Error creating customer:', error);
    throw error;
  }
}

async function getCustomerById(id) {
  try {
    const customer = await CustomerRecord.findById(id);
    if (!customer) {
      throw new Error('Customer not found');
    }
    return customer;
  } catch (error) {
    console.error('Error getting customer by ID:', error);
    throw error;
  }
}

async function updateCustomer(id, customerData) {
  try {
    const updatedCustomer = await CustomerRecord.findByIdAndUpdate(id, customerData, { new: true });
    if (!updatedCustomer) {
      throw new Error('Customer not found');
    }
    return updatedCustomer;
  } catch (error) {
    console.error('Error updating customer:', error);
    throw error;
  }
}

async function deleteCustomer(id) {
  try {
    const deletedCustomer = await CustomerRecord.findByIdAndDelete(id);
    if (!deletedCustomer) {
      throw new Error('Customer not found');
    }
    return deletedCustomer;
  } catch (error) {
    console.error('Error deleting customer:', error);
    throw error;
  }
}

module.exports = {
  getAllCustomers,
  createCustomer,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
};