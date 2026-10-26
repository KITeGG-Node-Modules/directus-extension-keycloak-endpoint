import { basename } from 'path'
import { baseRequestHandler } from 'kitegg-directus-extension-common'
import { enumType, enumAssociation, profilePattern, validateUser } from './validations.js'
import { filterUser } from './filter-props.js'
import { generatePassword } from './random-password.js'
import { handleErrorResponse } from 'kitegg-directus-extension-common'
import { isRequestAllowed } from './is-request-allowed.js'
import { extractLastLogin } from './last-login.js'
import { isJupyterHubConfigured } from './config.js'
import { deleteJupyterUser } from './jupyterhub.js'
import { cleanupUserObjects } from './user-cleanup.js'
import { parseDeleteOptions } from './delete-options.js'
import { isDeletionAllowed, DeletionNotAllowedError } from './deletion-permissions.js'
import { isNotFound } from './is-not-found.js'

import { LOG_PREFIX } from './constants.js'

export default {
  id: 'keycloak',
  handler: (router, context) => {
    const {services, logger} = context
    const {ItemsService, UsersService} = services

    const allowGroups = ['staff', 'management']
    const propWhitelist = ['firstName', 'lastName', 'email']

    // Maps Keycloak user IDs to the last access date of the linked Directus
    // users. Directus updates last_access on login and token refresh, so it
    // works as a "last seen" date for users logged in through Directus.
    async function getLastSeenByUser (ctx, ids) {
      const lastSeenByUser = new Map()
      if (!ids.length) return lastSeenByUser
      const usersService = new UsersService({schema: ctx.req.schema, accountability: ctx.req.accountability})
      try {
        for (let i = 0; i < ids.length; i += 100) {
          const chunk = ids.slice(i, i + 100)
          const users = await usersService.readByQuery({
            filter: {external_identifier: {_in: chunk}},
            fields: ['external_identifier', 'last_access'],
            limit: chunk.length
          })
          for (const user of users) {
            lastSeenByUser.set(user.external_identifier, user.last_access)
          }
        }
      } catch (err) {
        logger.error(`${LOG_PREFIX}Failed to read Directus last access dates: ${err.message}`)
      }
      return lastSeenByUser
    }

    //
    // Users
    //

    //
    // FIND
    router.get('/users', baseRequestHandler(async ctx => {
      const {data: users} = await ctx.client.get('/users', {params: ctx.req.query})
      const lastSeenByUser = await getLastSeenByUser(ctx, users.map(user => user.id))
      return users.map(user => filterUser({
        ...user,
        lastLogin: extractLastLogin(user),
        lastSeen: lastSeenByUser.get(user.id) ?? null
      }))
    }, context, allowGroups, propWhitelist))

    //
    // GET
    router.get('/users/:id', baseRequestHandler(async ctx => {
      const {client, req} = ctx
      const {data: user} = await client.get(`/users/${req.params.id}`)
      const {data: groups} = await client.get(`/users/${req.params.id}/groups`)

      const association = groups.find(group => enumAssociation.includes(group.name))
      if (association) user.association = association.name
      const type = groups.find(group => enumType.includes(group.name))
      if (type) user.type = type.name

      user.profiles = groups.filter(group => group.name.indexOf('gpu-') === 0).map(group => group.name)

      user.lastLogin = extractLastLogin(user)
      const lastSeenByUser = await getLastSeenByUser(ctx, [user.id])
      user.lastSeen = lastSeenByUser.get(user.id) ?? null

      return filterUser(user)
    }, context, allowGroups, propWhitelist))

    //
    // POST
    router.post('/users', baseRequestHandler(async ctx => {
      try {
        validateUser(ctx.req.body, 'post')
        await isRequestAllowed(ctx)
      } catch (err) {
        return handleErrorResponse(ctx, err)
      }

      const {client, req} = ctx
      const data = req.body
      const createDirectusUser = !data.skipDirectusUser

      const associationName = data.association
      delete data.association
      const typeName = data.type
      delete data.type
      data.enabled = true

      const {data: groups} = await client.get('/groups')

      let profiles = []
      if (Array.isArray(data.profiles)) {
        profiles = groups.filter(group => profilePattern.test(group.name) && data.profiles.includes(group.name))
        delete data.profiles
      }

      const response = await client.post('/users', data)
      const location = new URL(response.headers.location)
      const userId = basename(location.pathname)
      logger.info(`${LOG_PREFIX}Created Keycloak user with ID ${userId}`)

      const association = groups.find(group => group.name === associationName)
      if (association) await client.put(`/users/${userId}/groups/${association.id}`)
      const type = groups.find(group => group.name === typeName)
      if (type) await client.put(`/users/${userId}/groups/${type.id}`)

      for (const profile of profiles) {
        await client.put(`/users/${userId}/groups/${profile.id}`)
      }

      const pwd = generatePassword()
      await client.put(`/users/${userId}/reset-password`, {
        value: pwd,
        temporary: true
      })

      let directusUserId
      if (createDirectusUser) {
        const userPayload = {
          provider: 'keycloak',
          first_name: data.firstName,
          last_name: data.lastName,
          email: data.email,
          external_identifier: userId
        }
        const mappingService = new ItemsService('role_group_mapping', {
          schema: req.schema,
          accountability: req.accountability
        })
        const usersService = new UsersService({schema: req.schema, accountability: req.accountability})
        try {
          const groupId = `${association.name}-${type.name === 'management' ? 'staff' : type.name}`
          const results = await mappingService.readByQuery({filter: {groupId}})
          const roleId = results.map(mapping => mapping.roleId).shift()
          if (roleId) {
            userPayload.role = roleId
            directusUserId = await usersService.createOne(userPayload)
            logger.info(`${LOG_PREFIX}Created Directus user with ID ${directusUserId}`)
          } else throw new Error('No matching role ID found')
        } catch (err) {
          logger.error(`${LOG_PREFIX}Failed to create Directus user: ${err.message}`)
        }
      }

      return Object.assign({
        id: userId,
        directusUserId,
        temporaryPassword: pwd
      }, data)
    }, context, allowGroups, propWhitelist))

    //
    // PATCH
    router.patch('/users/:id', baseRequestHandler(async ctx => {
      if (!ctx.req.params.id || !ctx.req.params.id.length) {
        ctx.res.status(400)
        return ctx.res.send({message: 'api_errors.bad_request'})
      }
      try {
        validateUser(ctx.req.body, 'patch')
        await isRequestAllowed(ctx)
      } catch (err) {
        return handleErrorResponse(ctx, err)
      }

      const {client, req} = ctx
      const data = req.body

      const {data: groups} = await client.get(`/groups`)
      const {data: subjectGroups} = await client.get(`/users/${req.params.id}/groups`)

      // Remember the requested association/type before they are removed from
      // the payload below — they are needed to re-map the Directus role
      const requestedAssociation = data.association
      const requestedType = data.type

      if (data.association) {
        const existingAssociation = subjectGroups.find(group => enumAssociation.includes(group.name))
        const association = groups.find(group => group.name === data.association)
        if (data.association !== existingAssociation?.name) {
          if (existingAssociation) {
            await client.delete(`/users/${req.params.id}/groups/${existingAssociation.id}`)
          }
          await client.put(`/users/${req.params.id}/groups/${association.id}`)
        }
        delete data.association
      }
      if (data.type) {
        const existingType = subjectGroups.find(group => enumType.includes(group.name))
        const type = groups.find(group => group.name === data.type)
        if (data.type !== existingType?.name) {
          if (existingType) {
            await client.delete(`/users/${req.params.id}/groups/${existingType.id}`)
          }
          await client.put(`/users/${req.params.id}/groups/${type.id}`)
        }
        delete data.type
      }
      if (data.profiles) {
        const existingProfiles = subjectGroups.filter(group => profilePattern.test(group.name))
        for (const profileName of data.profiles) {
          if (!existingProfiles.find(p => p.name === profileName)) {
            const profile = groups.find(group => group.name === profileName)
            await client.put(`/users/${req.params.id}/groups/${profile.id}`)
          }
        }
        for (const profile of existingProfiles) {
          if (!data.profiles.find(profileName => profileName === profile.name)) {
            await client.delete(`/users/${req.params.id}/groups/${profile.id}`)
          }
        }
        delete data.profiles
      }
      const {data: result} = await client.put(`/users/${req.params.id}`, data)

      const directusPayload = {}
      if (data.email) directusPayload.email = data.email
      if (data.firstName) directusPayload.first_name = data.firstName
      if (data.lastName) directusPayload.last_name = data.lastName
      if (typeof data.auth_data !== 'undefined') directusPayload.auth_data = data.auth_data

      // Keep the Directus role in sync when the association or type was
      // changed, using the same role_group_mapping the auth hook applies on
      // login (groupId "<association>-<type>"); otherwise the user keeps the
      // old role in Directus until their next login
      if (requestedAssociation || requestedType) {
        const existingAssociation = subjectGroups.find(group => enumAssociation.includes(group.name))
        const existingType = subjectGroups.find(group => enumType.includes(group.name))
        const association = requestedAssociation || existingAssociation?.name
        const type = requestedType || existingType?.name
        if (association && type) {
          try {
            const mappingService = new ItemsService('role_group_mapping', {
              schema: req.schema,
              accountability: req.accountability
            })
            const results = await mappingService.readByQuery({
              filter: { groupId: `${association}-${type}` }
            })
            const roleId = results.map(mapping => mapping.roleId).shift()
            if (roleId) directusPayload.role = roleId
          } catch (err) {
            logger.error(`${LOG_PREFIX}Failed to look up role mapping: ${err.message}`)
          }
        }
      }

      if (Object.keys(directusPayload).length) {
        const usersService = new UsersService({schema: req.schema, accountability: req.accountability})
        try {
          const user = (await usersService.readByQuery({
            filter: {
              external_identifier: req.params.id
            }
          })).shift()
          if (user) {
            await usersService.updateOne(user.id, directusPayload)
          }
        } catch (err) {
          logger.error(`${LOG_PREFIX}Failed to update Directus user: ${err.message}`)
        }
      }

      return result || { success: true }
    }, context, allowGroups, propWhitelist))

    //
    // DELETE
    //
    // Full user deletion across all three systems, in dependency order:
    // 1. JupyterHub (server, hub user, home volume)
    // 2. Directus (object transfer/removal, junction pruning, the user)
    // 3. Keycloak (the IdP account)
    //
    // Every step is idempotent (already-deleted state = success) so the
    // whole deletion can be re-run after a partial failure; the response
    // carries a per-step report for the frontend dialog.
    router.delete('/users/:id', baseRequestHandler(async ctx => {
      if (!ctx.req.params.id || !ctx.req.params.id.length) {
        ctx.res.status(400)
        return ctx.res.send({message: 'api_errors.bad_request'})
      }
      try {
        await isRequestAllowed(ctx)
      } catch (err) {
        return handleErrorResponse(ctx, err)
      }

      const {client, req} = ctx
      const keycloakUserId = req.params.id

      let options
      try {
        options = parseDeleteOptions(req.body)
      } catch (err) {
        ctx.res.status(400)
        return ctx.res.send({message: `api_errors.bad_request: ${err.message}`})
      }

      const report = {
        id: keycloakUserId,
        directusId: null,
        jupyterhub: null,
        directus: null,
        keycloak: {deleted: false},
        success: false
      }

      // The Directus user must be resolved first: every step works with its
      // id, and on re-runs after partial failures the username for the
      // JupyterHub step can only be resolved while the Keycloak account
      // still exists
      const usersService = new UsersService({schema: req.schema, accountability: null})
      let directusUser
      try {
        directusUser = (await usersService.readByQuery({
          filter: {external_identifier: keycloakUserId},
          fields: ['id', 'external_identifier', 'role.name']
        })).shift()
      } catch (err) {
        logger.error(`${LOG_PREFIX}Failed to look up Directus user: ${err.message}`)
      }
      if (!directusUser) {
        // Directus-only accounts have no Keycloak link: the deletion
        // request then addresses the user by their Directus id
        try {
          directusUser = await usersService.readOne(keycloakUserId, {fields: ['id', 'external_identifier', 'role.name']})
        } catch {
          // no Directus user with that id
        }
      }
      report.directusId = directusUser?.id || null
      // Accounts without a Keycloak link exist only in Directus — no hub
      // account (keyed by the Keycloak username) and no IdP account to
      // remove; only the Directus cleanup applies
      const directusOnlyUser = !!directusUser && !directusUser.external_identifier

      // Only callers strictly outranking the target may delete it (admin →
      // anyone, management → students and staff, staff → students;
      // management on management requires an admin). A target without a
      // linked Directus user cannot be ranked — only its Keycloak account
      // is removed.
      if (directusUser) {
        // Role names are resolved through the users relation (role.name) —
        // reading directus_roles directly is not permitted for non-admin
        // callers. The caller's own role name is read with their own
        // accountability, which the app relies on everywhere.
        let callerRoleName = null
        try {
          const meService = new UsersService({schema: req.schema, accountability: req.accountability})
          callerRoleName = (await meService.readOne(req.accountability.user, {fields: ['role.name']}))?.role?.name ?? null
        } catch (err) {
          logger.error(`${LOG_PREFIX}Failed to look up caller role: ${err.message}`)
        }
        if (!isDeletionAllowed({
          callerRoleName,
          callerIsAdmin: req.accountability?.admin === true,
          targetRoleName: directusUser?.role?.name ?? null
        })) {
          logger.info(`${LOG_PREFIX}Deletion denied: caller role "${callerRoleName}" may not delete target role "${directusUser?.role?.name}"`)
          return handleErrorResponse(ctx, DeletionNotAllowedError())
        }
      }

      //
      // 1. JupyterHub
      //
      if (directusOnlyUser) {
        report.jupyterhub = {skipped: 'no Keycloak account'}
      } else {
      try {
        if (!isJupyterHubConfigured()) {
          throw new Error('JupyterHub API is not configured (JUPYTERHUB_API_URL / JUPYTERHUB_API_TOKEN)')
        }
        const {data: keycloakUser} = await client.get(`/users/${keycloakUserId}`)
        const username = keycloakUser?.username
        if (!username) throw new Error('Keycloak user has no username')
        report.jupyterhub = await deleteJupyterUser({
          username,
          deleteVolume: options.deleteJupyterVolume
        })
      } catch (err) {
        if (isNotFound(err)) {
          // The Keycloak account is already gone (re-run after a partial
          // failure): the hub account was handled by the earlier run — the
          // username can no longer be resolved, but there is nothing left
          // to clean up that the previous run missed
          report.jupyterhub = {skipped: 'keycloak user already deleted'}
          logger.info(`${LOG_PREFIX}JupyterHub step skipped: Keycloak user ${keycloakUserId} already deleted`)
        } else {
          // Keep the partial progress the hub step achieved (serverStopped,
          // userDeleted, …) alongside the error
          report.jupyterhub = { ...(err.jupyterhubReport || {}), error: err.message }
          logger.error(`${LOG_PREFIX}JupyterHub step failed: ${err.message}`)
          return report
        }
      }
      }

      //
      // 2. Directus
      //
      try {
        if (directusUser) {
          report.directus = await cleanupUserObjects({
            services,
            schema: req.schema,
            logger,
            logPrefix: LOG_PREFIX,
            directusUser,
            scope: options.collections,
            transferTo: options.transferTo
          })
          await usersService.deleteOne(directusUser.id)
          logger.info(`${LOG_PREFIX}Deleted Directus user with ID ${directusUser.id}`)
        } else {
          report.directus = {skipped: 'no linked Directus user'}
        }
      } catch (err) {
        report.directus = report.directus || {}
        report.directus.error = err.message
        logger.error(`${LOG_PREFIX}Directus step failed: ${err.message}`)
        // The IdP account must not outlive a Directus user that still
        // exists — leave Keycloak untouched and let the admin re-run
        return report
      }

      //
      // 3. Keycloak
      //
      if (directusOnlyUser) {
        report.keycloak = {skipped: 'no Keycloak account'}
      } else {
        try {
          await client.delete(`/users/${keycloakUserId}`)
          report.keycloak.deleted = true
        } catch (err) {
          if (isNotFound(err)) {
            report.keycloak.deleted = true
            report.keycloak.note = 'already deleted'
          } else {
            report.keycloak.error = err.message
            logger.error(`${LOG_PREFIX}Keycloak step failed: ${err.message}`)
          }
        }
      }

      report.success = !report.directus?.errors?.length && !report.keycloak.error
      return report
    }, context, allowGroups, propWhitelist))

    //
    // Reset password
    router.post('/users/:id/password', baseRequestHandler(async ctx => {
      const {client, req} = ctx

      try {
        await isRequestAllowed(ctx)
      } catch (err) {
        return handleErrorResponse(ctx, err)
      }

      const temporaryPassword = generatePassword()
      await client.put(`/users/${req.params.id}/reset-password`, {
        value: temporaryPassword,
        temporary: true
      })
      return {
        temporaryPassword
      }
    }, context, allowGroups, propWhitelist))

    //
    // Associations
    router.get('/associations', baseRequestHandler(async ctx => {
      const {data} = await ctx.client.get('/groups')
      return data.filter(group => enumAssociation.includes(group.name)).map(group => group.name)
    }, context, allowGroups, propWhitelist))

    //
    // Types
    router.get('/types', baseRequestHandler(async ctx => {
      const {data} = await ctx.client.get('/groups')
      return data.filter(group => enumType.includes(group.name)).map(group => group.name)
    }, context, allowGroups, propWhitelist))

    //
    // Profiles
    router.get('/profiles', baseRequestHandler(async ctx => {
      const {data} = await ctx.client.get('/groups')
      return data.filter(group => profilePattern.test(group.name)).map(group => group.name)
    }, context, allowGroups, propWhitelist))
  }
}
