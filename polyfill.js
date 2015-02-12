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
  // Hack around this by running a constant series of (battery
  // draining) dummy requests against an arbitrary store and
  // maintaining a custom request queue if the transaction is
  // in a Promise-friendly "waiting" state

  // Implementation Details
  // ----------------------
  // * Every IDBTransaction instance is augmented with _promise
  //   that resolves/rejects on complete/abort.
  //
  // * Every IDBRequest instance should be augmented with _promise
  //   that resolves on the first success/error event on the request.
  //
  // * Every IDBCursor instance should be augmented with _request that
  //   holds the associated IDBRequest.

  // TODO/Known Issues
  // -----------------
  // * IDBOpenDBRequest is not augmented, so database open/upgrade/delete
  //   don't get promise wrappers.
  // * Polyfilled methods will fail for 'versionchange' transactions
  //   if there are no object stores (e.g. in a brand new database).
  // * When making calls on a 'waiting' transaction, exceptions from
  //   invalid arguments are not handled.
  // * Non-waited transactions never report state as 'committing'
  // * Behavior when a waiting promise rejects is not clearly defined.
  // * IDBCursor helpers (e.g. 'forEach') are not implemented

  // --------------------------------------------

  // Save a non-hooked copy, for probing/spinning the transaction.
  var $IDBObjectStore_prototype_get = IDBObjectStore.prototype.get;

  // --------------------------------------------

  var $IDBDatabase_prototype_transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(scope, mode) {
    var tx = $IDBDatabase_prototype_transaction.apply(this, arguments);

    if (!Array.isArray(scope))
      scope = [String(scope)];
    else
      scope = String(scope);

    // If waitUntil() is not used:
    //   state will be 'maybeActive' -> 'finished'
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
    var scope = tx.mode === 'versionchange'
          ? tx.db.objectStoreNames : tx._scope;
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

      scope: {
        get: function() {
          return this._scope;
        }
      },

      waitUntil: {
        value: function(p) {
          var $this = this;
          if (this.state === 'committing' || this.state === 'finished')
            return Promise.reject(
              makeDOMException(
                'InvalidStateError',
                'The transaction is already committing or finished.'));

          if (this._state === 'waiting') {
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

      promise: {
        value: function() {
          return Promise.resolve(this._promise);
        }
      },

      then: {
        value: function(onFulfilled, onRejected) {
          return this._promise.then(onFulfilled, onRejected);
        }
      },

      catch: {
        value: function(onRejected) {
          return this._promise.catch(onRejected);
        }
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

    // New Methods
    promise: function() {
      if (this._request)
        return this._request.promise.apply(this._request, arguments);
      return Promise.resolve(this._promise);
    },
    then: function(onFulfilled, onRejected) {
      if (this._request)
        return this._request.then.apply(this._request, arguments);
      return this.promise().then(onFulfilled, onRejected);
    },
    catch: function(onRejected) {
      if (this._request)
        return this._request.catch.apply(this._request, arguments);
      return this.promise().catch(onRejected);
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
    [IDBObjectStore, ['put', 'add', 'delete', 'get', 'clear', 'count']],
    [IDBIndex, ['get', 'getKey', 'count']],
    [IDBCursor, ['update', 'delete']]
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

        return request;
      };
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
        request._promise.then(function(cursor) {
          if (!cursor) return;
          cursor._request = request;
        });

        return request;
      };
    });
  });

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

        if (tx.state !== 'waiting') {
          method.apply(this, arguments);
        } else {
          tx._queue.push(function() {
            // TODO: Handle exceptions due to bad arguments
            // (in a real implementation those would be synchronous)
            method.apply($this, $arguments);
          });
        }

        return new Promise(function(resolve, reject) {
          $this._request.addEventListener('success', function handler(e) {
            e.target.removeEventListener('success', handler);
            resolve(e.target.result);
          });
        });
      };
    });
  });

  // IDBRequest convenience methods: promise(), then(), catch()
  // These use _promise which will only resolve on the first success/error.
  Object.defineProperties(
    IDBRequest.prototype, {
      promise: {
        value: function() {
          if (!this._promise) throw Error('unhooked request');
          return Promise.resolve(this._promise);
        }
      },
      then: {
        value: function(onFulfilled, onRejected) {
          if (!this._promise) throw Error('unhooked request');
          return this._promise.then(onFulfilled, onRejected);
        }
      },
      catch: {
        value: function(onRejected) {
          if (!this._promise) throw Error('unhooked request');
          return this._promise.catch(onRejected);
        }
      }
    });

}(this));
