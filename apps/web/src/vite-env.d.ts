/// <reference types="vite/client" />

/**
 * Ambient types for the web client.
 *
 * The reference lives here (instead of in the root tsconfig) so it resolves
 * `vite/client` from `apps/web/node_modules`, where Vite is installed.
 */
declare module '*.mjs?url' {
  const src: string;
  export default src;
}
