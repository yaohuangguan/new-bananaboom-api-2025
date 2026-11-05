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
  publicTags: async () => (await mongo()).publicTags(),
  publicPosts: async (options) => (await mongo()).publicPosts(options),
  authorizeSession: async (token) => (await mongo()).authorizeSession(token),
  privatePosts: async (options) => (await mongo()).privatePosts(options),
  publicPostById: async (id) => (await mongo()).publicPostById(id)
};
