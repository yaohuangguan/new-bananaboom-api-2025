import K from '../config/permissionKeys.js';

// A public detail URL must not bypass the private journal's read permission.
export function canReadPost(post, user) {
  if (!post.isPrivate) return true;
  if (!user) return false;
  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  return user.role === 'super_admin' || permissions.includes('*') || permissions.includes(K.PRIVATE_POST_READ);
}
