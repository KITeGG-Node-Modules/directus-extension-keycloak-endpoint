const OTP_LENGTH = 6
const LOG_PREFIX = 'Keycloak Endpoint: '
const TYPES = ['student', 'staff', 'management', 'admin']

// Keycloak user attributes in which last-login event listener SPIs store the
// last login time, checked in order:
// - slemke/keycloak-last-login-event-listener (provider "last-login") uses "lastLogin"
// - dasniko's LastLoginTimeListener (provider "last-login-time") uses "lastLoginTime"
const LAST_LOGIN_ATTRIBUTES = ['lastLogin', 'lastLoginTime']

export {
  OTP_LENGTH,
  LOG_PREFIX,
  TYPES,
  LAST_LOGIN_ATTRIBUTES
}
