# @lp-labs/circuit-breaker

Independent circuit breaker for synchronous/asynchronous operations, with cooldown, bounded half-open probes and stale-completion protection. Zero runtime or peer dependencies.

## Install

```sh
npm install @lp-labs/circuit-breaker
```

Node 18+ or ES2022 browsers. ESM/CommonJS and declarations included.

## Quick start

```js
import { createCircuitBreaker } from '@lp-labs/circuit-breaker';
const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 10000 });
const result = await breaker.execute(async () => 'service response');
console.log(result); // "service response"
console.log(breaker.snapshot().state); // "closed"
```

CommonJS: `const { createCircuitBreaker } = require('@lp-labs/circuit-breaker');`.

For HTTP, explicitly throw on unhealthy statuses: fetch resolves for HTTP 500 and therefore looks successful until your callback checks `response.ok`.

## API reference

Runtime exports: `createCircuitBreaker`, `CircuitOpenError`, `ProbeLimitError`.

Types: `CircuitState`, `BreakerOptions`, `BreakerSnapshot`, `CircuitBreaker`.

### `createCircuitBreaker(options?): CircuitBreaker`

| Option | Default | Meaning |
|---|---|---|
| `failureThreshold` | 5 | Positive safe integer: consecutive counted failures before opening |
| `cooldownMs` | 30000 | Nonnegative safe integer cooldown |
| `successThreshold` | 1 | Successful half-open probes needed to close |
| `maxProbes` | 1 | Maximum concurrent half-open probes |
| `isFailure(error)` | always true | Synchronous classifier for failures that should affect circuit state |
| `clock()` | Date.now | Finite-number clock in milliseconds |

`execute<T>(operation: () => T | PromiseLike<T>): Promise<T>` invokes the operation if allowed and preserves its resolved value or thrown/rejected value.

- Closed: operations run concurrently. Success resets the failure streak. Counted failures increment it; threshold opens the circuit.
- Open: operations reject with CircuitOpenError without being invoked until `now >= retryAt`.
- Half-open: entered lazily by the next execution at/after cooldown, not by a timer. Up to maxProbes execute simultaneously. Successful probes accumulate until successThreshold closes the circuit. Any counted probe failure reopens immediately.
- Ignored failures still reject the caller, but do not reset/increment a closed failure streak or count as successful probes.
- Concurrent completion order defines consecutive failures. This is not a rolling-window failure-rate breaker.

### State and control

- `snapshot()` returns a fresh BreakerSnapshot: `state`, `consecutiveFailures`, `probeSuccesses`, `activeProbes`, `activeCalls`, `retryAt` and `remainingMs`.
- `retryAt` is null unless open and is expressed in your clock's units/origin.
- Expired cooldown does not change snapshot state; an execution starts the next probe.
- `reset()` forces closed and clears generation counters.
- `forceOpen()` opens/restarts cooldown and clears generation counters.
- Already-running operations are not cancelled by either control method.

Transitions create a generation boundary. Calls from an older generation still resolve/reject normally but cannot close/reopen or otherwise mutate the new generation's counters. ActiveCalls tracks all in-flight operations, including old generations; activeProbes tracks the current half-open generation.

## Error behavior

`CircuitOpenError` includes `retryAt`; `ProbeLimitError` indicates half-open capacity exhaustion. Neither counts as a service failure because the operation was never invoked.

An invalid classifier return or thrown classifier error is explicit: the call throws AggregateError containing the original failure and classifier error, and the failure is conservatively counted. Other operation errors preserve identity. Invalid configuration throws TypeError/RangeError.

Clock results must be finite. Backward movement is clamped to the last observed clock value. A forward jump can expire cooldown immediately; use a monotonic injected clock if wall-clock changes are inappropriate. Clock/overflow errors propagate and can replace a service error while updating circuit state; configure a reliable clock.

## Customization and limitations

```js
const breaker = createCircuitBreaker({
  isFailure: (error) => !(error instanceof TypeError),
  maxProbes: 2,
  successThreshold: 2,
});
```

Use one instance per isolated upstream/failure domain. Do not mix unrelated tenants/services unless intentionally sharing their health state.

This package does not provide retries, timeouts, rate limits, a closed-state concurrency limit, HTTP adapters, persistence or cross-process coordination. It schedules no timers/listeners and needs no disposer. Calls that never settle remain active; provide AbortSignal/timeouts through the actual operation. Retrying side effects requires idempotency.

The initial-release implementation is independently authored. Tests use an injected clock and deferred operations to verify exact boundaries and races, not live upstream reliability or distributed guarantees.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
