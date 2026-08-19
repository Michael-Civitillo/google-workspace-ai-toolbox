import { existsSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAppConfig, updateAppConfig } from "@/lib/app-config";
import { replaceTenantStore } from "@/lib/tenants-server";
import { parseOidcSettingsInput } from "@/lib/sso-validate";
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

// A bundle is settings + tenant metadata, no key material — 1 MB is generous.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TENANTS = 500;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function freshId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Import a configuration bundle produced by GET /api/config/export.
 *
 * Replace semantics: the bundle becomes the new tenant list and SSO config —
 * this is a restore, not a merge. Two deliberate softenings:
 *   - If the bundle was exported without secrets, the current OIDC client
 *     secret is preserved when the bundle points at the same issuer+client.
 *   - Credential file paths are validated for shape but NOT required to exist
 *     (that's normal when moving servers); missing files come back as
 *     warnings so the operator knows what to copy over.
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

    const warnings: string[] = [];
    const tenants: Tenant[] = [];
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
      let credPath: string;
      try {
        credPath = validateCredentialsFilePath(t.credentialsFile);
      } catch (e) {
        const detail =
          e instanceof ValidationError ? e.message : "invalid credentialsFile";
        return NextResponse.json(
          { error: `Tenant "${name}": ${detail}` },
          { status: 400 }
        );
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

      if (!existsSync(credPath)) {
        warnings.push(
          `Tenant "${name}": credentials file ${credPath} does not exist on this server yet — copy the service-account JSON there before running operations.`
        );
      }

      tenants.push({
        id,
        name,
        color,
        credentialsFile: credPath,
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

    // ---- Validate SSO settings ------------------------------------------
    const existingSso = getAppConfig().sso;
    const rawSso = appPart.sso ?? null;
    let existingSecret: string | undefined;
    if (
      rawSso &&
      typeof rawSso === "object" &&
      existingSso &&
      (rawSso as Record<string, unknown>).issuer === existingSso.issuer &&
      (rawSso as Record<string, unknown>).clientId === existingSso.clientId
    ) {
      existingSecret = existingSso.clientSecret;
    }
    const parsedSso = parseOidcSettingsInput(rawSso, { existingSecret });
    if (parsedSso.error) {
      return NextResponse.json(
        { error: `SSO settings in bundle: ${parsedSso.error}` },
        { status: 400 }
      );
    }
    if (parsedSso.settings?.enabled && !parsedSso.settings.clientSecret) {
      warnings.push(
        "The bundle was exported without secrets — re-enter the OIDC client secret in App Settings (or use a PKCE-only public client)."
      );
    }

    const onboardingCompletedAt =
      typeof appPart.onboardingCompletedAt === "string"
        ? appPart.onboardingCompletedAt
        : null;

    // ---- Persist --------------------------------------------------------
    await replaceTenantStore(tenants, activeTenantId);
    await updateAppConfig((config) => {
      config.sso = parsedSso.settings;
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
        ssoConfigured: Boolean(parsedSso.settings),
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
        sso: Boolean(parsedSso.settings),
        ssoEnabled: Boolean(parsedSso.settings?.enabled),
      },
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
