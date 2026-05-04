/**
 * Backwards-compat re-exports of tenant types and color tables.
 *
 * Server-side fs operations live in `tenants-server.ts` and must NOT be
 * imported here — pulling fs into the client bundle breaks the build.
 */

export {
  TENANT_COLORS,
  TENANT_COLOR_CLASSES,
  type TenantColor,
  type Tenant,
} from "./tenant-types";
