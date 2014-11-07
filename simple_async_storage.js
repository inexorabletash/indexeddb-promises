// Minimal async key/value store. For simplicity, it doesn't keep a connection open.

function SimpleStorage(name) {
  this.name = name;
}

SimpleStorage.prototype = {
  _open: function() {
    var r = indexedDB.open(this.name);
    r.upgradeneeded = function(e) { e.target.result.createObjectStore('store'); };
    return r.promise();
  },

  get: function(key) {
    return this._open().then(function(db) {
      return db.tx('store').objectStore('store').get(key);
    });
  },

  set: function(key, value) {
    return this._open().then(function(db) {
      return db.tx('store', 'readwrite').objectStore('store').put(value, key);
    });
  }
};
