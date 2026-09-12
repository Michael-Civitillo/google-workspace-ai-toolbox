import type { Metadata } from "next";
import { headers } from "next/headers";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar";
import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { TenantBootstrap } from "@/components/tenant-bootstrap";
import { OnboardingRedirect } from "@/components/onboarding-redirect";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Google Workspace Open Admin",
  description: "Modern web UI for day-to-day Google Workspace admin tasks",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The nonce the proxy minted for this request (src/proxy.ts). Reading a
  // header also keeps every page rendering per request, which a nonce policy
  // needs: a page cached from an earlier build would carry a stale one.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply theme before first paint to avoid flash */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t===null&&d))document.documentElement.classList.add('dark');})()`,
          }}
        />
      </head>
      <body className="min-h-full flex">
        <ThemeProvider>
          <TooltipProvider>
            <TenantBootstrap />
            <OnboardingRedirect />
            <Sidebar />
            <AppShell>{children}</AppShell>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
