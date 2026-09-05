import { existsSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { updateAppConfig } from "@/lib/app-config";
import { replaceTenantStore } from "@/lib/tenants-server";
import { importSsoConfig } from "@/lib/sso-server";
import {
  placeCredentialFile,
  MAX_CREDENTIAL_FILE_BYTES,
  type CredentialPlacement,
} from "@/lib/credential-files";
import { audit } from "@/lib/audit";
import {
  isValidEmail,
  validateCredentialsFilePath,
  ValidationError,
} from "@/lib/validate";
import { TENANT_COLORS, type Tenant, type TenantColor } from "@/lib/tenant-types";
import {
  CONFIG_BUNDLE_KIND,
  CONFIG_BUNDLE_VERSION,
} from "@/lib/app-config-types";
import { readCappedJson, BODY_TOO_LARGE } from "@/lib/request-body";

// Bundles now carry embedded key files (~2.5 KB each) — still small, but give
// large tenant fleets headroom.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TENANTS = 500;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function freshId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Import a configuration bundle produced by GET /api/config/export.
 *
 * Replace semantics: the bundle becomes the new tenant list and SSO config —
 * this is a restore, not a merge. Key files embedded in the bundle are
 * written back to disk: at their original path when it works on this machine,
 * otherwise relocated (GWS_CREDENTIALS_DIR if set, else ./credentials) with
 * the tenant re-pointed automatically — so restoring onto a different OS or
 * directory layout still comes up working. An existing different file at a
 * target path is kept as a .bak, never destroyed.
 *
 * Two deliberate softenings for bundles without embedded keys:
 *   - The current OIDC client secret is preserved when a secretless bundle
 *     points at the same issuer+client.
 *   - Credential paths are validated for shape but NOT required to exist;
 *     missing files come back as warnings so the operator knows what to copy.
 */
export async function POST(req: NextRequest) {
  const body = await readCappedJson(req, MAX_BODY_BYTES);
  if (body === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Body too large" }, { status: 413 });
  }

  if (body.kind !== CONFIG_BUNDLE_KIND) {
    return NextResponse.json(
      { error: "Not a toolbox configuration bundle (missing kind marker)" },
      { status: 400 }
    );
  }
  if (body.version !== CONFIG_BUNDLE_VERSION) {
    return NextResponse.json(
      {
        error: `Unsupported bundle version ${String(
          body.version
        )} — this server understands version ${CONFIG_BUNDLE_VERSION}`,
      },
      { status: 400 }
    );
  }

  const appPart =
    body.app && typeof body.app === "object" && !Array.isArray(body.app)
      ? (body.app as Record<string, unknown>)
      : {};
  const tenantsPart =
    body.tenants &&
    typeof body.tenants === "object" &&
    !Array.isArray(body.tenants)
      ? (body.tenants as Record<string, unknown>)
      : {};

  // ---- Validate embedded key files --------------------------------------
  const credFiles = new Map<string, string>();
  if (body.credentialFiles !== undefined) {
    if (
      !body.credentialFiles ||
      typeof body.credentialFiles !== "object" ||
      Array.isArray(body.credentialFiles)
    ) {
      return NextResponse.json(
        { error: "credentialFiles must be an object of path → content" },
        { status: 400 }
      );
    }
    for (const [p, content] of Object.entries(
      body.credentialFiles as Record<string, unknown>
    )) {
      if (typeof content !== "string") {
        return NextResponse.json(
          { error: `credentialFiles["${p}"] must be a string` },
          { status: 400 }
        );
      }
      if (Buffer.byteLength(content, "utf-8") > MAX_CREDENTIAL_FILE_BYTES) {
        return NextResponse.json(
          { error: `credentialFiles["${p}"] exceeds ${MAX_CREDENTIAL_FILE_BYTES} bytes` },
          { status: 400 }
        );
      }
      try {
        JSON.parse(content);
      } catch {
        return NextResponse.json(
          { error: `credentialFiles["${p}"] is not valid JSON` },
          { status: 400 }
        );
      }
      credFiles.set(p, content);
    }
  }

  try {
    // ---- Validate tenants ----------------------------------------------
    const rawTenants = Array.isArray(tenantsPart.tenants)
      ? (tenantsPart.tenants as unknown[])
      : [];
    if (rawTenants.length > MAX_TENANTS) {
      return NextResponse.json(
        { error: `Bundle contains more than ${MAX_TENANTS} tenants` },
        { status: 400 }
      );
    }

    interface PendingTenant extends Omit<Tenant, "credentialsFile"> {
      /** Path exactly as it appears in the bundle (keys credFiles). */
      rawPath: string;
      /** Validated form, or null when only usable via relocation. */
      credPath: string | null;
    }

    const warnings: string[] = [];
    const notes: string[] = [];
    const pending: PendingTenant[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < rawTenants.length; i++) {
      const raw = rawTenants[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return NextResponse.json(
          { error: `Tenant #${i + 1} is not an object` },
          { status: 400 }
        );
      }
      const t = raw as Record<string, unknown>;
      const name =
        typeof t.name === "string" && t.name.trim() ? t.name.trim() : null;
      if (!name || name.length > 100) {
        return NextResponse.json(
          { error: `Tenant #${i + 1} has a missing or invalid name` },
          { status: 400 }
        );
      }
      const rawPath =
        typeof t.credentialsFile === "string" ? t.credentialsFile.trim() : "";
      let credPath: string | null = null;
      try {
        credPath = validateCredentialsFilePath(rawPath);
      } catch (e) {
        // A path that's invalid HERE (Windows path on Linux, outside
        // GWS_CREDENTIALS_DIR, ...) is fine as long as the bundle carries the
        // file's content — the key gets relocated somewhere valid below.
        if (!rawPath || !credFiles.has(rawPath)) {
          const detail =
            e instanceof ValidationError ? e.message : "invalid credentialsFile";
          return NextResponse.json(
            { error: `Tenant "${name}": ${detail}` },
            { status: 400 }
          );
        }
      }
      if (!isValidEmail(t.adminEmail)) {
        return NextResponse.json(
          { error: `Tenant "${name}": adminEmail must be a valid email address` },
          { status: 400 }
        );
      }
      if (
        t.geminiApiKey !== undefined &&
        t.geminiApiKey !== "" &&
        (typeof t.geminiApiKey !== "string" || t.geminiApiKey.length > 200)
      ) {
        return NextResponse.json(
          { error: `Tenant "${name}": geminiApiKey must be a string under 200 chars` },
          { status: 400 }
        );
      }
      const color: TenantColor = TENANT_COLORS.includes(t.color as TenantColor)
        ? (t.color as TenantColor)
        : "blue";
      // Keep the bundle's ids where possible (the active-tenant pointer and
      // any external references depend on them); regenerate only when an id
      // is malformed or collides.
      let id =
        typeof t.id === "string" && ID_RE.test(t.id) ? t.id : freshId();
      while (seenIds.has(id)) id = freshId();
      seenIds.add(id);

      pending.push({
        id,
        name,
        color,
        rawPath,
        credPath,
        adminEmail: (t.adminEmail as string).toLowerCase(),
        geminiApiKey:
          typeof t.geminiApiKey === "string" && t.geminiApiKey
            ? t.geminiApiKey
            : undefined,
      });
    }

    const activeTenantId =
      typeof tenantsPart.activeTenantId === "string"
        ? tenantsPart.activeTenantId
        : null;

    // ---- Restore SSO settings -------------------------------------------
    // Validates and writes in one step, and nothing else has been written
    // yet: a malformed block fails the whole import before any side effect.
    // Secretless bundles and password-off configurations are handled inside
    // (kept / softened with a warning) so a restore can't lock the server out.
    let ssoResult: Awaited<ReturnType<typeof importSsoConfig>>;
    try {
      ssoResult = await importSsoConfig(appPart.sso ?? null);
    } catch (e) {
      if (e instanceof ValidationError) {
        return NextResponse.json(
          { error: `SSO settings in bundle: ${e.message}` },
          { status: 400 }
        );
      }
      throw e;
    }
    warnings.push(...ssoResult.warnings);

    const onboardingCompletedAt =
      typeof appPart.onboardingCompletedAt === "string"
        ? appPart.onboardingCompletedAt
        : null;

    // ---- Restore embedded key files (validation is done — safe to write) --
    const placements = new Map<string, CredentialPlacement>();
    for (const p of pending) {
      const content = credFiles.get(p.rawPath);
      if (content === undefined || placements.has(p.rawPath)) continue;
      const placement = await placeCredentialFile(p.rawPath, p.credPath, content);
      placements.set(p.rawPath, placement);
      if (placement.note) notes.push(placement.note);
      if (placement.warning) warnings.push(placement.warning);
    }
    const filesRestored = [...placements.values()].filter(
      (p) => p.restored
    ).length;

    // ---- Build final tenants --------------------------------------------
    const tenants: Tenant[] = pending.map((p) => {
      const placement = placements.get(p.rawPath);
      // credPath is always set when there's no placement — a tenant with an
      // invalid path and no embedded content was rejected above.
      const finalPath = placement ? placement.path : p.credPath!;
      if (!placement && !existsSync(finalPath)) {
        warnings.push(
          `Tenant "${p.name}": credentials file ${finalPath} does not exist on this server yet — copy the service-account JSON there before running operations.`
        );
      }
      const { rawPath: _raw, credPath: _cred, ...tenant } = p;
      void _raw;
      void _cred;
      return { ...tenant, credentialsFile: finalPath };
    });

    // ---- Persist --------------------------------------------------------
    await replaceTenantStore(tenants, activeTenantId);
    await updateAppConfig((config) => {
      // Never un-complete onboarding on import: a configured server that
      // restores a pre-wizard bundle shouldn't start prompting again.
      config.onboardingCompletedAt =
        onboardingCompletedAt ?? config.onboardingCompletedAt;
    });

    audit({
      action: "config.import",
      tenantId: null,
      tenantName: null,
      params: {
        tenantCount: tenants.length,
        ssoConfigured: Boolean(ssoResult.config),
        credentialFilesRestored: filesRestored,
        warnings: warnings.length,
      },
      outcome: "success",
    });

    return NextResponse.json({
      imported: {
        tenants: tenants.length,
        activeTenantId:
          activeTenantId && tenants.some((t) => t.id === activeTenantId)
            ? activeTenantId
            : tenants[0]?.id ?? null,
        sso: Boolean(ssoResult.config),
        ssoEnabled: Boolean(ssoResult.config?.enabled),
        credentialFiles: filesRestored,
      },
      notes,
      warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit({
      action: "config.import",
      tenantId: null,
      tenantName: null,
      params: {},
      outcome: "error",
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
