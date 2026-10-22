import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mcpAuthRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { Router, json, urlencoded } from 'express';
import { BrainConnection, BrainCredential, BrainOAuthClient, BrainAuthorization, BrainAuthorizationCode } from '../../models/brainSync.js';
import { sha, fail } from './core.js';
import { SCOPES, publicBase, mcpResource, secret, scopesOf, issueCredential, verifyVaultToken, ownerCanUse, revokeConnection } from './connections.js';
const now = () => new Date();
const future = ms => new Date(Date.now() + ms);
function checkedResource(resource) {
  if (resource && resource.href !== mcpResource()) throw new InvalidRequestError('Unexpected resource');
  return mcpResource();
}
function checkedScopes(scopes) {
  try { return scopesOf(scopes?.length ? scopes : SCOPES); } catch { throw new InvalidScopeError('Unsupported memory scope'); }
}
async function issueOAuth(connection, session, scopes = connection.scopes) {
  const accessExpiry = new Date(Math.min(Date.now() + 3600000, +connection.expiresAt));
  const refreshExpiry = new Date(Math.min(Date.now() + 30 * 86400000, +connection.expiresAt));
  return {
    access_token: await issueCredential(connection, 'access', accessExpiry, session, scopes),
    refresh_token: await issueCredential(connection, 'refresh', refreshExpiry, session, scopes),
    token_type: 'Bearer', expires_in: Math.max(0, Math.floor((+accessExpiry - Date.now()) / 1000)), scope: scopes.join(' ')
  };
}
export const oauthProvider = {
  clientsStore: {
    async getClient(clientId) {
      if (typeof clientId !== 'string' || clientId.length > 200) return undefined;
      return (await BrainOAuthClient.findOne({ clientId, expiresAt: { $gt: now() } }).lean())?.metadata;
    },
    async registerClient(info) {
      if (info.token_endpoint_auth_method && info.token_endpoint_auth_method !== 'none')
        throw new InvalidClientMetadataError('Use a public client with PKCE and token_endpoint_auth_method=none');
      if (!info.redirect_uris?.length || info.redirect_uris.length > 5 || (info.client_name || '').length > 80)
        throw new InvalidClientMetadataError('Invalid client metadata');
      for (const uri of info.redirect_uris) {
        const u = new URL(uri);
        if (u.protocol !== 'https:' || u.username || u.password || u.hash || uri.length > 2000)
          throw new InvalidClientMetadataError('HTTPS redirect URI without credentials or fragment required');
      }
      const metadata = { ...info, client_id: info.client_id || randomUUID(), client_secret: undefined,
        client_secret_expires_at: undefined, token_endpoint_auth_method: 'none' };
      await BrainOAuthClient.create({ clientId: metadata.client_id, metadata, expiresAt: future(365 * 86400000) });
      return metadata;
    }
  },
  async authorize(client, params, res) {
    checkedResource(params.resource);
    const scopes = checkedScopes(params.scopes);
    if (!/^[a-zA-Z0-9_-]{43}$/.test(params.codeChallenge) || (params.state || '').length > 2000)
      throw new InvalidRequestError('Invalid PKCE challenge or state');
    const request = secret();
    await BrainAuthorization.create({ hash: sha(request), clientId: client.client_id,
      params: { ...params, scopes, resource: mcpResource() }, expiresAt: future(10 * 60000) });
    const target = new URL('/memory/connect', process.env.BRAIN_CONNECT_UI_URL || 'https://samyao.me');
    target.searchParams.set('request', request);
    res.redirect(302, target.href);
  },
  async challengeForAuthorizationCode(client, value) {
    const code = await BrainAuthorizationCode.findOne({ hash: sha(value), clientId: client.client_id, expiresAt: { $gt: now() } }).lean();
    if (!code) throw new InvalidGrantError('Invalid or expired authorization code');
    return code.params.codeChallenge;
  },
  async exchangeAuthorizationCode(client, value, _verifier, redirectUri, resource) {
    checkedResource(resource);
    return mongoose.connection.transaction(async session => {
      const code = await BrainAuthorizationCode.findOneAndDelete({ hash: sha(value), clientId: client.client_id, expiresAt: { $gt: now() } }, { session }).lean();
      if (!code || redirectUri !== code.params.redirectUri) throw new InvalidGrantError('Code or redirect URI mismatch');
      const connection = await BrainConnection.findOne({ _id: code.connectionId, clientId: client.client_id,
        revokedAt: null, expiresAt: { $gt: now() } }).session(session).lean();
      if (!connection || !(await ownerCanUse(String(connection.ownerId)))) throw new InvalidGrantError('Connection unavailable');
      return issueOAuth(connection, session);
    });
  },
  async exchangeRefreshToken(client, token, scopes, resource) {
    checkedResource(resource);
    return mongoose.connection.transaction(async session => {
      const old = await BrainCredential.findOneAndDelete({ hash: sha(token), kind: 'refresh', expiresAt: { $gt: now() } }, { session }).lean();
      if (!old) throw new InvalidGrantError('Invalid refresh token');
      const connection = await BrainConnection.findOne({ _id: old.connectionId, clientId: client.client_id,
        revokedAt: null, expiresAt: { $gt: now() } }).session(session).lean();
      if (!connection || !(await ownerCanUse(String(connection.ownerId)))) throw new InvalidGrantError('Connection unavailable');
      const requested = scopes?.length ? checkedScopes(scopes) : old.scopes;
      if (requested.some(s => !old.scopes.includes(s) || !connection.scopes.includes(s))) throw new InvalidScopeError('Scope escalation rejected');
      return issueOAuth(connection, session, requested);
    });
  },
  async verifyAccessToken(token) {
    try {
      const c = await verifyVaultToken(token, mcpResource());
      return { token, clientId: c.clientId, scopes: c.scopes, expiresAt: Math.floor(+c.tokenExpiresAt / 1000),
        resource: new URL(mcpResource()), extra: { ownerId: String(c.ownerId), connectionId: String(c._id) } };
    } catch { throw new InvalidTokenError('Invalid or revoked memory connection'); }
  },
  async revokeToken(client, input) {
    const credential = await BrainCredential.findOne({ hash: sha(input.token) }).lean();
    if (!credential) return;
    const c = await BrainConnection.findOne({ _id: credential.connectionId, clientId: client.client_id }).lean();
    if (c) await revokeConnection(String(c.ownerId), String(c._id));
  }
};
export async function authorizationInfo(value) {
  if (typeof value !== 'string' || value.length > 100) fail('NOT_FOUND', 404);
  const request = await BrainAuthorization.findOne({ hash: sha(value), expiresAt: { $gt: now() } }).lean();
  if (!request) fail('NOT_FOUND', 404);
  const client = await oauthProvider.clientsStore.getClient(request.clientId);
  if (!client) fail('NOT_FOUND', 404);
  return { clientName: client.client_name || 'AI assistant', redirectOrigin: new URL(request.params.redirectUri).origin,
    scopes: request.params.scopes, expiresAt: request.expiresAt };
}
export async function approveAuthorization(ownerId, input) {
  if (!input || Object.keys(input).some(k => !['request', 'allow', 'scopes'].includes(k)) ||
    typeof input.request !== 'string' || input.request.length > 100 || typeof input.allow !== 'boolean') fail('INVALID_AUTHORIZATION');
  return mongoose.connection.transaction(async session => {
    const pending = await BrainAuthorization.findOneAndDelete({ hash: sha(input.request), expiresAt: { $gt: now() } }, { session }).lean();
    if (!pending) fail('NOT_FOUND', 404);
    const client = await oauthProvider.clientsStore.getClient(pending.clientId);
    if (!client || !client.redirect_uris.includes(pending.params.redirectUri)) fail('NOT_FOUND', 404);
    const target = new URL(pending.params.redirectUri);
    if (pending.params.state) target.searchParams.set('state', pending.params.state);
    target.searchParams.set('iss', publicBase());
    if (!input.allow) { target.searchParams.set('error', 'access_denied'); return { redirectUrl: target.href }; }
    const scopes = scopesOf(input.scopes || pending.params.scopes);
    if (scopes.some(s => !pending.params.scopes.includes(s))) fail('INVALID_SCOPES');
    if (await BrainConnection.countDocuments({ ownerId, revokedAt: null, expiresAt: { $gt: now() } }).session(session) >= 20) fail('CONNECTION_LIMIT', 409);
    const [connection] = await BrainConnection.create([{ ownerId, label: client.client_name || 'Claude',
      provider: /chatgpt|openai/i.test(client.client_name || '') ? 'chatgpt' : /claude/i.test(client.client_name || '') ? 'claude' : 'other', kind: 'oauth', clientId: pending.clientId, resource: mcpResource(), scopes,
      expiresAt: future(90 * 86400000) }], { session });
    const code = secret();
    await BrainAuthorizationCode.create([{ hash: sha(code), clientId: pending.clientId, connectionId: connection._id,
      params: pending.params, expiresAt: future(5 * 60000) }], { session });
    target.searchParams.set('code', code);
    return { redirectUrl: target.href };
  });
}
export function vaultOAuthRouter() {
  const options = { provider: oauthProvider, issuerUrl: new URL(publicBase()), resourceServerUrl: new URL(mcpResource()),
    scopesSupported: SCOPES, resourceName: 'Orion Personal Knowledge',
    clientRegistrationOptions: { rateLimit: { limit: 20 } } };
  const router = Router();
  // Set bounded parsers before SDK handlers, which otherwise use their own defaults.
  for (const route of ['/authorize', '/token', '/register', '/revoke']) {
    router.use(route, (req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); },
      json({ limit: '32kb' }), urlencoded({ extended: false, limit: '32kb' }));
  }
  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
    ...createOAuthMetadata(options), authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none']
  }));
  router.use(mcpAuthRouter(options));
  return router;
}
