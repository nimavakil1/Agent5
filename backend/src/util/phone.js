function normalizeToE164(raw, defaultCountry = 'BE') {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.startsWith('+')) {
    return '+' + s.replace(/[^0-9]/g, '');
  }
  // very naive normalization: keep digits, prepend '+'
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return '';
  // If it starts with country trunk '00', treat as international
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  // If it starts with single 0 and defaultCountry is BE, assume 32
  if (defaultCountry === 'BE' && digits.startsWith('0')) {
    return '+32' + digits.slice(1);
  }
  // Fallback: just add '+'
  return '+' + digits;
}

module.exports = { normalizeToE164 };

