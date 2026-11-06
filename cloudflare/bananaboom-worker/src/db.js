// The binding is imported only on the runtime path so Node.js tests can supply
// their own repository without importing Cloudflare-specific modules.
async function mongo() {
  const { env } = await import('cloudflare:workers');
  const id = env.MONGODB_CONNECTION.idFromName('bananaboom-mongo');
  return env.MONGODB_CONNECTION.get(id, { locationHint: 'enam' });
}

export const repository = {
  homepages: async () => (await mongo()).homepages(),
  likes: async () => (await mongo()).likes(),
  projects: async () => (await mongo()).projects(),
  logs: async () => (await mongo()).logs(),
  publicPhotos: async () => (await mongo()).publicPhotos(),
  publicComments: async (id, reply) => (await mongo()).publicComments(id, reply),
  backupDatabase: async () => (await mongo()).backupDatabase(),
  passwordSignIn: async (input) => (await mongo()).passwordSignIn(input),
  passwordLogout: async (token) => (await mongo()).passwordLogout(token),
  brainVaultScopes: async (token, resource) => (await mongo()).brainVaultScopes(token, resource),
  brainVaultSearch: async (token, input, resource) =>
    (await mongo()).brainVaultSearch(token, input, resource),
  brainVaultRead: async (token, id, resource) => (await mongo()).brainVaultRead(token, id, resource),
  brainVaultSync: async (token, input, resource) => (await mongo()).brainVaultSync(token, input, resource),
  brainOAuthTokenGrant: async input => (await mongo()).brainOAuthTokenGrant(input),
  publicResume: async (user) => (await mongo()).publicResume(user),
  publicResumeList: async (user) => (await mongo()).publicResumeList(user),
  publicProjects: async () => (await mongo()).publicProjects(),
  publicMenu: async (options) => (await mongo()).publicMenu(options),
  publicTags: async () => (await mongo()).publicTags(),
  publicPosts: async (options) => (await mongo()).publicPosts(options),
  authorizeSession: async (token) => (await mongo()).authorizeSession(token),
  ownerProfile: async (user) => (await mongo()).ownerProfile(user),
  ownerTodos: async (user, query) => (await mongo()).ownerTodos(user, query),
  ownerFootprints: async (user, query) => (await mongo()).ownerFootprints(user, query),
  ownerFootprintDetail: async (user, id) => (await mongo()).ownerFootprintDetail(user, id),
  ownerAiStatus: async (user) => (await mongo()).ownerAiStatus(user),
  privatePosts: async (options) => (await mongo()).privatePosts(options),
  pollPostWriteEvents: async (after, max) => (await mongo()).pollPostWriteEvents(after, max),
  publicPostById: async (id) => (await mongo()).publicPostById(id),
  privatePostById: async (id) => (await mongo()).privatePostById(id),
  publicPostLikes: async (id) => (await mongo()).publicPostLikes(id),
  changePostLikes: async (id, direction) => (await mongo()).changePostLikes(id, direction),
  createArticle: async (input, operatorId, ip, key) => (await mongo()).createArticle(input, operatorId, ip, key),
  updateArticle: async (id, input, operatorId, ip, key) => (await mongo()).updateArticle(id, input, operatorId, ip, key),
    deleteArticle: async (id, operatorId, ip, key) =>
    (await mongo()).deleteArticle(id, operatorId, ip, key)
};
