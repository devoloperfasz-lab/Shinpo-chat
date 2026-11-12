const crypto = require('crypto');
const pw = process.argv[2];
if (!pw) { console.error('Pemakaian: npm run admin-hash -- "kata-sandi"'); process.exit(1); }
const salt = crypto.randomBytes(16);
console.log(salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'));
