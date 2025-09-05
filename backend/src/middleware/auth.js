module.exports = function auth(req, res, next) {
  const required = process.env.AUTH_TOKEN;
  if (!required) {
    // If not configured, deny by default to avoid exposing APIs unintentionally
    return res.status(500).json({ message: 'Server auth not configured' });
  }
  const header = req.headers['authorization'] || '';
  const [, token] = header.split(' ');
  if (token && token === required) return next();
  return res.status(401).json({ message: 'Unauthorized' });
};

