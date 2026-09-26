// Run by mongosh after the standard image has initialized root/app users.
db.getSiblingDB('admin').auth(
  process.env.MONGO_INITDB_ROOT_USERNAME,
  process.env.MONGO_INITDB_ROOT_PASSWORD,
);
try {
  rs.status();
} catch (error) {
  if (error.code !== 94) throw error; // Only NotYetInitialized permits initiation.
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] });
}
quit(db.hello().isWritablePrimary ? 0 : 2);
