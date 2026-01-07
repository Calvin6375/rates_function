/**
 * Test script for Firebase Functions
 * Run with: node test-functions.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:5001/truepay-72060/us-central1';
const PROJECT_ID = 'truepay-72060';
const REGION = 'us-central1';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

function logResult(name, success, data, error = null) {
  const status = success ? '✓' : '✗';
  const color = success ? 'green' : 'red';
  log(`\n${status} ${name}`, color);
  
  if (error) {
    log(`  Error: ${error.message || error}`, 'red');
    if (error.response) {
      log(`  Status: ${error.response.status}`, 'yellow');
      log(`  Response: ${JSON.stringify(error.response.data, null, 2)}`, 'yellow');
    }
  } else if (data) {
    log(`  Response: ${JSON.stringify(data, null, 2)}`, 'blue');
  }
}

async function testHTTPEndpoint(name, method, path, data = null, headers = {}) {
  try {
    const url = `${BASE_URL}${path}`;
    log(`\nTesting: ${method} ${path}`, 'yellow');
    
    let response;
    if (method === 'GET') {
      response = await axios.get(url, { headers, timeout: 30000 });
    } else if (method === 'POST') {
      response = await axios.post(url, data, { headers, timeout: 30000 });
    } else if (method === 'PUT') {
      response = await axios.put(url, data, { headers, timeout: 30000 });
    }
    
    logResult(name, true, response.data);
    return { success: true, data: response.data };
  } catch (error) {
    logResult(name, false, null, error);
    return { success: false, error: error.message, status: error.response?.status };
  }
}

async function runTests() {
  logSection('Firebase Functions Local Testing');
  log(`Base URL: ${BASE_URL}`, 'blue');
  log(`Project: ${PROJECT_ID}`, 'blue');
  log(`Region: ${REGION}`, 'blue');
  
  const results = {
    passed: 0,
    failed: 0,
    skipped: 0,
    tests: [],
  };

  // Test HTTP Endpoints
  logSection('HTTP Endpoints (No Auth Required)');

  // 1. fetchBinanceRatesHttp - GET
  let result = await testHTTPEndpoint(
    'fetchBinanceRatesHttp (GET)',
    'GET',
    '/fetchBinanceRatesHttp?fiat=KES&asset=USDT'
  );
  results.tests.push({ name: 'fetchBinanceRatesHttp (GET)', ...result });
  if (result.success) results.passed++; else results.failed++;

  // 2. fetchBinanceRatesHttp - POST
  result = await testHTTPEndpoint(
    'fetchBinanceRatesHttp (POST)',
    'POST',
    '/fetchBinanceRatesHttp',
    { fiat: 'KES', asset: 'USDT' },
    { 'Content-Type': 'application/json' }
  );
  results.tests.push({ name: 'fetchBinanceRatesHttp (POST)', ...result });
  if (result.success) results.passed++; else results.failed++;

  // 3. Customer Wallets API - Get Binance Rates
  result = await testHTTPEndpoint(
    'API: GET /binance/rates',
    'GET',
    '/api/binance/rates?fiat=KES&asset=USDT'
  );
  results.tests.push({ name: 'API: GET /binance/rates', ...result });
  if (result.success) results.passed++; else results.failed++;

  // 4. Customer Wallets API - List Wallets
  result = await testHTTPEndpoint(
    'API: GET /customer-wallets',
    'GET',
    '/api/customer-wallets?limit=5&offset=0'
  );
  results.tests.push({ name: 'API: GET /customer-wallets', ...result });
  if (result.success) results.passed++; else results.failed++;

  // 5. Customer Wallets API - Create Wallet
  result = await testHTTPEndpoint(
    'API: POST /customer-wallets',
    'POST',
    '/api/customer-wallets',
    {
      name: 'Test User',
      email: `test-${Date.now()}@example.com`,
      phone: '+254712345678',
      initialBalance: 100
    },
    { 'Content-Type': 'application/json' }
  );
  results.tests.push({ name: 'API: POST /customer-wallets', ...result });
  if (result.success) results.passed++; else results.failed++;

  // 6. Migration Endpoint
  result = await testHTTPEndpoint(
    'migrateUsersHttp',
    'POST',
    '/migrateUsersHttp/migrateUsers',
    {},
    { 'Content-Type': 'application/json' }
  );
  results.tests.push({ name: 'migrateUsersHttp', ...result });
  if (result.success) results.passed++; else results.failed++;

  // 7. Update Phone Numbers Endpoint
  result = await testHTTPEndpoint(
    'updatePhoneNumbersHttp',
    'POST',
    '/updatePhoneNumbersHttp/updatePhoneNumbers',
    {},
    { 'Content-Type': 'application/json' }
  );
  results.tests.push({ name: 'updatePhoneNumbersHttp', ...result });
  if (result.success) results.passed++; else results.failed++;

  // Summary
  logSection('Test Summary');
  log(`Total Tests: ${results.tests.length}`, 'blue');
  log(`Passed: ${results.passed}`, 'green');
  log(`Failed: ${results.failed}`, 'red');
  log(`Skipped: ${results.skipped}`, 'yellow');

  // Detailed Results
  logSection('Detailed Results');
  results.tests.forEach((test, index) => {
    const status = test.success ? '✓' : '✗';
    const color = test.success ? 'green' : 'red';
    log(`${index + 1}. ${status} ${test.name}`, color);
    if (test.error) {
      log(`   Error: ${test.error}`, 'yellow');
    }
  });

  return results;
}

// Run tests
if (require.main === module) {
  runTests()
    .then((results) => {
      process.exit(results.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      log(`\nFatal error: ${error.message}`, 'red');
      console.error(error);
      process.exit(1);
    });
}

module.exports = { runTests, testHTTPEndpoint };

