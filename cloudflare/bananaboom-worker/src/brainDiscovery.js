// Public OAuth discovery metadata for the EXISTING Orion Brain auth server.
// The active DCR, consent, token and revocation endpoints remain Cloud Run
// until independently accepted. Keep these documents byte-for-byte equivalent
// to the existing @modelcontextprotocol/sdk mcpAuthRouter output.
import { BRAIN_MCP_RESOURCE } from './brainRead.js';

const issuer='https://api.samyao.me/';
const scopes=['memory:read','memory:write'];
export const DISCOVERY_AUTH_PATH='/.well-known/oauth-authorization-server';
export const DISCOVERY_RESOURCE_PATH='/.well-known/oauth-protected-resource/api/brain/sync/mcp';

export function brainDiscoveryDocument(pathname) {
  if(pathname===DISCOVERY_AUTH_PATH)return {
    issuer,
    authorization_endpoint:issuer+'authorize',
    response_types_supported:['code'],
    code_challenge_methods_supported:['S256'],
    token_endpoint:issuer+'token',
    token_endpoint_auth_methods_supported:['none'],
    grant_types_supported:['authorization_code','refresh_token'],
    scopes_supported:scopes,
    revocation_endpoint:issuer+'revoke',
    revocation_endpoint_auth_methods_supported:['none'],
    registration_endpoint:issuer+'register',
    authorization_response_iss_parameter_supported:true
  };
  if(pathname===DISCOVERY_RESOURCE_PATH)return {
    resource:BRAIN_MCP_RESOURCE,
    authorization_servers:[issuer],
    scopes_supported:scopes,
    resource_name:'Orion Personal Knowledge'
  };
  return null;
}
export function handleBrainDiscovery(request) {
  const url=new URL(request.url);
  const doc=brainDiscoveryDocument(url.pathname);
  if(!doc || request.method!=='GET' || url.search)return null;
  return Response.json(doc,{headers:{
    'cache-control':'public, max-age=60',
    'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer'
  }});
}
