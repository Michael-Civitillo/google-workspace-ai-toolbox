"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import {
  Building2,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  AlertCircle,
  ArrowRightLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TENANT_COLORS,
  TENANT_COLOR_CLASSES,
  type Tenant,
  type TenantColor,
} from "@/lib/tenants";

interface TenantsState {
  tenants: Tenant[];
  activeTenantId: string | null;
}

interface TenantForm {
  name: string;
  color: TenantColor;
  credentialsFile: string;
  adminEmail: string;
  geminiApiKey: string;
}

const defaultForm = (): TenantForm => ({
  name: "",
  color: "blue",
  credentialsFile: "",
  adminEmail: "",
  geminiApiKey: "",
});

export default function TenantsPage() {
  const [state, setState] = useState<TenantsState>({
    tenants: [],
    activeTenantId: null,
  });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TenantForm>(defaultForm());
  const [editForm, setEditForm] = useState<TenantForm>(defaultForm());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/tenants")
      .then((r) => r.json())
      .then((data) => {
        setState({
          tenants: data.tenants ?? [],
          activeTenantId: data.activeTenantId ?? null,
        });
      })
      .catch(() => setError("Failed to load tenants"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function updateForm(
    f: TenantForm,
    setF: (v: TenantForm) => void,
    key: keyof TenantForm,
    value: string
  ) {
    setF({ ...f, [key]: value });
  }

  async function handleAdd() {
    setError(null);
    if (!form.name.trim()) return setError("Name is required");
    if (!form.credentialsFile.trim())
      return setError("Credentials file path is required");
    if (!form.adminEmail.trim()) return setError("Admin email is required");

    setSaving(true);
    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          color: form.color,
          credentialsFile: form.credentialsFile,
          adminEmail: form.adminEmail,
          geminiApiKey: form.geminiApiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error ?? "Failed to add tenant");
      setAdding(false);
      setForm(defaultForm());
      load();
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(id: string) {
    setError(null);
    if (!editForm.name.trim()) return setError("Name is required");
    if (!editForm.credentialsFile.trim())
      return setError("Credentials file path is required");
    if (!editForm.adminEmail.trim()) return setError("Admin email is required");

    setSaving(true);
    try {
      const res = await fetch(`/api/tenants/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name,
          color: editForm.color,
          credentialsFile: editForm.credentialsFile,
          adminEmail: editForm.adminEmail,
          geminiApiKey: editForm.geminiApiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error ?? "Failed to update tenant");
      setEditingId(null);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (
      !confirm(
        "Delete this tenant? This only removes it from the toolbox — no changes are made to your Google Workspace."
      )
    )
      return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tenants/${id}`, { method: "DELETE" });
      if (res.ok) {
        load();
      } else {
        const data = await res.json();
        setError(data.error ?? "Failed to delete tenant");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(id: string) {
    setSwitching(id);
    try {
      const res = await fetch(`/api/tenants/${id}/activate`, { method: "POST" });
      if (res.ok) {
        setState((prev) => ({ ...prev, activeTenantId: id }));
      }
    } finally {
      setSwitching(null);
    }
  }

  function startEdit(tenant: Tenant) {
    setEditingId(tenant.id);
    setEditForm({
      name: tenant.name,
      color: tenant.color,
      credentialsFile: tenant.credentialsFile,
      adminEmail: tenant.adminEmail,
      geminiApiKey: tenant.geminiApiKey ?? "",
    });
    setError(null);
  }

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Manage multiple Google Workspace environments and switch between them instantly."
      />

      <div className="max-w-3xl space-y-6">
        {error && (
          <Alert className="border-red-200 bg-red-50">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-800 text-sm">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {/* Tenant list */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Configured Tenants
                </CardTitle>
                <CardDescription className="mt-1">
                  Switch tenants to work in different Google Workspace
                  environments. No data carries over between tenants.
                </CardDescription>
              </div>
              {!adding && (
                <Button
                  size="sm"
                  onClick={() => {
                    setAdding(true);
                    setError(null);
                  }}
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Add Tenant
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-3">
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Loading…
              </p>
            ) : state.tenants.length === 0 && !adding ? (
              <div className="py-8 text-center">
                <Building2 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  No tenants configured yet.
                </p>
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => setAdding(true)}
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  Add your first tenant
                </Button>
              </div>
            ) : (
              state.tenants.map((tenant, idx) => {
                const tc = TENANT_COLOR_CLASSES[tenant.color as TenantColor];
                const isActive = tenant.id === state.activeTenantId;
                const isEditing = editingId === tenant.id;

                return (
                  <div key={tenant.id}>
                    {idx > 0 && <Separator className="mb-3" />}
                    {isEditing ? (
                      <TenantFormFields
                        form={editForm}
                        onChange={(key, val) =>
                          updateForm(editForm, setEditForm, key, val)
                        }
                        onSave={() => handleUpdate(tenant.id)}
                        onCancel={() => {
                          setEditingId(null);
                          setError(null);
                        }}
                        saving={saving}
                        saveLabel="Save changes"
                      />
                    ) : (
                      <div className="flex items-start gap-3">
                        <span
                          className={cn(
                            "mt-0.5 h-3 w-3 rounded-full shrink-0",
                            tc.dot
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold">
                              {tenant.name}
                            </p>
                            {isActive && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs",
                                  tc.bg,
                                  tc.text,
                                  tc.border
                                )}
                              >
                                Active
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {tenant.adminEmail}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {tenant.credentialsFile}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!isActive && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleActivate(tenant.id)}
                              disabled={switching === tenant.id}
                              className="h-8 text-xs"
                            >
                              <ArrowRightLeft className="h-3.5 w-3.5 mr-1" />
                              {switching === tenant.id
                                ? "Switching…"
                                : "Switch"}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(tenant)}
                            className="h-8 w-8 p-0"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            <span className="sr-only">Edit</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(tenant.id)}
                            className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="sr-only">Delete</span>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* Add tenant form */}
            {adding && (
              <>
                {state.tenants.length > 0 && <Separator />}
                <div>
                  <p className="text-sm font-semibold mb-3">New Tenant</p>
                  <TenantFormFields
                    form={form}
                    onChange={(key, val) =>
                      updateForm(form, setForm, key, val)
                    }
                    onSave={handleAdd}
                    onCancel={() => {
                      setAdding(false);
                      setForm(defaultForm());
                      setError(null);
                    }}
                    saving={saving}
                    saveLabel="Add tenant"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Info card */}
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                How tenant switching works
              </p>
              <ul className="space-y-1.5 list-disc list-inside">
                <li>
                  Each tenant has its own service account credentials and admin
                  email.
                </li>
                <li>
                  Switching tenants immediately changes which Google Workspace
                  environment all commands run against.
                </li>
                <li>
                  Nothing carries over — delegations, audits, and transfers
                  always target the active tenant.
                </li>
                <li>
                  The active tenant is shown at all times in the sidebar.
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function TenantFormFields({
  form,
  onChange,
  onSave,
  onCancel,
  saving,
  saveLabel,
}: {
  form: TenantForm;
  onChange: (key: keyof TenantForm, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  saveLabel: string;
}) {
  return (
    <div className="space-y-4 p-4 rounded-lg border bg-muted/30">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="t-name" className="text-xs">
            Display name <span className="text-red-500">*</span>
          </Label>
          <Input
            id="t-name"
            value={form.name}
            onChange={(e) => onChange("name", e.target.value)}
            placeholder="Production"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Color</Label>
          <div className="flex gap-1.5 pt-1">
            {TENANT_COLORS.map((color) => {
              const tc = TENANT_COLOR_CLASSES[color];
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => onChange("color", color)}
                  title={color}
                  className={cn(
                    "h-5 w-5 rounded-full transition-transform",
                    tc.dot,
                    form.color === color
                      ? "ring-2 ring-offset-1 ring-foreground scale-125"
                      : "hover:scale-110"
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-creds" className="text-xs">
          Service account JSON path <span className="text-red-500">*</span>
        </Label>
        <Input
          id="t-creds"
          value={form.credentialsFile}
          onChange={(e) => onChange("credentialsFile", e.target.value)}
          placeholder="/path/to/service-account.json"
          className="h-8 text-sm font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-admin" className="text-xs">
          Admin email <span className="text-red-500">*</span>
        </Label>
        <Input
          id="t-admin"
          type="email"
          value={form.adminEmail}
          onChange={(e) => onChange("adminEmail", e.target.value)}
          placeholder="admin@yourdomain.com"
          className="h-8 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Super admin email the service account will impersonate.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="t-gemini" className="text-xs">
          Gemini API key{" "}
          <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="t-gemini"
          value={form.geminiApiKey}
          onChange={(e) => onChange("geminiApiKey", e.target.value)}
          placeholder="Leave blank to use GOOGLE_GENERATIVE_AI_API_KEY env var"
          className="h-8 text-sm"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          <X className="h-3.5 w-3.5 mr-1.5" />
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          <Check className="h-3.5 w-3.5 mr-1.5" />
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </div>
  );
}
