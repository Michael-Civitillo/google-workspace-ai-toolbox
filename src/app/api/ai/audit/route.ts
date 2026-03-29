import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { getModel } from "@/lib/ai";
import { gws } from "@/lib/gws";

/**
 * Run an AI-powered audit for a user — pulls from multiple APIs
 * and returns a plain-English summary.
 *
 * POST /api/ai/audit
 * Body: { user: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await request.json();

    if (!user) {
      return NextResponse.json(
        { error: "user is required" },
        { status: 400 }
      );
    }

    // Fetch data from multiple sources in parallel
    const [emailDelegates, calendarAcl, labels] = await Promise.all([
      gws([
        "gmail",
        "users",
        "settings",
        "delegates",
        "list",
        `--userId=${user}`,
      ]),
      gws(["calendar", "acl", "list", `--calendarId=${user}`]),
      gws(["gmail", "users", "labels", "list", `--userId=${user}`]),
    ]);

    // Also try to get forwarding info
    const forwarding = await gws([
      "gmail",
      "users",
      "settings",
      "getAutoForwarding",
      `--userId=${user}`,
    ]);

    const rawData = {
      emailDelegates: emailDelegates.success
        ? emailDelegates.data
        : { error: emailDelegates.error },
      calendarAcl: calendarAcl.success
        ? calendarAcl.data
        : { error: calendarAcl.error },
      emailLabels: labels.success
        ? labels.data
        : { error: labels.error },
      autoForwarding: forwarding.success
        ? forwarding.data
        : { error: forwarding.error },
    };

    // Use AI to generate a human-readable summary
    const { text: summary } = await generateText({
      model: getModel(),
      prompt: `You are a Google Workspace admin assistant. Analyze the following data for the user "${user}" and provide a clear, well-organized audit summary.

Raw API data:
${JSON.stringify(rawData, null, 2)}

Write a concise audit report covering:
1. **Email Delegates** — Who has access to this mailbox? What's their verification status?
2. **Calendar Sharing** — Who can see or edit this user's calendar? What permission level does each person have?
3. **Email Forwarding** — Is auto-forwarding enabled? Where is mail being forwarded to?
4. **Mailbox Overview** — How many labels/folders exist? Anything notable?
5. **Security Concerns** — Flag anything that looks unusual (e.g., forwarding to external domains, owner-level calendar access to unexpected users, unverified delegates)

If any API calls failed, mention that the data wasn't available and why.

Keep it admin-friendly — brief, scannable, use bullet points. No fluff.`,
    });

    return NextResponse.json({
      success: true,
      data: {
        user,
        summary,
        raw: rawData,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run audit";
    return NextResponse.json({ success: false, error: message });
  }
}
