// Executed inside the ephemeral Compose container by mongosh, not by Node.
const appDatabaseName = process.env.MONGO_APP_DATABASE;
const appDatabase = db.getSiblingDB(appDatabaseName);
assert(appDatabase.auth(process.env.MONGO_APP_USERNAME, process.env.MONGO_APP_PASSWORD), 'App authentication failed');
const hello = appDatabase.runCommand({ hello: 1 });
assert.eq(hello.ok, 1, 'Mongo hello command failed');
assert.eq(hello.setName, 'rs0', 'Mongo must expose rs0');
assert.eq(hello.isWritablePrimary, true, 'Mongo must be writable');
const identity = appDatabase.runCommand({ connectionStatus: 1 });
assert.eq(identity.ok, 1, 'Mongo connectionStatus command failed');
assert.eq(identity.authInfo.authenticatedUsers.length, 1);
assert.eq(identity.authInfo.authenticatedUsers[0].user, process.env.MONGO_APP_USERNAME);
assert.eq(identity.authInfo.authenticatedUsers[0].db, appDatabaseName);

const collectionName = 'replica_transaction_smoke';
assert.eq(appDatabase.createCollection(collectionName).ok, 1, 'Mongo collection creation failed');
const outside = appDatabase.getCollection(collectionName);
const session = db.getMongo().startSession();
const inside = session.getDatabase(appDatabaseName).getCollection(collectionName);
try {
  session.startTransaction();
  assert(inside.insertOne({ _id: 'abort', quantity: 1 }).acknowledged);
  assert.eq(inside.countDocuments({ _id: 'abort' }), 1);
  assert.eq(outside.countDocuments({ _id: 'abort' }), 0, 'Uncommitted data leaked');
  session.abortTransaction();
  assert.eq(outside.countDocuments({ _id: 'abort' }), 0, 'Aborted write persisted');

  session.startTransaction();
  assert(inside.insertOne({ _id: 'commit', quantity: 1 }).acknowledged);
  session.commitTransaction();
  assert.eq(outside.countDocuments({ _id: 'commit' }), 1, 'Committed write missing');

  session.startTransaction();
  assert.eq(inside.updateOne({ _id: 'commit' }, { $inc: { quantity: -1 } }).modifiedCount, 1);
  assert(inside.insertOne({ _id: 'receipt', operation: 'consume' }).acknowledged);
  session.abortTransaction();
  assert.eq(outside.findOne({ _id: 'commit' }).quantity, 1, 'Abort partially consumed inventory');
  assert.eq(outside.countDocuments({ _id: 'receipt' }), 0, 'Abort retained operation receipt');
  print('Mongo app authentication, rs0, transaction isolation, abort and commit passed.');
} finally {
  session.endSession();
  outside.drop();
}
