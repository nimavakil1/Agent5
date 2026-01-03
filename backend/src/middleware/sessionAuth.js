const jwt = require('jsonwebtoken');

function readJwtFromCookies(req) {
  const token = req.cookies && (req.cookies['access_token'] || req.signedCookies?.['access_token']);
  return token || null;
}

function verifyJwt(token, logPath = null) {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  try {
    return jwt.verify(token, secret);
  } catch (err) {
    if (logPath && logPath.includes('chat')) {
      console.log('[SessionAuth JWT Error]', {
        path: logPath,
        error: err.message,
        tokenPreview: token ? `${token.substring(0, 20)}...` : null,
      });
    }
    return null;
  }
}

// Strict: requires a valid session
function requireSession(req, res, next) {
  const token = readJwtFromCookies(req);
  const isHtml = (req.headers.accept || '').includes('text/html') || /\.html($|\?)/.test(req.originalUrl || '');

  // Debug logging for chat routes
  if (req.path.includes('chat') || req.originalUrl.includes('chat')) {
    console.log('[SessionAuth Debug]', {
      path: req.path,
      originalUrl: req.originalUrl,
      hasToken: !!token,
      hasCookies: !!req.cookies,
      cookieKeys: req.cookies ? Object.keys(req.cookies) : [],
      hasAccessToken: !!(req.cookies && req.cookies['access_token']),
    });
  }

  if (!token) {
    if (isHtml) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const data = verifyJwt(token, req.originalUrl);
  if (!data) {
    if (isHtml) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.user = { id: data.sub, email: data.email, role: data.role };
  next();
}

// Combined guard: allow either bearer AUTH_TOKEN or session cookie
function allowBearerOrSession(req, res, next) {
  const required = process.env.AUTH_TOKEN;
  const header = (req.headers['authorization'] || '').trim();
  
  // Debug logging (temporary)
  console.log('Auth debug:', {
    required: required ? `${required.slice(0, 10)}...` : null,
    header: header ? `${header.slice(0, 20)}...` : null,
    hasBearer: header.toLowerCase().startsWith('bearer '),
    path: req.path
  });
  
  // Parse Bearer token more robustly
  if (header.toLowerCase().startsWith('bearer ')) {
    const bearer = header.substring(7).trim(); // Remove 'Bearer ' and trim whitespace
    console.log('Bearer token comparison:', {
      received: bearer ? `${bearer.slice(0, 10)}...` : null,
      matches: bearer === required
    });
    if (required && bearer && bearer === required) return next();
  }
  
  // Fallback to session cookie
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
