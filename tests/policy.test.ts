import test from 'node:test';
import assert from 'node:assert/strict';
import { accrue, canStart, nextAdmission } from '../src/policy.ts';

test('0.2 runs ten minutes, then waits forty minutes', () => {
  assert.equal(canStart(0.2, 0, 0), true);
  const balance = accrue(0, 0.2, 600_000, 600_000);
  assert.equal(balance, -480_000);
  assert.equal(canStart(0.2, balance, 0), false);
  assert.equal(nextAdmission(0.2, balance, 0), 2_400_001);
  assert.equal(accrue(balance, 0.2, 2_400_000, 0), 0);
});

test('fractional targets bound instantaneous concurrency', () => {
  for (const target of [0.2, 1, 1.5, 3.14]) {
    assert.equal(canStart(target, 0, Math.ceil(target) - 1), true);
    assert.equal(canStart(target, 0, Math.ceil(target)), false);
    assert.equal(canStart(target, -1, 0), false);
  }
});

test('idle allowance is bounded to sixty seconds times target', () => {
  assert.equal(accrue(0, 1.5, 86_400_000, 0), 90_000);
  assert.equal(accrue(-100, 1, 50, 0), -50);
});

test('repayment timer accounts for still running instances', () => {
  assert.equal(nextAdmission(1.5, -5_000, 1), 10_001);
  assert.equal(nextAdmission(1.5, -5_000, 2), null);
  assert.equal(nextAdmission(0, 0, 0), null);
  assert.equal(canStart(0, 100, 0), false);
});

test('nonpreemptive admission converges for a continuously queued workload', () => {
  for (const target of [0.2, 1, 1.5, 3.14]) {
    let balance = 0;
    let used = 0;
    let sequence = 0;
    let running: number[] = [];
    const duration = 5_000_000;
    for (let now = 0; now < duration; now += 100) {
      running = running.filter(end => end > now);
      while (canStart(target, balance, running.length)) {
        running.push(now + (1 + sequence++ % 13) * 1_000);
      }
      const usage = running.length * 100;
      used += usage;
      balance = accrue(balance, target, 100, usage);
    }
    assert.ok(Math.abs(used / duration - target) < 0.02, `${target}: ${used / duration}`);
  }
});
