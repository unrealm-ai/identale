import type { FastifyInstance, FastifyRequest } from 'fastify';
import { accountInput, type AccountService, type WorkspaceService, type EntityService, type AccountUser } from '@dentity/application';

/** HTTP-only account transport. Security hooks and service assembly live in bootstrap. */
export interface AccountRouteOptions {
  accounts: AccountService;
  workspaces: WorkspaceService;
  entities: EntityService;
  auth(request: FastifyRequest): AccountUser;
  cookieName: string;
  secureCookies: boolean;
  sessionTtlMs: number;
}
export async function registerAccounts(server: FastifyInstance, options: AccountRouteOptions) {
  const {accounts, workspaces, entities, auth, cookieName} = options;
  const cookieOptions = {path: '/', httpOnly: true, secure: options.secureCookies, sameSite: 'strict' as const};
  const sessionOptions = {...cookieOptions, maxAge: Math.floor(options.sessionTtlMs / 1000)};
  const limit = {rateLimit: {max: 20, timeWindow: '1 minute'}};
  const params = (request: FastifyRequest) => request.params as {workspaceId: string; entityId: string};
  server.post('/api/auth/register', {config: limit}, async (request, reply) => {
    const {sessionToken, ...response} = await accounts.register(request.body, request.cookies[cookieName]);
    reply.setCookie(cookieName, sessionToken, sessionOptions);
    return reply.code(201).send(response);
  });
  server.post('/api/auth/login', {config: limit}, async (request, reply) => {
    const {sessionToken, ...response} = await accounts.login(request.body, request.cookies[cookieName]);
    reply.setCookie(cookieName, sessionToken, sessionOptions);
    return response;
  });
  server.get('/api/auth/me', request => { const user = auth(request); return {user, workspaces: workspaces.list(user.id)}; });
  server.post('/api/auth/logout', async (request, reply) => { accounts.logout(request.body, request.cookies[cookieName]); reply.clearCookie(cookieName, cookieOptions); return {ok: true}; });
  server.get('/api/workspaces', request => ({workspaces: workspaces.list(auth(request).id)}));
  server.post('/api/workspaces', request => ({workspace: workspaces.createFromInput(auth(request).id, request.body)}));
  server.patch('/api/workspaces/:workspaceId', request => ({workspace: workspaces.rename(auth(request).id, params(request).workspaceId, request.body)}));
  server.post('/api/workspaces/:workspaceId/select', request => { accountInput(request.body, []); return {workspace: workspaces.get(auth(request).id, params(request).workspaceId)}; });
  server.get('/api/workspaces/:workspaceId/members',request=>({members:workspaces.members(auth(request).id,params(request).workspaceId)}));
  server.patch('/api/workspaces/:workspaceId/members/:memberId',request=>workspaces.patchMember(auth(request).id,params(request).workspaceId,(request.params as {memberId:string}).memberId,request.body));
  server.post('/api/workspaces/:workspaceId/invitations', {config: limit}, request => workspaces.invite(auth(request).id, params(request).workspaceId, request.body));
  server.post('/api/invitations/inspect', {config: limit}, request => workspaces.inspect(request.body));
  server.post('/api/invitations/accept', {config: limit}, request => ({workspace: workspaces.accept(auth(request).id, request.body)}));
  server.get('/api/workspaces/:workspaceId/entities', request => ({entities: entities.list(auth(request).id, params(request).workspaceId)}));
  server.post('/api/workspaces/:workspaceId/entities', request => ({entity: entities.create(auth(request).id, params(request).workspaceId, request.body)}));
  server.patch('/api/workspaces/:workspaceId/entities/:entityId', request => ({entity: entities.patch(auth(request).id, params(request).workspaceId, params(request).entityId, request.body)}));
  server.put('/api/workspaces/:workspaceId/entities/:entityId/description', request => ({entity: entities.setDescription(auth(request).id, params(request).workspaceId, params(request).entityId, request.body)}));
}
