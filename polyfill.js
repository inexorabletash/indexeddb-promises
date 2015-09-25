(function(global){

  // Asynchronous Requests
  // ---------------------
  // This is a terrible horrible, no good, very bad hack.
  //
  // Promise delivery is async, which means the result of e.g. a get()
  // request is delivered outside the transaction callback; in IDB
  // spec parlance, the transaction is not "active", and so additional
  // requests fail and the transaction may already have committed due
  // to a lack of additional requests.
  //
  // When a transaction is waiting on a Promise, a custom queue of
  // requests is maintained and a series of (battery draining) dummy
  // requests against an arbitrary store is made. When the underlying
  // transaction is active during the responses, the queue of real
  // requests is processed. When the waiting Promise resolves, the
  // dummy request spinning stops and the transaction is allowed
  // to auto-commit.

  // Implementation Details
  // ----------------------
  // * Every IDBTransaction instance is augmented with _promise
  //   that resolves/rejects on complete/abort.
  //
  // * Every IDBRequest instance should be augmented with _promise
  //   that resolves on the first success/error event on the request.
  //
  // * Every IDBCursor instance is augmented with _request that holds
  //   the associated IDBRequest. This is used when continue() or
  //   advance() is called, so that the original request's next event
  //   can resolve a returned Promise.

  // TODO/Known Issues
  // -----------------
  //
  // * IDBFactory methods and IDBOpenDBRequest are not augmented, so
  //   database open/upgrade/delete don't get promise wrappers.
  //
  // * Polyfilled methods will fail for 'versionchange' transactions
  //   if there are no object stores (e.g. in a brand new database).
  //
  // * When making calls on a 'waiting' transaction, exceptions from
  //   invalid arguments are not handled.
  //
  // * Non-waited transactions never report state as 'committing'
  //
  // * Behavior when a waiting promise rejects is not clearly defined.
  //
  // * IDBCursor helpers (e.g. 'forEach') are not implemented

  // --------------------------------------------

  // Save a non-hooked copy, for probing/spinning the transaction.
  var $IDBObjectStore_prototype_get = IDBObjectStore.prototype.get;

  // --------------------------------------------

  var $IDBDatabase_prototype_transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(scope, mode) {
    var tx = $IDBDatabase_prototype_transaction.apply(this, arguments);

    if (!Array.isArray(scope))
      scope = [String(scope)]; // TODO: sort, unique
    else
      scope = String(scope);

    // If waitUntil() is not used:
    //   state will be 'maybeActive' -> 'finished'
    //   (should include 'committing' but can't polyfill that)
    // Once waitUntil() is called:
    //   state will be 'waiting' -> 'committing' -> 'finished'
    tx._state = 'maybeActive';
    tx._scope = scope;

    tx._waitingPromise = null;
    tx._waitingIndex = 0;
    tx._queue = null;

    tx._promise = new Promise(function(resolve, reject) {
      tx.addEventListener('complete', function() {
        tx._state = 'finished';
        resolve();
      });
      tx.addEventListener('abort', function() {
        tx._state = 'finished';
        reject(tx.error);
      });
    });
    window.t = tx;
    window.p = tx._promise;

    return tx;
  };

  function getStore(tx) {
    var scope = tx.objectStoreNames;
    if (scope.length)
      return tx.objectStore(scope[0]);

    // TODO: Handle versionchange where there are no stores yet
    throw new Error('No object stores');
  }

  Object.defineProperties(
    IDBTransaction.prototype, {
      state: {
        get: function() {
          if (this._state === 'maybeActive') {
            // TODO: This doesn't capture 'committing'
            try {
              $IDBObjectStore_prototype_get.call(getStore(this), -Infinity);
              return 'active';
            } catch (_) {
              return 'inactive';
            }
          }
          // Will be 'waiting', committing', or 'finished'
          return this._state;
        }
      },

      objectStoreNames: {
        get: function() {
          if (this.mode === 'versionchange')
            return this.db.objectStoreNames;
          else
            return this._scope;
        }
      },

      waitUntil: {
        value: function(p) {
          var $this = this;
          var state = this.state;

          if (state === 'inactive') {
            // Throw or Reject?
            return Promise.reject(makeDOMException(
              'InvalidStateError', 'The transaction is inactive.'));
          }

          if (state === 'committing') {
            return Promise.reject(makeDOMException(
              'InvalidStateError', 'The transaction is already committing.'));
          }

          if (state === 'finished') {
            return Promise.reject(makeDOMException(
              'InvalidStateError', 'The transaction is finished.'));
          }

          if (state === 'waiting') {
            // Already waiting on q, now wait on q.then(() => p)
            p = this._waitingPromise.then(function() { return p; });
          } else {
            // Newly waiting: start spinning
            this._state = 'waiting';
            this._queue = [];
            var store = getStore(this);
            (function spin(){
              while ($this._queue.length)
                ($this._queue.shift())();
              if ($this._state === 'waiting') {
                $IDBObjectStore_prototype_get.call(store, -Infinity)
                  .onsuccess = spin;
              }
            }());
          }

          var index = ++this._waitingIndex;
          this._waitingPromise = p;
          this._waitingPromise.then(function() {
            // Ignore if we were replaced.
            if (index !== $this._waitingIndex) return;
            // Stop spinning, allow auto-commit to proceed.
            $this._state = 'committing';
          });
          this._waitingPromise.catch(function() {
            // Ignore if we were replaced.
            if (index !== $this._waitingIndex) return;
            // TODO: Abort if any waiting promise rejects?
            try { $this.abort(); } catch(_) {}
          });

          return Promise.resolve(this._waitingPromise);
        }
      },

      complete: {
        get: function() {
          return this._promise;
        }, enumerable: true, configurable: true
      }
    });

  // Rough approximation
  function makeDOMException(name, message) {
    var e = Error(message);
    e.name = name;
    return e;
  }

  // Proxy for IDBRequest that can be returned by calls made
  // while the underlying transaction is inactive.
  function IDBRequestProxy(source, transaction) {
    this._source = source;
    this._transaction = transaction;
    this._request = null;
    this._onsuccess = null;
    this._onerror = null;
    this._handlers = [];
    this._resolvers = [];
  }
  IDBRequestProxy.prototype = {
    // IDBRequest
    get result() {
      if (this._request) return this._request.result;
      throw makeDOMException('InvalidStateError', 'The request is not ready.');
    },
    get error() {
      if (this._request) return this._request.error;
      throw makeDOMException('InvalidStateError', 'The request is not ready.');
    },
    get source() {
      return this._source;
    },
    get transaction() {
      return this._transaction;
    },
    get readyState() {
      if (this._request) return this._request.readyState;
      return 'pending';
    },

    // EventTarget
    get onsuccess() {
      if (this._request) return this._request.onsuccess;
      return this._onsuccess;
    },
    get onerror() {
      if (this._request) return this._request.onerror;
      return this._onerror;
    },
    addEventListener: function(type, listener /*, useCapture*/) {
      if (this._request)
        return this._request.addEventListener.apply(this._request, arguments);
      var $arguments = arguments;
      this._handlers.push(function(r) {
        r.addEventListener.apply(r, $arguments);
      });
      return undefined;
    },
    removeEventListener: function(type, listener /*, useCapture*/) {
      if (this._request)
        return this._request.removeEventListener.apply(this._request, arguments);
      var $arguments = arguments;
      this._handlers.push(function(r) {
        r.removeEventListener.apply(r, $arguments);
      });
      return undefined;
    },

    get promise() {
      if (this._request)
        return this._request.promise;
      return this._promise;
    },

    // Called when the real IDBRequest is ready.
    _provide: function(request) {
      this._request = request;
      request._promise = this._promise;
      request.onsuccess = this._onsuccess;
      request.onerror = this._onerror;
      while (this._handlers.length)
        (this._handlers.shift())(request);
      while (this._resolvers.length)
        (this._resolvers.shift())(request._promise);
    }
  };

  // Helper: IDBObjectStore or IDBIndex => IDBTransaction
  function transactionFor(source) {
    var store = ('objectStore' in source) ? source.objectStore : source;
    return store.transaction;
  }

  // Helper: create a Promise for an IDBRequest. Note that since
  // requests may fire more than once (e.g. for cursors) this applies
  // to the next event seen.
  function promiseForRequest(request) {
    return new Promise(function(resolve, reject) {
      request.addEventListener('success', function() {
        resolve(request.result);
      });
      request.addEventListener('error', function() {
        reject(request.error);
      });
    });
  }

  // Hook existing methods that return one-shot IDBRequests to enqueue
  // a job and return a proxy if the transaction is waiting.
  [
    [IDBObjectStore,
     ['put', 'add', 'delete', 'clear', 'get', 'getAll', 'getAllKeys', 'count']],
    [IDBIndex,
     ['get', 'getKey', 'getAll', 'getAllKeys', 'count']],
    [IDBCursor,
     ['update', 'delete']]
  ].forEach(function(typeAndMethods) {
    var type = typeAndMethods[0], methods = typeAndMethods[1];
    methods.forEach(function(methodName) {
      hook(type, methodName);
    });
  });


  // Hook existing methods that return IDBRequests that yield
  // IDBCursors, to associate the request with the cursor, and also
  // enqueue a job and return a proxy if the transaction is waiting.
  [
    [IDBObjectStore, ['openCursor', 'openKeyCursor']],
    [IDBIndex, ['openCursor', 'openKeyCursor']]
  ].forEach(function(typeAndMethods) {
    var type = typeAndMethods[0], methods = typeAndMethods[1];
    methods.forEach(function(methodName) {
      hook(type, methodName, true);
    });
  });

  function hook(type, methodName, hookCursor) {
    var method = type.prototype[methodName];
    if (!method) return;
    type.prototype[methodName] = function() {
      var $this = this, $arguments = arguments;
      var tx = transactionFor(this);

      var request;
      if (tx.state !== 'waiting') {
        request = method.apply(this, arguments);
      } else {
        var proxy = new IDBRequestProxy();
        tx._queue.push(function() {
          // TODO: Handle exceptions due to bad arguments
          // (in a real implementation those would be synchronous)
          var r = method.apply($this, $arguments);
          proxy._provide(r);
        });
        request = proxy;
      }

      request._promise = promiseForRequest(request);

      if (hookCursor) {
        request._promise.then(function(cursor) {
          if (!cursor) return;
          cursor._request = request;
        });
      }

      return request;
    };
  }

  [
    [IDBCursor, ['continue', 'advance']]
  ].forEach(function(typeAndMethods) {
    var type = typeAndMethods[0], methods = typeAndMethods[1];
    methods.forEach(function(methodName) {
      var method = type.prototype[methodName];
      if (!method) return;
      type.prototype[methodName] = function() {
        var $this = this, $arguments = arguments;
        var tx = transactionFor(this);

        var request;
        if (tx.state !== 'waiting') {
          method.apply(this, arguments);
          request = this._request;
        } else {
          var proxy = new IDBRequestProxy();
          tx._queue.push(function() {
            // TODO: Handle exceptions due to bad arguments
            // (in a real implementation those would be synchronous)
            method.apply($this, $arguments);
            proxy._provide($this._request);
          });
          request = proxy;
        }

        // Reset request's internal promise, just as request's
        // readyState is reset.
        request._promise = promiseForRequest(request);

        return request;
      };
    });
  });

  // IDBRequest convenience attribute: promise
  // These use _promise which will only resolve on the first success/error.
  Object.defineProperties(
    IDBRequest.prototype, {
      promise: {
        get: function() {
          if (!this._promise) throw Error('unhooked request');
          return this._promise;
        }, enumerable: true, configurable: true
      }
    });

}(this));
