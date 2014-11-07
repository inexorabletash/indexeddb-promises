// If you want explicit control over the lifetime of the transaction:

IDBDatabase.prototype.explicitCommitTransaction = function() {
  var resolveP;
  var p = new Promise(function(resolve) {
    resolveP = resolve;
  });
  var tx = this.transaction.apply(this, arguments);
  tx.commit = function() {
    resolveP();
  };
  tx.waitUntil(p);
  return tx;
};

var tx = db.explicitCommitTransaction('store', 'readwrite');
// tx will wait indefinitely until the following call is made: 
tx.commit();
