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

// Roles arrive either as full objects (when read with role fields) or as
// bare role ids (default M2O behaviour) — resolve ids through the schema
async function resolveRole (rolesService, role) {
  if (!role || role.name) return role
  return rolesService.readOne(role, { fields: ['name', 'admin'] })
}

/**
 * The caller must strictly outrank the target user: staff may delete
 * students, management students and staff; admin anyone. Management
 * deleting management requires an admin. Runs before any destructive step.
 */
export async function assertDeletionAllowed ({ callerUser, targetUser, services, schema }) {
  const rolesService = new services.RolesService({ schema, accountability: null })
  const callerRank = getRankFromRole(await resolveRole(rolesService, callerUser?.role))
  const targetRank = getRankFromRole(await resolveRole(rolesService, targetUser?.role))

  const allowed = callerRank !== null && targetRank !== null &&
    (callerRank === ADMIN_RANK || targetRank < callerRank)

  if (!allowed) {
    throw DeletionNotAllowedError()
  }
}
