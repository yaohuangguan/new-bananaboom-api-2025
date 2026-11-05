// Mongoose materializes these defaults for legacy Project.find() responses.
// The native MongoDB driver does not, so keep the public API shape stable.
export function withProjectDefaults(project) {
  return {
    ...project,
    ...(!Object.hasOwn(project, 'category') ? { category: 'web' } : {}),
    ...(!Object.hasOwn(project, 'categories') ? { categories: [] } : {})
  };
}
