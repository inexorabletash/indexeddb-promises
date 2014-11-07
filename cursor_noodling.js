// Sample, assuming continue() returns Promise<IDBCursor?>

// Without the waitUntil() calls the tx will commit eagerly.

tx.waitUntil(store.openCursor(range).then(iterate));

function iterate(cursor) {
  if (!cursor)
    return;

  console.log(cursor.key, cursor.primaryKey, cursor.value);
  tx.waitUntil(cursor.continue().then(iterate));
}


