## Indexed DB + Promises #3 ##

Further thinking about what a Promise-friendly version of IDB could look like.

> STATUS: Serious proposal, but may want to solve pan-storage transactions first. Actively soliciting feedback.

See also:

* https://github.com/slightlyoff/Promises/tree/master/historical_interest/reworked_APIs/IndexedDB - by @slightlyoff
* [Earlier thoughts #1](https://gist.github.com/inexorabletash/8791448)
* [Earlier thoughts #2](https://gist.github.com/inexorabletash/9675881)

### The Problem ###

Indexed DB transactions compose poorly with Promises.

[Transactions](https://dvcs.w3.org/hg/IndexedDB/raw-file/tip/Overview.html#transaction-concept) are defined as having an *active* flag that is set when the transaction is created, and when an IDB event callback from a source associated with that transaction is run. The *active* flag is cleared when the task completes i.e. when control returns from script; for example, at the end of the callback. Operations within a transaction (put, get, etc) are only permitted when the flag is true. This implies that you cannot perform operations within a Promise callback, since it is by definition not an IDB event callback. Further, transactions automatically attempt to commit when the flag is cleared and there are no pending requests. This implies that even if the previous restriction was lifted, the transaction would commit before any Promise callback fired. If the *active* flag mechanism were to be removed entirely, a new commit model would need to be introduced.

Here's a possible incremental evolution of the IDB API to interoperate with promises. It can be summarized as two separate but complementary additions to the API:

* Improve integration with other Promise-based code by adding a `.promise` affordance to `IDBRequest` and a similar `.complete` affordance to `IDBTransaction`
* Extend the transaction lifecycle model by allowing a transaction to _wait_ on a Promise

### Transactions ###

```webidl
enum IDBTransactionState {  "active", "inactive", "waiting", "committing", "finished" };

partial interface IDBTransaction {
  readonly attribute IDBTransactionState state;
  readonly attribute DOMString[] objectStoreNames; // implemented in FF
  readonly attribute Promise<any> complete;

  Promise<any> waitUntil(Promise<any> p);
};
```

The `complete` attribute is a convenience to allow IDBTransaction objects to be used in Promise chains. It is roughly equivalent to:

```js
Object.defineProperty(IDBTransaction.prototype, 'complete', {get: function() {
  var tx = this;
  return new Promise(function(resolve, reject) {
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
var tx = db.transaction('my_store', 'readwrite');
// ...
tx.complete
  .then(function() { console.log('committed'); })
  .catch(function(ex) { console.log('aborted: ' + ex.message); });
```

Example (with proposed ES7 syntax extensions, assuming async context):
```js
let tx = db.transaction('my_store', 'readwrite');
// ...
try {
  await tx;
  console.log('committed');
} catch (ex) {
  console.log('aborted: ' + ex.message);
}
```

Transactions grow a `waitUntil()` method similar to [ExtendableEvent](https://slightlyoff.github.io/ServiceWorker/spec/service_worker/index.html#extendable-event).

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

* If `waitUntil(p)` is called and *state* is "committing" or "finished", a new Promise rejected with `TypeError` is returned.
* Otherwise, *state* is set to "waiting". The transaction now _waits_ on the Promise `p`.
* If `p` rejects, the transaction aborts.
* If `p` fulfills, the *state* is set to "committing" and the transaction attempts to commit.
* An explicit `abort()` call still also aborts the transaction immediately, and the promise resolution is ignored.

If a transaction is already waiting on Promise `p` and `waitUntil(q)` is called, then the transaction should instead wait on a new Promise equivalent to `p.then(() => q)`.

> ISSUE: Return value of waitUntil()? Options include (1) a Promise dependent on the promise the transaction is waiting on (2) just whatever is passed in (3) `undefined`?*

The `state` attribute reflects the internal *state* of the transaction. *NB: Previously the internal active flag's state could be probed by attempting a `get()` call on one of the stores in the transaction's scope, but it was not exposed as an attribute.*

The `objectStoreNames` attribute reflects the list of names of object stores in the transaction's *scope*, in sorted order. For "versionchange" transactions this is the same as that returned by the `IDBDatabase`'s `objectStoreNames` attribute. *NB: This is provided as a convenience; previously it was necessary for code to track this manually. Firefox already implements this, and it was added to the [V2 draft](https://w3c.github.io/IndexedDB/)*


> ISSUE: Add a timeout to transactions. Maybe make this mandatory if waitUntil() is used?

### Requests ###

```webidl
partial interface IDBRequest {
  readonly attribute Promise<any> promise;
};
```

The `promise` attribute is a convenience to allow IDBRequest objects to be used in Promise chains. It is roughly equivalent to:

```js
Object.prototype.defineProperty(IDBRequest.prototype, 'promise', {get: {
  var rq = this;
  return new Promise(function(resolve, reject) {
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

Example:
```js
var tx = db.transaction('my_store');
tx.objectStore('my_store').get(key).promise
  .then(function(result) { console.log('got: ' + result); });
```

ES7:
```js
let tx = db.transaction('my_store');
let result = await tx.objectStore('my_store').get(key).promise;
console.log('got: ' + result);
```

Multiple database operations can be chained as long as control does not return to the event loop. For example:

ES7:
```js
async function increment(store, key) {
  let tx = db.transaction(store, 'readwrite');
  let value = await tx.objectStore(store).get(key);
  // in follow-on microtask, but control hasn't returned to event loop
  await tx.objectStore(store).put(value + 1);
  await tx.complete; // Ensure it commits
}
```

Note that they do not implicitly cause the transaction to wait until the returned promise is resolved, as that would not help in the following scenario. Assume this helper:

```js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

This would fail:

```js
async function incrementSlowlyBROKEN(store, key) {
  let tx = db.transaction(store, 'readwrite');
  let value = await tx.objectStore(store).get(key);
  // in follow-on microtask...
  await sleep(500);
  // but here, control returns to the event loop, so
  // the transaction will auto-commit and this
  // next call will fail:
  await tx.objectStore(store).put(value + 1);  
  await tx.complete;
}
```
At the point where the `sleep()` call is made the the associated transaction would commit as there is no further work. Instead, this structure must be used:

```js
async function incrementSlowly(store, key) {
  let tx = db.transaction(store, 'readwrite');
  tx.waitUntil((async function() {
    let value = await tx.objectStore(store).get(key);
    await sleep(500);
    await tx.objectStore(store).put(value + 1);  
  }()));
  await tx.complete;
}
```

### Cursors ###

The requests returned when opening cursors behave differently than most requests: the `success` event can fire repeatedly. Initially when the cursor is returned, and then on each iteration of the cursor.

The IDBRequest member `promise()` as defined above already only captures the first success/error result, which for `openCursor()` and `openKeyCursor()` on IDBObjectStore and IDBIndex will effectively be `Promise<IDBCursor?>`. Further iterations are lost.

```
partial interface IDBCursor {
  Promise<IDBCursor?> advance([EnforceRange] unsigned long count);
  Promise<IDBCursor?> continue(optional any key);
};
```

The cursor iteration methods (`continue()` and `advance()`) now return `Promise<IDBCursor?>`. *NB: Previously they were void methods, so this is backwards-compatible.* The promise resolves with `null` if the iteration is complete, otherwise it is resolved with the same cursor object with the `key`, `primaryKey`, and `value` attributes will be updated as appropriate, just as with event-based iteration.

Here's how you'd fetch all keys in a range using a cursor:

```js
async function getAll(store, query) {
  let result = [];
  let cursor = await store.openCursor(query).promise;
  while (cursor) {
    result.push(cursor.value);
    cursor = await cursor.continue();
  }
  return result;
}
```

### Concerns ###

* With the `waitUntil()` mechanism it is possible to create transactions that will never complete, e.g. `waitUntil(new Promise())`. This introduces the possibility of deadlocks. But this is possible today with "busy waiting" transactions - in fact, locking primitives like Mutexes can already be created using IDB. See https://gist.github.com/inexorabletash/fbb4735a2e6e8c115a7e

* Methods that return requests still throw rather than reject on invalid input, so you must still use try/catch blocks. Fortunately, with ES7 async/await syntax, asynchronous errors can also be handled by try/catch blocks.
