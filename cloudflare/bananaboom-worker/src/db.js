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
  publicProjects: async () => (await mongo()).publicProjects(),
  publicMenu: async (options) => (await mongo()).publicMenu(options),
  publicTags: async () => (await mongo()).publicTags(),
  publicPosts: async (options) => (await mongo()).publicPosts(options),
  authorizeSession: async (token) => (await mongo()).authorizeSession(token),
  privatePosts: async (options) => (await mongo()).privatePosts(options),
  publicPostById: async (id) => (await mongo()).publicPostById(id),
  privatePostById: async (id) => (await mongo()).privatePostById(id),
  publicPostLikes: async (id) => (await mongo()).publicPostLikes(id),
  changePostLikes: async (id, direction) => (await mongo()).changePostLikes(id, direction),
  createArticle: async (input, operatorId, ip) => (await mongo()).createArticle(input, operatorId, ip),
  updateArticle: async (id, input, operatorId, ip) => (await mongo()).updateArticle(id, input, operatorId, ip),
  getArticleForDeletion: async (id) => (await mongo()).getArticleForDeletion(id),
  deleteArticle: async (id, operatorId, ip, expectedPrivate) =>
    (await mongo()).deleteArticle(id, operatorId, ip, expectedPrivate)
};
