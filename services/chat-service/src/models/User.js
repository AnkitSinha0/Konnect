const mongoose = require('mongoose');

const userStubSchema = new mongoose.Schema({
  name: String,
  username: String,
  email: String,
  avatar: String,
}, {
  collection: 'users',
  strict: false
});

// Users are stored in the auth service's default MongoDB database
// (same Atlas cluster, but without a /konnect-chat database path)
// We need a separate connection so populate() can find them.
const chatMongoUri = process.env.MONGO_URI || '';
const authMongoUri = chatMongoUri.replace(/\/konnect-chat(\?|$)/, '/$1');

const authConn = mongoose.createConnection(authMongoUri);
authConn.on('error', (err) => console.error('User auth-db connection error:', err));
authConn.once('open', () => console.log('✅ User model connected to auth database'));

module.exports = authConn.model('User', userStubSchema);
