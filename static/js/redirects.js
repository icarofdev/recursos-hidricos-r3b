// @ts-check
/** @param {unknown} value @param {string} origin */
export function safeRedirect(value, origin = window.location.origin) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\x00-\x20\x7f]/.test(value)
  )
    return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.startsWith('//')) return '/';
    const url = new URL(value, origin);
    return url.origin === origin && !url.username && !url.password
      ? url.pathname + url.search + url.hash
      : '/';
  } catch {
    return '/';
  }
}
