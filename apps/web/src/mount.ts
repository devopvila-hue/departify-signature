/** Same-origin tenant mount, empty for the original standalone application. */
export const basePath = window.location.pathname.match(/^\/api\/sign\/[A-Za-z0-9_-]+\/workspace(?=\/|$)/)?.[0] ?? '';
export const mountedUrl = (path: string) => basePath + path;
