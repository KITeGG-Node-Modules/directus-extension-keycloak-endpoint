import { basename } from 'path'
import { baseRequestHandler } from 'kitegg-directus-extension-common'
import { enumType, enumAssociation, profilePattern, validateUser } from './validations.js'
import { filterUser } from './filter-props.js'
import { generatePassword } from './random-password.js'
import { handleErrorResponse } from 'kitegg-directus-extension-common'
import { isRequestAllowed } from './is-request-allowed.js'
import { extractLastLogin } from './last-login.js'

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
      await client.delete(`/users/${ctx.req.params.id}`)
      const usersService = new UsersService({schema: req.schema, accountability: req.accountability})
      try {
        const user = (await usersService.readByQuery({
          filter: {
            external_identifier: req.params.id
          }
        })).shift()
        if (user) {
          await usersService.deleteOne(user.id)
          logger.info(`${LOG_PREFIX}Deleted Directus user with ID ${user.id}`)
        }
        return {
          id: req.params.id,
          directusId: user?.id
        }
      } catch (err) {
        logger.error(`${LOG_PREFIX}Failed to delete Directus user: ${err.message}`)
        return {
          id: req.params.id,
          directusError: err.message
        }
      }
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
