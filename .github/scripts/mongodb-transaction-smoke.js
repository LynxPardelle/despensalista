// Executed inside the ephemeral Compose container by mongosh, not by Node.
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'Values differ'}: expected ${expected}, received ${actual}`);
  }
}

const appDatabaseName = process.env.MONGO_APP_DATABASE;
const appDatabase = db.getSiblingDB(appDatabaseName);
expect(appDatabase.auth(process.env.MONGO_APP_USERNAME, process.env.MONGO_APP_PASSWORD), 'App authentication failed');
const hello = appDatabase.runCommand({ hello: 1 });
expectEqual(hello.ok, 1, 'Mongo hello command failed');
expectEqual(hello.setName, 'rs0', 'Mongo must expose rs0');
expectEqual(hello.isWritablePrimary, true, 'Mongo must be writable');
const identity = appDatabase.runCommand({ connectionStatus: 1 });
expectEqual(identity.ok, 1, 'Mongo connectionStatus command failed');
expectEqual(identity.authInfo.authenticatedUsers.length, 1);
expectEqual(identity.authInfo.authenticatedUsers[0].user, process.env.MONGO_APP_USERNAME);
expectEqual(identity.authInfo.authenticatedUsers[0].db, appDatabaseName);

const collectionName = 'replica_transaction_smoke';
expectEqual(appDatabase.createCollection(collectionName).ok, 1, 'Mongo collection creation failed');
const outside = appDatabase.getCollection(collectionName);
const session = db.getMongo().startSession();
const inside = session.getDatabase(appDatabaseName).getCollection(collectionName);
try {
  session.startTransaction();
  expect(inside.insertOne({ _id: 'abort', quantity: 1 }).acknowledged, 'Abort fixture insert was not acknowledged');
  expectEqual(inside.countDocuments({ _id: 'abort' }), 1);
  expectEqual(outside.countDocuments({ _id: 'abort' }), 0, 'Uncommitted data leaked');
  session.abortTransaction();
  expectEqual(outside.countDocuments({ _id: 'abort' }), 0, 'Aborted write persisted');

  session.startTransaction();
  expect(inside.insertOne({ _id: 'commit', quantity: 1 }).acknowledged, 'Commit fixture insert was not acknowledged');
  session.commitTransaction();
  expectEqual(outside.countDocuments({ _id: 'commit' }), 1, 'Committed write missing');

  session.startTransaction();
  expectEqual(inside.updateOne({ _id: 'commit' }, { $inc: { quantity: -1 } }).modifiedCount, 1);
  expect(inside.insertOne({ _id: 'receipt', operation: 'consume' }).acknowledged, 'Receipt fixture insert was not acknowledged');
  session.abortTransaction();
  expectEqual(outside.findOne({ _id: 'commit' }).quantity, 1, 'Abort partially consumed inventory');
  expectEqual(outside.countDocuments({ _id: 'receipt' }), 0, 'Abort retained operation receipt');
  print('Mongo app authentication, rs0, transaction isolation, abort and commit passed.');
} finally {
  session.endSession();
  outside.drop();
}
