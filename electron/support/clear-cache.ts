import type { Session } from "electron";

/**
 * The web content Clear cache and restart clears: the HTTP and code caches,
 * Cache Storage, shader caches, service workers, resolved host names and HTTP
 * sign-in prompts. Cookies, local storage and the account's data stay, so the
 * person stays signed in.
 */
export async function clearWebCaches(session: Session): Promise<void> {
  await session.clearCache();
  await session.clearCodeCaches({});
  await session.clearStorageData({
    storages: ["cachestorage", "shadercache", "serviceworkers"],
  });
  await session.clearHostResolverCache();
  await session.clearAuthCache();
}
