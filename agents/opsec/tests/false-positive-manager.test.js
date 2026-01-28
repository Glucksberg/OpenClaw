// Test suite for FalsePositiveManager
// Run with: node tests/false-positive-manager.test.js

const fs = require('fs');
const path = require('path');
const FPManager = require('../scripts/false-positive-manager.cjs');

// Simple test framework
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('🧪 Running False Positive Manager Tests\n');
    
    for (const test of this.tests) {
      try {
        await test.fn();
        console.log(`✅ ${test.name}`);
        this.passed++;
      } catch (error) {
        console.log(`❌ ${test.name}`);
        console.log(`   Error: ${error.message}`);
        this.failed++;
      }
    }
    
    console.log(`\n📊 Results: ${this.passed} passed, ${this.failed} failed`);
    return this.failed === 0;
  }
}

// Test utilities
function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message = `Expected ${expected}, got ${actual}`) {
  if (actual !== expected) throw new Error(message);
}

function assertNotNull(value, message = 'Value should not be null') {
  if (value === null || value === undefined) throw new Error(message);
}

// Setup test environment
const testDir = path.join(__dirname, 'temp');
const testFile = path.join(testDir, 'test-fp.json');

function setupTest() {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }
  return new FPManager(testFile);
}

function cleanupTest() {
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }
}

// Test suite
const runner = new TestRunner();

runner.test('should initialize with empty data', () => {
  const manager = setupTest();
  assertEqual(Object.keys(manager.data.false_positives).length, 0);
  assertEqual(manager.data.metadata.total_entries, 0);
  cleanupTest();
});

runner.test('should add new false positive', () => {
  const manager = setupTest();
  const fp = manager.add('TEST-FP', 'Test FP', 'Test description', 'test.*error');
  
  assertEqual(fp.id, 'TEST-FP');
  assertEqual(fp.name, 'Test FP');
  assertEqual(fp.count, 1);
  assertEqual(manager.data.metadata.total_entries, 1);
  
  cleanupTest();
});

runner.test('should validate pattern correctly', () => {
  const manager = setupTest();
  
  // Valid pattern should work
  manager.add('VALID-FP', 'Valid FP', 'Test', 'valid.*pattern');
  
  // Invalid pattern should throw
  try {
    manager.add('INVALID-FP', 'Invalid FP', 'Test', '[invalid regex');
    assert(false, 'Should have thrown for invalid regex');
  } catch (error) {
    assert(error.message.includes('Invalid regex pattern'));
  }
  
  cleanupTest();
});

runner.test('should validate ID format', () => {
  const manager = setupTest();
  
  // Valid ID should work
  manager.add('VALID-ID-123', 'Valid', 'Test', 'test');
  
  // Invalid ID should throw
  try {
    manager.add('invalid-id', 'Invalid', 'Test', 'test');
    assert(false, 'Should have thrown for invalid ID format');
  } catch (error) {
    assert(error.message.includes('uppercase letters'));
  }
  
  cleanupTest();
});

runner.test('should detect known false positive', () => {
  const manager = setupTest();
  manager.add('SYNTAX-ERR', 'Syntax Error', 'Test syntax error', 'syntax.*error');
  
  const match = manager.checkMatch('A syntax error occurred in the code');
  assertNotNull(match);
  assertEqual(match.id, 'SYNTAX-ERR');
  assertEqual(match.fp.name, 'Syntax Error');
  
  cleanupTest();
});

runner.test('should respect process filtering', () => {
  const manager = setupTest();
  manager.add('PROC-ERR', 'Process Error', 'Test', 'process.*error', {
    affected_processes: ['cloudfarm']
  });
  
  // Should match with correct process
  const match1 = manager.checkMatch('process error occurred', 'cloudfarm');
  assertNotNull(match1);
  assertEqual(match1.id, 'PROC-ERR');
  
  // Should not match with wrong process
  const match2 = manager.checkMatch('process error occurred', 'otherprocess');
  assertEqual(match2, null);
  
  // Should match with no process specified
  const match3 = manager.checkMatch('process error occurred');
  assertNotNull(match3);
  
  cleanupTest();
});

runner.test('should increment counter correctly', () => {
  const manager = setupTest();
  manager.add('COUNT-TEST', 'Count Test', 'Test', 'count.*test');
  
  const beforeCount = manager.data.false_positives['COUNT-TEST'].count;
  const beforeHistoryLength = manager.data.false_positives['COUNT-TEST'].history.length;
  
  manager.increment('COUNT-TEST', 'test context');
  
  const afterCount = manager.data.false_positives['COUNT-TEST'].count;
  const afterHistoryLength = manager.data.false_positives['COUNT-TEST'].history.length;
  
  assertEqual(afterCount, beforeCount + 1);
  assertEqual(afterHistoryLength, beforeHistoryLength + 1);
  
  cleanupTest();
});

runner.test('should handle invalid regex patterns gracefully', () => {
  const manager = setupTest();
  
  // Manually corrupt data to test runtime protection
  manager.data.false_positives['BAD-REGEX'] = {
    id: 'BAD-REGEX',
    pattern: '[unclosed bracket',
    count: 1
  };
  
  // Should not throw, should return null
  const match = manager.checkMatch('test message');
  assertEqual(match, null);
  
  cleanupTest();
});

runner.test('should generate statistics correctly', () => {
  const manager = setupTest();
  
  manager.add('FP1', 'FP1', 'Test', 'test1', { auto_resolve: true, severity: 'low' });
  manager.add('FP2', 'FP2', 'Test', 'test2', { auto_resolve: false, severity: 'high' });
  manager.increment('FP1', 'context');
  
  const stats = manager.getStats();
  
  assertEqual(stats.total, 2);
  assertEqual(stats.total_occurrences, 3); // FP1 has 2, FP2 has 1
  assertEqual(stats.auto_resolvable, 1);
  assertEqual(stats.by_severity.low, 1);
  assertEqual(stats.by_severity.high, 1);
  
  cleanupTest();
});

runner.test('should perform atomic file saves', () => {
  const manager = setupTest();
  
  // Add some data
  manager.add('ATOMIC-TEST', 'Atomic Test', 'Test', 'atomic');
  
  // Verify file exists and is valid JSON
  assert(fs.existsSync(testFile));
  
  const fileContent = fs.readFileSync(testFile, 'utf8');
  const parsedData = JSON.parse(fileContent); // Should not throw
  assertEqual(parsedData.metadata.total_entries, 1);
  
  cleanupTest();
});

runner.test('should cache compiled regexes for performance', () => {
  const manager = setupTest();
  
  manager.add('CACHE-TEST', 'Cache Test', 'Test', 'cache.*test');
  
  // First check should compile and cache regex
  const match1 = manager.checkMatch('cache test message');
  assertNotNull(match1);
  
  // Verify regex is cached
  assert(manager.regexCache.has('CACHE-TEST'));
  
  // Second check should use cached regex
  const match2 = manager.checkMatch('another cache test');
  assertNotNull(match2);
  
  cleanupTest();
});

runner.test('should export training data correctly', () => {
  const manager = setupTest();
  
  manager.add('TRAIN-1', 'Training 1', 'Test', 'train1', {
    auto_resolve: true,
    severity: 'low',
    user_triggers: ['click', 'timeout']
  });
  
  manager.add('TRAIN-2', 'Training 2', 'Test', 'train2', {
    auto_resolve: false,
    severity: 'high',
    user_triggers: ['network']
  });
  
  const trainingData = manager.exportTrainingData();
  assertEqual(trainingData.length, 2);
  
  const first = trainingData.find(d => d.pattern === 'train1');
  assertNotNull(first);
  assertEqual(first.auto_resolve, true);
  assertEqual(first.severity, 'low');
  assertEqual(first.user_triggers.length, 2);
  
  cleanupTest();
});

runner.test('should generate Slack alerts correctly', () => {
  const manager = setupTest();
  
  const fp = manager.add('SLACK-TEST', 'Slack Test', 'Test alert', 'slack', {
    severity: 'high',
    auto_resolve: true
  });
  
  const alert = manager.generateSlackAlert({ id: 'SLACK-TEST', fp });
  
  assert(alert.text.includes('SLACK-TEST'));
  assertEqual(alert.attachments[0].color, 'danger'); // high severity
  assert(alert.attachments[0].fields.some(f => f.title === 'Auto-resolve' && f.value === '✅'));
  
  cleanupTest();
});

// Run all tests
runner.run().then(success => {
  if (!success) {
    process.exit(1);
  }
  
  // Cleanup test directory
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true });
  }
  
  console.log('\n🎉 All tests completed successfully!');
});