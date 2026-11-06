import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCircuitBreaker, CircuitOpenError, ProbeLimitError } from '../dist/esm/index.js';
const fail = () => {
  throw new Error('service failed');
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

test('consecutive failures open the circuit and success resets the streak', async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 2, clock: () => 100, cooldownMs: 20 });
  await assert.rejects(breaker.execute(fail), /service failed/);
  assert.equal(await breaker.execute(() => 1), 1);
  assert.equal(breaker.snapshot().consecutiveFailures, 0);
  await assert.rejects(breaker.execute(fail));
  await assert.rejects(breaker.execute(fail));
  assert.equal(breaker.snapshot().state, 'open');
  let called = false;
  await assert.rejects(
    breaker.execute(() => {
      called = true;
    }),
    (error) => error instanceof CircuitOpenError && error.retryAt === 120,
  );
  assert.equal(called, false);
});
test('cooldown exact boundary permits a probe and successful probes close the circuit', async () => {
  let time = 0;
  const breaker = createCircuitBreaker({
    failureThreshold: 1,
    cooldownMs: 10,
    successThreshold: 2,
    clock: () => time,
  });
  await assert.rejects(breaker.execute(fail));
  time = 9;
  await assert.rejects(
    breaker.execute(() => 1),
    CircuitOpenError,
  );
  time = 10;
  await breaker.execute(() => 1);
  assert.equal(breaker.snapshot().state, 'half-open');
  assert.equal(breaker.snapshot().probeSuccesses, 1);
  await breaker.execute(() => 2);
  assert.equal(breaker.snapshot().state, 'closed');
});
test('half-open probes have bounded concurrency and counted failures reopen', async () => {
  let time = 0;
  const breaker = createCircuitBreaker({ cooldownMs: 10, clock: () => time });
  breaker.forceOpen();
  time = 10;
  const pending = deferred(),
    first = breaker.execute(() => pending.promise);
  assert.equal(breaker.snapshot().activeProbes, 1);
  await assert.rejects(
    breaker.execute(() => 'not called'),
    ProbeLimitError,
  );
  pending.reject(new Error('probe failed'));
  await assert.rejects(first, /probe failed/);
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.snapshot().retryAt, 20);
});
test('old successes cannot close a newer open circuit', async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1 });
  const pending = deferred(),
    first = breaker.execute(() => pending.promise);
  await assert.rejects(breaker.execute(fail));
  pending.resolve('old success');
  assert.equal(await first, 'old success');
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.snapshot().activeCalls, 0);
});
test('old failures cannot alter a reset generation', async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1 });
  const pending = deferred(),
    first = breaker.execute(() => pending.promise);
  breaker.reset();
  pending.reject(new Error('old'));
  await assert.rejects(first, /old/);
  assert.equal(breaker.snapshot().state, 'closed');
  assert.equal(breaker.snapshot().consecutiveFailures, 0);
});
test('a late probe failure cannot reopen a generation closed by another probe', async () => {
  const breaker = createCircuitBreaker({ maxProbes: 2, successThreshold: 1, cooldownMs: 0 });
  breaker.forceOpen();
  const pending = deferred(),
    slow = breaker.execute(() => pending.promise);
  await breaker.execute(() => 'recovered');
  pending.reject(new Error('late probe'));
  await assert.rejects(slow, /late probe/);
  assert.equal(breaker.snapshot().state, 'closed');
  assert.equal(breaker.snapshot().activeProbes, 0);
  assert.equal(breaker.snapshot().activeCalls, 0);
});
test('failure classifiers ignore expected errors without hiding them', async () => {
  const breaker = createCircuitBreaker({
    failureThreshold: 1,
    isFailure: (error) => !(error instanceof TypeError),
  });
  await assert.rejects(
    breaker.execute(() => {
      throw new TypeError('input');
    }),
    TypeError,
  );
  assert.equal(breaker.snapshot().state, 'closed');
  await assert.rejects(breaker.execute(fail));
  assert.equal(breaker.snapshot().state, 'open');
});
test('classifier failures remain explicit and protect against uncontrolled calls', async () => {
  const breaker = createCircuitBreaker({
    failureThreshold: 1,
    isFailure() {
      throw new Error('policy');
    },
  });
  await assert.rejects(
    breaker.execute(fail),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(breaker.snapshot().state, 'open');
});
test('snapshots are independent and cooldown does not schedule background timers', async () => {
  let time = 100;
  const breaker = createCircuitBreaker({ clock: () => time, cooldownMs: 10 });
  breaker.forceOpen();
  const snapshot = breaker.snapshot();
  snapshot.state = 'closed';
  time = 105;
  assert.equal(breaker.snapshot().remainingMs, 5);
  time = 90;
  assert.equal(breaker.snapshot().remainingMs, 5);
  time = 110;
  assert.equal(breaker.snapshot().state, 'open');
  assert.equal(breaker.snapshot().remainingMs, 0);
});
test('zero cooldown and ignored probe failures have defined behavior', async () => {
  const breaker = createCircuitBreaker({
    cooldownMs: 0,
    successThreshold: 1,
    isFailure: () => false,
  });
  breaker.forceOpen();
  await assert.rejects(breaker.execute(fail));
  assert.equal(breaker.snapshot().state, 'half-open');
  assert.equal(breaker.snapshot().activeProbes, 0);
  await breaker.execute(() => 'recovered');
  assert.equal(breaker.snapshot().state, 'closed');
});
test('invalid configuration and invalid clocks fail explicitly', async () => {
  for (const options of [
    { failureThreshold: 0 },
    { cooldownMs: -1 },
    { maxProbes: 0 },
    { successThreshold: 1.5 },
  ])
    assert.throws(() => createCircuitBreaker(options), RangeError);
  assert.throws(() => createCircuitBreaker({ clock: 1 }), TypeError);
  assert.throws(() => createCircuitBreaker({ clock: () => NaN }).forceOpen(), /finite/);
  await assert.rejects(createCircuitBreaker().execute(1), TypeError);
});
test('CommonJS supports independent circuit state', async () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.equal(await cjs.createCircuitBreaker().execute(() => 3), 3);
});
