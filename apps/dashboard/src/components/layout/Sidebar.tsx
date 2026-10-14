"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  Globe,
  Database,
  Mail,
  Activity,
  Archive,
  Shield,
  Server,
  Settings,
  Users,
  ScrollText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/useAuth";

/**
 * Navigation items for the sidebar.
 * Each item maps to a route under the (panel) route group.
 * `roles` restricts an item to specific roles; omit for everyone.
 */
const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", href: "/projects", icon: FolderKanban },
  { label: "Domains", href: "/domains", icon: Globe },
  { label: "Databases", href: "/databases", icon: Database },
  { label: "Mail", href: "/mail", icon: Mail },
  { label: "Monitoring", href: "/monitoring", icon: Activity, roles: ["ADMIN"] },
  { label: "Backups", href: "/backups", icon: Archive, roles: ["ADMIN"] },
  { label: "Firewall", href: "/firewall", icon: Shield, roles: ["ADMIN"] },
  { label: "Services", href: "/services", icon: Server, roles: ["ADMIN"] },
  { label: "Users", href: "/users", icon: Users, roles: ["ADMIN", "RESELLER"] },
  { label: "Audit Log", href: "/audit-log", icon: ScrollText, roles: ["ADMIN"] },
];

const bottomNavItems = [
  { label: "Settings", href: "/settings", icon: Settings },
];

/**
 * Sidebar navigation component.
 * Renders the Vexlyx logo, main nav links, and settings at the bottom.
 * Active state uses indigo highlight per CLAUDE.md Section 15.
 *
 * Used directly on desktop and wrapped in a Sheet for mobile.
 */
export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const visibleNavItems = navItems.filter((item) => !item.roles || item.roles.includes(user?.role ?? ""));

  return (
    <div className="flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo */}
      <div className="flex h-14 items-center px-6">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-bold text-primary-foreground">V</span>
          </div>
          <span className="text-lg font-semibold tracking-tight text-sidebar-foreground">
            Vexlyx
          </span>
        </Link>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Main navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {visibleNavItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                isActive
                  ? "bg-sidebar-accent text-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Bottom navigation */}
      <nav className="space-y-1 px-3 py-4">
        {bottomNavItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                isActive
                  ? "bg-sidebar-accent text-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
