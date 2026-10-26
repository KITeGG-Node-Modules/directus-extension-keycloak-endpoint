import { createError } from '@directus/errors'

const DeletionNotAllowedError = createError(
  'DELETION_NOT_ALLOWED',
  'forbidden',
  403
)

// Role types ranked ascending ("HfG Offenbach / Student" → 0,
// "… / Staff" → 1, "… / Management" → 2); the admin role outranks
// everything. Unknown roles deny by default.
const ROLE_TYPES = ['student', 'staff', 'management']
const ADMIN_RANK = ROLE_TYPES.length

export function getRankFromRole (role) {
  if (!role?.name) return null
  if (role.admin || role.name === 'Administrator') return ADMIN_RANK
  const match = role.name.toLowerCase().match(/\/\s*(student|staff|management)$/)
  return match ? ROLE_TYPES.indexOf(match[1]) : null
}

/**
 * The caller must strictly outrank the target user: staff may delete
 * students, management students and staff; admin anyone. Management
 * deleting management requires an admin. Both role names are resolved via
 * the users relation (role.name) — reading directus_roles directly is not
 * permitted for non-admin callers.
 */
export function isDeletionAllowed ({ callerRoleName, callerIsAdmin, targetRoleName }) {
  const callerRank = callerIsAdmin
    ? ADMIN_RANK
    : getRankFromRole({ name: callerRoleName })
  const targetRank = getRankFromRole({ name: targetRoleName })

  return callerRank !== null && targetRank !== null &&
    (callerRank === ADMIN_RANK || targetRank < callerRank)
}

export { DeletionNotAllowedError }
