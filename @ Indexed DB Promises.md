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

Here's a possible incremental evolution of the IDB API to interoperate with promises.

### Transactions ###

```
callback SuccessCallback = void (any result);
callback ErrorCallback = void (DOMError error);

enum IDBTransactionState {  "active", "inactive", "waiting", "committing", "finished" };

partial interface IDBTransaction {
  readonly attribute IDBTransactionState state;
  readonly attribute DOMString[] objectStoreNames; // implemented in FF
  readonly attribute Promise<any> promise;

  Promise<any> waitUntil(Promise<any> p);
};
```

Transactions grow a `waitUntil()` method similar to [ExtendableEvent](https://slightlyoff.github.io/ServiceWorker/spec/service_worker/index.html#extendable-event).

The transaction's *active* flag is replaced by a *state* which can be one of: "active", "inactive", "waiting", "committing", and "finished". When a transaction is created the *state* is active. If *state* is "active" at the end of a task then *state* is set to "inactive". If *state* becomes "inactive" and there are no pending requests, *state* is set to "committing" and the transaction attempts to commit. If the transaction successfully commits or aborts, *state* is set to "finished". *NB: This matches the behavior of IDB "v1".*

If `waitUntil(p)` is called and *state* is "committing" or "finished", a new Promise rejected with `TypeError` is returned. Otherwise, *state* is set to "waiting". The transaction now waits on the Promise `p`; if `p` rejects, the transaction aborts. If `p` fulfills, the *state* is set to "committing" and the transaction attempts to commit. An explicit `abort()` call still also aborts the transaction immediately, and the promise resolution is ignored.

If a transaction is already waiting on Promise `p` and `waitUntil(q)` is called, then the transaction should instead wait on a new Promise equivalent to `p.then(() => q)`.

*TODO: Return value of waitUntil()? Options include (1) a Promise dependent on the promise the transaction is waiting on (2) just whatever is passed in (3) `undefined`?*

The `state` attribute reflects the internal *state* of the transaction. *NB: Previously the internal active flag's state could be probed by attempting a `get()` call on one of the stores in the transaction's scope, but it was not exposed as an attribute.*

The `objectStoreNames` attribute reflects the list of names of object stores in the transaction's *scope*, in sorted order. For "versionchange" transactions this is the same as that returned by the `IDBDatabase`'s `objectStoreNames` attribute. *NB: This is provided as a convenience; previously it was necessary for code to track this manually. Firefox already implements this.*

The `promise` attribute is a convenience to allow IDBTransaction objects to be used in Promise chains. It is equivalent to:

```js
Object.defineProperty(IDBTransaction.prototype, 'promise', {get: function() {
  var tx = this;
  return new Promise(function(resolve, reject) {
    if (tx.state === "finished") {
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

### Requests ###

```
partial interface IDBRequest {
  readonly attribute Promise<any> promise;
};
```

The `promise` attribute is a convenience to allow IDBRequest objects to be used in Promise chains. It is equivalent to:

```js
Object.prototype.defineProperty(IDBRequest.prototype, 'promise', {get: {
  var rq = this;
  return new Promise(function(resolve, reject) {
    if (rq.readyState === "done") {
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

Note that they do not implicitly cause the transaction to wait until the returned promise is resolved, as that would not help in the following scenario:

```js
// THIS WILL NOT WORK
var tx = db.transaction('store', 'readwrite');
var store = tx.objectStore('store');
store.get('key').promise
  .then(function(value) {
    return store.put(value + 1, 'key2');
  });
```

At the point where the `get()` request completes the associated transaction would commit as there is no further work. Instead, this structure must be used:

```js
var tx = db.transaction('store', 'readwrite');
var store = tx.objectStore('store');
tx.waitUntil(
  store.get('key').promise
    .then(function(value) {
      return store.put(value + 1, 'key2');
    })
);
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

The above is the *minimum* surface area we can expose for cursors. Adding async iterator support would be a huge benefit for developers, e.g. `store.openCursor(range).forEach(function(callback) { ... });`

### Concerns ###

* With the `waitUntil()` mechanism it is possible to create transactions that will never complete, e.g. `waitUntil(new Promise())`. This introduces the possibility of deadlocks. But this is possible today with "busy waiting" transactions - in fact, locking primitives like Mutexes can already be created using IDB. See https://gist.github.com/inexorabletash/fbb4735a2e6e8c115a7e

* Methods that return requests still throw rather than reject on invalid input, so you must still use try/catch blocks.

* TODO: Add a timeout to transactions. Maybe make this mandatory if waitUntil() is used?
