## Indexed DB + Promises #3 ##

Further thinking about what a Promise-friendly version of IDB could look like.

> STATUS: Serious proposal, but may want to solve [pan-storage transactions](https://gist.github.com/inexorabletash/a53c6add9fbc8b9b1191) first. Actively soliciting feedback.

See also:

* https://github.com/slightlyoff/Promises/tree/master/historical_interest/reworked_APIs/IndexedDB - by @slightlyoff
* [Earlier thoughts #1](https://gist.github.com/inexorabletash/8791448)
* [Earlier thoughts #2](https://gist.github.com/inexorabletash/9675881)

### The Problem ###

Indexed DB transactions compose poorly with Promises.

[Transactions](https://dvcs.w3.org/hg/IndexedDB/raw-file/tip/Overview.html#transaction-concept) are defined as having an *active* flag that is set when the transaction is created, and when an IDB event callback from a source associated with that transaction is run. The *active* flag is cleared when the task completes i.e. when control returns from script; for example, at the end of the callback. Operations within a transaction (put, get, etc) are only permitted when the flag is true. This implies that you cannot perform operations within a Promise callback, since it is by definition not an IDB event callback. Further, transactions automatically attempt to commit when the flag is cleared and there are no pending requests. This implies that even if the previous restriction was lifted, the transaction would commit before any Promise callback fired. If the *active* flag mechanism were to be removed entirely, a new commit model would need to be introduced.

### The Proposal ###

Here's a possible incremental evolution of the IDB API to interoperate with promises. It can be summarized as three separate but complementary additions to the API:

* Improve integration with other Promise-based code by adding a `.ready` affordance to `IDBRequest` and a similar `.complete` affordance to `IDBTransaction`
* Extend the transaction lifecycle model by allowing a transaction to _wait_ on a Promise
* Have cursor iteration methods return the associated request, to allow easier Promise-based iteration.

### Transactions ###

```webidl
enum IDBTransactionState {  "active", "inactive", "waiting", "committing", "finished" };

partial interface IDBTransaction {
  readonly attribute IDBTransactionState state;
  readonly attribute Promise<void> complete;

  Promise<void> waitUntil(Promise<any> p);
};
```

The `complete` attribute is a convenience to allow IDBTransaction objects to be used in Promise chains. It is roughly equivalent to:

```js
Object.defineProperty(IDBTransaction.prototype, 'complete', {get: function() {
  var tx = this;
  if (tx._promise) return tx._promise;
  return tx._promise = new Promise(function(resolve, reject) {
    if (tx.state === 'finished') {
      if (tx.error)
        reject(tx.error);
      else
        resolve();
    } else {
      tx.addEventListener('complete', function() { resolve(); });
      tx.addEventListener('abort', function() { reject(tx.error); });
    }
  });
}, enumerable: true, configurable: true});
```
Example:
```js
// ES2015:
var tx = db.transaction('my_store', 'readwrite');
// ...
tx.complete
  .then(function() { console.log('committed'); })
  .catch(function(ex) { console.log('aborted: ' + ex.message); });

// ES2016:
let tx = db.transaction('my_store', 'readwrite');
// ...
try {
  await tx.complete;
  console.log('committed');
} catch (ex) {
  console.log('aborted: ' + ex.message);
}
```

The `complete` attribute returns the same Promise instance each time it is accessed.


Transactions grow a `waitUntil()` method similar to [ExtendableEvent](https://slightlyoff.github.io/ServiceWorker/spec/service_worker/index.html#extendable-event), and have a associated set of **extend lifetime promises**.

The transaction's *active* flag is replaced by a *state* which can be one of: "active", "inactive", "waiting", "committing", and "finished".

* When a transaction is created by `transaction()` the *state* is "active". When control
  returns to the event loop, it is set to "inactive"
* When a "success" or "error" event is to be dispatched at an `IDBRequest` associated with the
  transaction, *state* is set to "active" before dispatch and set to "inactive" after
  dispatch.
* If *state* is "active" at the end of a task then *state* is set to "inactive".
* When *state* becomes "inactive", if there are no pending requests, *state* is set to
  "committing"  and the transaction attempts to commit.
* When the transaction successfully commits or aborts, *state* is set to "finished".

*NB: The above matches the behavior of IDB "v1".*

When __waitUntil(*p*)__ is called, the following steps are performed:

1. If *state* is "inactive", "committing" or "finished", a new Promise rejected `DOMException` of type "InvalidStateError" is returned.
3. Otherwise, *state* is set to "waiting", and `p` is added to the transaction's set of **extend lifetime promises**. (The transaction now _waits_ on the Promise `p`.)
4. Return the same Promise instance returned by the `complete` attribute.

The transaction lifecycle is extended with:
* If *state* is "waiting" and any promise in the transaction's **extend lifetime promises** rejects, the transaction aborts.
* If *state* is "waiting", then once all of the promises in the transaction's **extend lifetime promises** fulfill, the *state* is set to "committing" and the transaction attempts to commit.
* An explicit `abort()` call still also aborts the transaction immediately, and the promise resolution is ignored.

The `state` attribute reflects the internal *state* of the transaction. *NB: Previously the internal active flag's state could be probed by attempting a `get()` call on one of the stores in the transaction's scope, but it was not exposed as an attribute.*

### Requests ###

```webidl
partial interface IDBRequest {
  readonly attribute Promise<any> ready;
};
```

The `ready` attribute is a convenience to allow IDBRequest objects to be used in Promise chains. It is roughly equivalent to:

```js
Object.prototype.defineProperty(IDBRequest.prototype, 'ready', {get: {
  var rq = this
  if (rq._promise) return rq._promise;
  return rq._promise = new Promise(function(resolve, reject) {
    if (rq.readyState === 'done') {
      if (rq.error)
        reject(request.error);
      else
        resolve(request.result);
    } else {
      rq.addEventListener('success', function() { resolve(rq.result); });
      rq.addEventListener('error', function() { reject(rq.error); });
    }
  });
}, enumerable: true, configurable: true});
```

The `ready` attribute returns the same Promise instance each time it is accessed, unless the readyState of the request is reset by iterating a cursor associated with the request (see below). Once that occurs, the `ready` attribute returns a new Promise instance, but again the same Promise instance each time, until the cursor is iterated once more.

> The above shim does NOT cover the cursor iteration cases; see [polyfill.js](polyfill.js) for a more complete approximation.

Example:
```js
// ES2015
var tx = db.transaction('my_store');
tx.objectStore('my_store').get(key).ready
  .then(function(result) { console.log('got: ' + result); });

// ES2016:
let tx = db.transaction('my_store');
let result = await tx.objectStore('my_store').get(key).ready;
console.log('got: ' + result);
```

### Advanced Usage ###

Multiple database operations can be chained as long as control does not return to the event loop. For example:

```js
// ES2016:
async function increment(store, key) {
  let tx = db.transaction(store, 'readwrite');
  let value = await tx.objectStore(store).get(key).ready;
  // in follow-on microtask, but control hasn't returned to event loop
  await tx.objectStore(store).put(value + 1).ready;
  await tx.complete; // Ensure it commits
}
```

Note that accessing they a request's `ready` does not implicitly cause the transaction to wait until the returned promise is resolved, as that would not help in the following scenario. Assume this helper:

```js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

This would fail:

```js
async function incrementSlowlyBROKEN(store, key) {
  let tx = db.transaction(store, 'readwrite');
  let value = await tx.objectStore(store).get(key).ready;
  // in follow-on microtask...
  await sleep(500);
  // but here, control returns to the event loop, so
  // the transaction will auto-commit and this
  // next call will fail:
  await tx.objectStore(store).put(value + 1).ready;
  await tx.complete;
}
```
At the point where the `sleep()` call is made the the associated transaction would commit as there is no further work. Instead, this "immediately invoked async function expression" structure must be used:

```js
async function incrementSlowly(store, key) {
  let tx = db.transaction(store, 'readwrite');
  tx.waitUntil((async function() {
    let value = await tx.objectStore(store).get(key).ready;
    await sleep(500);
    await tx.objectStore(store).put(value + 1).ready;
  }()));
  await tx.complete;
}
```

> Is "IIAFE" is a thing now? If so, I propose we pronounce it "yah-fee"

### Cursors ###

The requests returned when opening cursors behave differently than most requests: the `success` event can fire repeatedly. Initially when the cursor is returned, and then on each iteration of the cursor. A Promise only returns one value, but just as the `readyState` is reset when a cursor is iterated the `ready` is as well - a new Promise is used for each iteration step.

```
partial interface IDBCursor {
  IDBRequest advance([EnforceRange] unsigned long count);
  IDBRequest continue(optional any key);
};
```

As a convenience, cursor iteration methods (`continue()` and `advance()`) now return `IDBRequest`. *NB: Previously they were void methods, so this is backwards-compatible.* This is the same `IDBRequest` instance returned when the cursor is opened. The behavior with event-based iteration is exactly the same, but a new Promise is used.

```js
var rq_open = store.openCursor();
var p1 = rq_open.ready;
rq_open.ready.then(function(cursor) {
  assert(rq_open.ready === p1);
  assert(rq_open.readyState === "done");

  var rq_continue = cursor.continue();

  assert(rq_continue === rq_open);
  assert(rq_open.ready !== p1);
  assert(rq_open.readyState === "pending");
});
```

Here's how you'd fetch all keys in a range using a cursor:
```js
// ES2015:
function getAll(store, query) {
  var result = [];
  return store.openCursor(query).ready.then(function iter(cursor) {
    if (!cursor) return result;
    result.push(cursor.value);
    return cursor.continue().ready.then(iter);
  });
}

// ES2016:
async function getAll(store, query) {
  let result = [];
  let cursor = await store.openCursor(query).ready;
  while (cursor) {
    result.push(cursor.value);
    cursor = await cursor.continue().ready;
  }
  return result;
}
```

### Concerns ###

* With the `waitUntil()` mechanism it is possible to create transactions that will never complete, e.g. `waitUntil(new Promise())`. This introduces the possibility of deadlocks. But this is possible today with "busy waiting" transactions - in fact, locking primitives like Mutexes can already be created using IDB. See https://gist.github.com/inexorabletash/fbb4735a2e6e8c115a7e

* Methods that return requests still throw rather than reject on invalid input, so you must still use try/catch blocks. Fortunately, with ES2016 async/await syntax, asynchronous errors can also be handled by try/catch blocks.


### Thanks ###

Thanks to Alex Russell, Jake Archibald, Domenic Denicola, Marcos Caceres, and Daniel Murphy for guidance and feedback.
