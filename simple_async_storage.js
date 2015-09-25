// Minimal async key/value store

function SimpleStorage(name) {
  var open = indexedDB.open(this.name);
  open.upgradeneeded = function(e) { e.target.result.createObjectStore('store'); };
  this.dbp = open.promise;
}

SimpleStorage.prototype = {
  get: function(key) {
    return this.dbp.then(function(db) {
      return db.transaction('store').objectStore('store').get(key).promise;
    });
  },

  set: function(key, value) {
    return this.dbp.then(function(db) {
      var tx = db.transaction('store', 'readwrite');
      tx.objectStore('store').put(value, key);
      return tx.complete;
    });
  }

  // has(), remove(), and clear() are left as an exercise for the reader.
};
