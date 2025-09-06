const jwt = require('jsonwebtoken');

function readJwtFromCookies(req) {
  const token = req.cookies && (req.cookies['access_token'] || req.signedCookies?.['access_token']);
  return token || null;
}

function verifyJwt(token) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  try {
    return jwt.verify(token, secret);
  } catch (_) {
    return null;
  }
}

// Strict: requires a valid session
function requireSession(req, res, next) {
  const token = readJwtFromCookies(req);
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  const data = verifyJwt(token);
  if (!data) return res.status(401).json({ message: 'Unauthorized' });
  req.user = { id: data.sub, email: data.email, role: data.role };
  next();
}

// Combined guard: allow either bearer AUTH_TOKEN or session cookie
function allowBearerOrSession(req, res, next) {
  const required = process.env.AUTH_TOKEN;
  const header = req.headers['authorization'] || '';
  const [, bearer] = header.split(' ');
  if (required && bearer && bearer === required) return next();
  const token = readJwtFromCookies(req);
  if (token) {
    const data = verifyJwt(token);
    if (data) {
      req.user = { id: data.sub, email: data.email, role: data.role };
      return next();
    }
  }
  return res.status(401).json({ message: 'Unauthorized' });
}

module.exports = { requireSession, allowBearerOrSession };

