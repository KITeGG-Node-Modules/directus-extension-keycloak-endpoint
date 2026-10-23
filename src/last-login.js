import { LAST_LOGIN_ATTRIBUTES } from './constants.js'

// Listener SPIs store different value formats (epoch millis, ISO date-time,
// custom patterns). Normalize to an ISO 8601 string where possible.
function normalizeTimestamp (value) {
  if (typeof value === 'number' || /^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString()
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

// Extracts the last login date from Keycloak user attributes, as written by a
// last-login event listener SPI. Returns an ISO 8601 string or null.
function extractLastLogin (user) {
  const attributes = user?.attributes
  if (!attributes) return null
  for (const attribute of LAST_LOGIN_ATTRIBUTES) {
    const value = attributes[attribute]?.[0]
    if (value === undefined || value === null || value === '') continue
    const normalized = normalizeTimestamp(value)
    if (normalized) return normalized
  }
  return null
}

export {
  extractLastLogin
}
