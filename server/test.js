#!/usr/bin/env node

/**
 * Test suite for CRDT implementation
 * Run with: node test.js
 */

import { VectorClock, LWWRegister, CRDTObject } from './types.js';

console.log('🧪 Running CRDT Tests\n');

let testsRun = 0;
let testsPassed = 0;

function assert(condition, message) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${message}`);
  } else {
    console.log(`  ❌ ${message}`);
  }
}

function test(name, fn) {
  console.log(`\n📋 ${name}`);
  fn();
}

// Test Vector Clock
test('Vector Clock - Increment', () => {
  const vc = new VectorClock();
  vc.increment('user1');
  assert(vc.clock['user1'] === 1, 'Increments to 1');
  vc.increment('user1');
  assert(vc.clock['user1'] === 2, 'Increments to 2');
});

test('Vector Clock - Merge', () => {
  const vc1 = new VectorClock({ 'user1': 5, 'user2': 3 });
  const vc2 = new VectorClock({ 'user1': 3, 'user2': 7, 'user3': 2 });
  const merged = vc1.merge(vc2);
  
  assert(merged.clock['user1'] === 5, 'Takes max for user1');
  assert(merged.clock['user2'] === 7, 'Takes max for user2');
  assert(merged.clock['user3'] === 2, 'Includes user3');
});

test('Vector Clock - Comparison', () => {
  const vc1 = new VectorClock({ 'user1': 5, 'user2': 3 });
  const vc2 = new VectorClock({ 'user1': 3, 'user2': 3 });
  const vc3 = new VectorClock({ 'user1': 5, 'user2': 4 });
  const vc4 = new VectorClock({ 'user1': 6, 'user2': 2 });
  
  assert(vc1.compare(vc2) === 1, 'vc1 > vc2 (causally newer)');
  assert(vc2.compare(vc1) === -1, 'vc2 < vc1 (causally older)');
  assert(vc1.compare(vc1) === 0, 'vc1 == vc1 (equal)');
  assert(vc1.compare(vc3) === -1, 'vc1 < vc3 (all values <=)');
  assert(vc1.compare(vc4) === null, 'vc1 || vc4 (concurrent: user1 less, user2 greater)');
});

// Test LWW-Register
test('LWW-Register - Causal Ordering', () => {
  const reg1 = new LWWRegister('value1', 1000, 'user1', new VectorClock({ 'user1': 5 }));
  const reg2 = new LWWRegister('value2', 2000, 'user1', new VectorClock({ 'user1': 7 }));
  
  reg1.merge(reg2);
  assert(reg1.value === 'value2', 'Newer causal value wins');
});

test('LWW-Register - Concurrent with Timestamp', () => {
  const reg1 = new LWWRegister('value1', 1000, 'user1', new VectorClock({ 'user1': 5 }));
  const reg2 = new LWWRegister('value2', 2000, 'user2', new VectorClock({ 'user2': 5 }));
  
  reg1.merge(reg2);
  assert(reg1.value === 'value2', 'Higher timestamp wins when concurrent');
});

test('LWW-Register - Concurrent with Same Timestamp', () => {
  const reg1 = new LWWRegister('value1', 1000, 'user-a', new VectorClock({ 'user-a': 5 }));
  const reg2 = new LWWRegister('value2', 1000, 'user-b', new VectorClock({ 'user-b': 5 }));
  
  reg1.merge(reg2);
  assert(reg1.value === 'value2', 'Lexicographic clientId wins (user-b > user-a)');
});

test('LWW-Register - Stale Update Ignored', () => {
  const reg1 = new LWWRegister('value1', 2000, 'user1', new VectorClock({ 'user1': 10 }));
  const reg2 = new LWWRegister('value2', 1000, 'user1', new VectorClock({ 'user1': 5 }));
  
  reg1.merge(reg2);
  assert(reg1.value === 'value1', 'Stale value ignored');
});

// Test CRDT Object
test('CRDT Object - Create and Update', () => {
  const obj = new CRDTObject('obj-1', 'mesh', 'box');
  
  obj.updateProperty(
    'transform.position',
    { x: 5, y: 0, z: 3 },
    1000,
    'user1',
    new VectorClock({ 'user1': 1 })
  );
  
  assert(obj.transform.position.value.x === 5, 'Position x updated');
  assert(obj.transform.position.value.y === 0, 'Position y updated');
  assert(obj.transform.position.value.z === 3, 'Position z updated');
});

test('CRDT Object - Concurrent Updates', () => {
  const obj = new CRDTObject('obj-1', 'mesh', 'box');
  
  // User 1 moves to (5, 0, 0) at t=1000
  obj.updateProperty(
    'transform.position',
    { x: 5, y: 0, z: 0 },
    1000,
    'user1',
    new VectorClock({ 'user1': 1 })
  );
  
  // User 2 moves to (0, 0, 5) at t=1001 (concurrent)
  obj.updateProperty(
    'transform.position',
    { x: 0, y: 0, z: 5 },
    1001,
    'user2',
    new VectorClock({ 'user2': 1 })
  );
  
  assert(obj.transform.position.value.x === 0, 'Higher timestamp wins - x');
  assert(obj.transform.position.value.z === 5, 'Higher timestamp wins - z');
});

test('CRDT Object - Delete', () => {
  const obj = new CRDTObject('obj-1', 'mesh', 'box');
  
  assert(obj.isDeleted() === false, 'Initially not deleted');
  
  obj.delete(1000, 'user1', new VectorClock({ 'user1': 5 }));
  
  assert(obj.isDeleted() === true, 'Marked as deleted');
  assert(obj.tombstone.clientId === 'user1', 'Tombstone has correct clientId');
});

test('CRDT Object - Serialize/Deserialize', () => {
  const obj = new CRDTObject('obj-1', 'mesh', 'sphere');
  obj.updateProperty(
    'transform.position',
    { x: 3, y: 2, z: 1 },
    1000,
    'user1',
    new VectorClock({ 'user1': 10 })
  );
  
  const json = obj.toJSON();
  const restored = CRDTObject.fromJSON(json);
  
  assert(restored.id === 'obj-1', 'ID preserved');
  assert(restored.geometry === 'sphere', 'Geometry preserved');
  assert(restored.transform.position.value.x === 3, 'Position preserved');
  assert(restored.transform.position.clientId === 'user1', 'ClientId preserved');
});

// Conflict Scenario Tests
test('Conflict Scenario - Concurrent Move Operations', () => {
  // Simulates two users moving the same object at nearly the same time
  const obj1 = new CRDTObject('obj-1', 'mesh', 'box');
  const obj2 = new CRDTObject('obj-1', 'mesh', 'box');
  
  // User A moves to (5, 0, 0)
  const vcA = new VectorClock({ 'userA': 10, 'userB': 5 });
  obj1.updateProperty('transform.position', { x: 5, y: 0, z: 0 }, 2000, 'userA', vcA);
  
  // User B moves to (0, 0, 5) (concurrent)
  const vcB = new VectorClock({ 'userA': 9, 'userB': 6 });
  obj2.updateProperty('transform.position', { x: 0, y: 0, z: 5 }, 2001, 'userB', vcB);
  
  // Merge obj2 into obj1 (simulating obj1 receiving obj2's operation)
  obj1.transform.position.merge(obj2.transform.position);
  
  assert(obj1.transform.position.value.x === 0, 'User B wins (higher timestamp)');
  assert(obj1.transform.position.value.z === 5, 'User B wins (higher timestamp)');
});

test('Conflict Scenario - Create-Delete Race', () => {
  const obj = new CRDTObject('obj-1', 'mesh', 'box');
  
  // Object created at t=1000
  obj.createdAt = 1000;
  obj.createdBy = 'userA';
  
  // User B deletes at t=1001
  obj.delete(1001, 'userB', new VectorClock({ 'userB': 5 }));
  
  assert(obj.isDeleted() === true, 'Delete operation applied');
  
  // Any subsequent updates should check isDeleted() before applying
  // This simulates the OR-Set "delete wins" behavior
});

test('Conflict Scenario - Edit Different Properties', () => {
  const obj = new CRDTObject('obj-1', 'mesh', 'box');
  
  // User A changes position
  obj.updateProperty(
    'transform.position',
    { x: 5, y: 0, z: 0 },
    1000,
    'userA',
    new VectorClock({ 'userA': 10 })
  );
  
  // User B changes rotation (different property, no conflict)
  obj.updateProperty(
    'transform.rotation',
    { x: 0, y: 0.5, z: 0, w: 0.866 },
    1000,
    'userB',
    new VectorClock({ 'userB': 10 })
  );
  
  assert(obj.transform.position.value.x === 5, 'Position updated by A');
  assert(obj.transform.rotation.value.y === 0.5, 'Rotation updated by B');
  
  // Both changes persist because they're independent properties
});

// Print results
console.log('\n' + '='.repeat(50));
console.log(`\n📊 Results: ${testsPassed}/${testsRun} tests passed`);

if (testsPassed === testsRun) {
  console.log('✅ All tests passed!\n');
  process.exit(0);
} else {
  console.log(`❌ ${testsRun - testsPassed} tests failed\n`);
  process.exit(1);
}
