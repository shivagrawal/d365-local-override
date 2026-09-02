const BUNDLE = /\/bundle(?:\.min)?\.js$/i;

export function isDynamicsUrl(value) {
  try { return /(^|\.)crm\d*\.dynamics\.com$/i.test(new URL(value).hostname); }
  catch { return false; }
}

export function isCandidate(value, host, resourceType = 'pcf') {
  try {
    const url = new URL(value);
    if (url.hostname !== host) return false;
    if (resourceType === 'script') {
      return url.protocol === 'https:' && url.pathname !== '/' && !BUNDLE.test(url.pathname);
    }
    if (resourceType === 'html') {
      return url.protocol === 'https:' && /\/webresources\//i.test(url.pathname) && !BUNDLE.test(url.pathname);
    }
    return BUNDLE.test(url.pathname) && /webresources|controls|pcf/i.test(url.pathname);
  } catch { return false; }
}

export function normalizeResource(value) {
  const parts = new URL(value).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return `/${parts.map((part, index) => {
    const volatile = /^\{[^}]+\}$/.test(part) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(part);
    const controlName = parts[index - 1]?.toLowerCase() === 'webresources' && parts[index + 1] && !BUNDLE.test(parts[index + 1]);
    return volatile || controlName ? ':resource' : part.toLowerCase();
  }).join('/')}`;
}

export function createRule(value, resourceType = 'pcf') {
  const url = new URL(value);
  const normalized = normalizeResource(value);
  const stable = normalized.split('/').filter(part => part && ![':resource', 'webresources', 'bundle.js'].includes(part));
  return {
    hostname: url.hostname,
    exactPath: url.pathname.toLowerCase(),
    normalized,
    control: stable.at(-1) || null,
    selectedUrl: value,
    resourceType
  };
}

export function interceptionPatterns(rule) {
  if (!rule?.hostname || !rule?.selectedUrl) return [];

  if (rule.resourceType === 'pcf') {
    return [
      { urlPattern: `https://${rule.hostname}/*bundle.js*`, requestStage: 'Request' },
      { urlPattern: `https://${rule.hostname}/*bundle.min.js*`, requestStage: 'Request' }
    ];
  }

  const selected = new URL(rule.selectedUrl);
  const resourceName = selected.pathname.split('/').filter(Boolean).at(-1);
  if (!resourceName) return [];

  return [{
    urlPattern: `${selected.origin}/*${resourceName}*`,
    requestStage: 'Request'
  }];
}

export function matchesRule(rule, value) {
  try {
    const url = new URL(value);
    if (url.hostname !== rule.hostname) return false;

    if (['script', 'html'].includes(rule.resourceType)) {
      return url.pathname.toLowerCase() === rule.exactPath ||
        normalizeResource(value) === rule.normalized;
    }

    if (!BUNDLE.test(url.pathname)) return false;
    return url.pathname.toLowerCase() === rule.exactPath ||
      normalizeResource(value) === rule.normalized;
  } catch { return false; }
}
