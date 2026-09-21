const RAW_REFERENCE_FIELDS = new Set([
  'key',
  'path',
  'id',
  'target',
  'folder',
  'fullPrefix',
  'currentPath',
  'currentRoot',
  'nextQueryParam',
  'uploadUrl',
  'r2Url',
  'customUrl',
  'publicUrl'
]);

const getConfiguredHost = (value) => {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const getKnownR2Hosts = () => {
  const hosts = new Set(['assets.ps6.space', 'assets.samyao.me']);
  const configuredCustom = getConfiguredHost(process.env.R2_PUBLIC_DOMAIN);
  const configuredNative = getConfiguredHost(process.env.R2_NATIVE_PUBLIC_DOMAIN);

  if (configuredCustom) hosts.add(configuredCustom);
  if (configuredNative) hosts.add(configuredNative);

  return hosts;
};

export const getR2KeyFromReference = (value) => {
  if (typeof value !== 'string' || !value) return null;

  const trimmed = value.trim();
  if (/^uploads\/[\S]+$/.test(trimmed)) return trimmed;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const isKnownHost = getKnownR2Hosts().has(hostname) || hostname.endsWith('.r2.dev');
  if (!isKnownHost) return null;

  const key = parsed.pathname.replace(/^\/+/, '');
  return /^uploads\/[\S]+$/.test(key) ? key : null;
};

export const getR2DeliveryUrl = (key) => {
  if (!key) return null;

  const domain = (
    process.env.R2_PUBLIC_DOMAIN ||
    process.env.R2_NATIVE_PUBLIC_DOMAIN ||
    ''
  )
    .trim()
    .replace(/\/$/, '');

  return domain ? `${domain}/${key}` : key;
};

export const normalizeR2References = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeR2References(item));
  }

  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return getR2KeyFromReference(value) || value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => {
      if (RAW_REFERENCE_FIELDS.has(field)) return [field, item];
      return [field, normalizeR2References(item)];
    })
  );
};

export const hydrateR2References = (value, fieldName = '') => {
  if (Array.isArray(value)) {
    return value.map((item) => hydrateR2References(item, fieldName));
  }

  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string' || RAW_REFERENCE_FIELDS.has(fieldName)) return value;
    const key = getR2KeyFromReference(value);
    return key ? getR2DeliveryUrl(key) : value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => {
      if (RAW_REFERENCE_FIELDS.has(field)) return [field, item];
      return [field, hydrateR2References(item, field)];
    })
  );
};
