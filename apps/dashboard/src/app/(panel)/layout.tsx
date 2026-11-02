import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { UpdateBanner } from "@/components/layout/UpdateBanner";

/**
 * Panel layout — wraps all authenticated dashboard pages.
 * Desktop: fixed sidebar (w-64) + header + scrollable main content.
 * Mobile: sidebar hidden, accessible via hamburger menu in header.
 *
 * Auth guard: checks for session cookie server-side and validates
 * against the API. Redirects to /login if not authenticated.
 */
export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("vexlyx_session");

  if (!sessionCookie) {
    redirect("/login");
  }

  // Validate session against the API
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

  try {
    const response = await fetch(`${apiUrl}/api/auth/me`, {
      headers: {
        Cookie: `vexlyx_session=${sessionCookie.value}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      redirect("/login");
    }
  } catch {
    redirect("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar — hidden on mobile */}
      <aside className="hidden md:flex">
        <Sidebar />
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <UpdateBanner />
        <main className="flex-1 overflow-y-auto px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
