// Single source of truth for primary navigation.
//
// The sidebar (app-shell), the ⌘K command palette, and the vim `g`-then-key
// shortcuts all derive from this list, so they can never drift out of sync.
// `to` is typed against the router, so a typo or a removed route fails
// typecheck instead of shipping a dead link.
import type { LinkProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Rocket,
  AlertTriangle,
  ShieldAlert,
  ArrowRightLeft,
  BarChart3,
  Bell,
  Boxes,
  Bot,
  Briefcase,
  Building2,
  CalendarClock,
  LifeBuoy,
  CheckCircle2,
  Cloud,
  Crown,
  Coins,
  FileSignature,
  Gauge,
  GitFork,
  Handshake,
  KeyRound,
  LayoutDashboard,
  Newspaper,
  Palette,
  Phone,
  PhoneOutgoing,
  Route,
  Receipt,
  ShieldAlert as GateIcon,
  ReceiptText,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Tags,
  Target,
  TreePine,
  UserPlus,
  Users,
  Waves,
  PhoneCall,
} from "lucide-react";

export type NavItem = {
  to: LinkProps["to"];
  label: string;
  icon: LucideIcon;
  /** Extra search terms for the command palette fuzzy match. */
  keywords?: string;
  /** Single key for the `g`-then-key vim shortcut (must be unique). */
  shortcut?: string;
};

export type NavSection = {
  heading: string;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    heading: "Fleet",
    items: [
      {
        to: "/dashboard",
        label: "Fleet",
        icon: LayoutDashboard,
        shortcut: "d",
        keywords: "overview clones home",
      },
      {
        to: "/clones/new",
        label: "New Clone",
        icon: GitFork,
        keywords: "create provision fork template",
      },
      {
        to: "/fleet/deployments",
        label: "Deployments",
        icon: Rocket,
        keywords: "vercel hosting domains build live subdomain",
      },
      { to: "/modules", label: "Modules", icon: Boxes, shortcut: "m" },
      {
        to: "/cascades",
        label: "Cascades",
        icon: Waves,
        shortcut: "c",
        keywords: "push update pull request",
      },
      {
        to: "/schedules",
        label: "Schedules",
        icon: CalendarClock,
        shortcut: "s",
        keywords: "cron recurring",
      },
      { to: "/drift", label: "Drift", icon: Sparkles, shortcut: "r", keywords: "ai suggestions" },
      { to: "/branding", label: "Branding", icon: Palette, shortcut: "b" },
      {
        to: "/fleet-manager",
        label: "AI Manager",
        icon: Bot,
        shortcut: "f",
        keywords: "assistant",
      },
      {
        to: "/yggdrasil",
        label: "Yggdrasil",
        icon: TreePine,
        shortcut: "y",
        keywords: "tree visualization graph",
      },
    ],
  },
  {
    heading: "Observability",
    items: [
      { to: "/health", label: "Health", icon: Activity, shortcut: "h", keywords: "uptime status" },
      { to: "/metrics", label: "Metrics", icon: BarChart3, shortcut: "i" },
      { to: "/slo", label: "SLO", icon: Target, shortcut: "l", keywords: "service level" },
      { to: "/digests", label: "Digests", icon: Newspaper, shortcut: "g" },
      { to: "/report-jobs", label: "Report Jobs", icon: Receipt, keywords: "reports export" },
      {
        to: "/audit-log",
        label: "Audit Log",
        icon: ScrollText,
        shortcut: "a",
        keywords: "activity history",
      },
      {
        to: "/oversight",
        label: "Oversight",
        icon: Crown,
        shortcut: "o",
        keywords: "high king sovereign tiers actions",
      },
      {
        to: "/route-errors",
        label: "Route Errors",
        icon: AlertTriangle,
        keywords: "crashes telemetry",
      },
    ],
  },
  {
    heading: "Security",
    items: [
      {
        to: "/security",
        label: "Security Overview",
        icon: ShieldCheck,
        keywords: "codex summary posture mttr open findings dashboard",
      },
      {
        to: "/security/scans",
        label: "Scans & Findings",
        icon: ShieldAlert,
        keywords: "codex scan finding remediation pr autonomous",
      },
      {
        to: "/approvals",
        label: "Approvals",
        icon: CheckCircle2,
        shortcut: "q",
        keywords: "queue review merge two-key",
      },
      {
        to: "/support/tickets",
        label: "Support Ops",
        icon: LifeBuoy,
        shortcut: "t",
        keywords: "tickets p0 p1 p2 sla self-healing remediation validation portal",
      },
      {
        to: "/security/intake",
        label: "Intake Sources",
        icon: Shield,
        keywords: "scanner webhook hmac codex snyk semgrep ticketing linear jira",
      },
      {
        to: "/security-partners",
        label: "Security Partners",
        icon: ShieldCheck,
        keywords: "pentest ec-council assessment",
      },
      { to: "/fleet/edge", label: "Edge Security", icon: Shield, keywords: "waf posture" },
      {
        to: "/cloudflare",
        label: "Cloudflare",
        icon: Cloud,
        shortcut: "e",
        keywords: "wrapper cdn",
      },
    ],
  },
  {
    heading: "Voice",
    items: [
      {
        to: "/voice/calls",
        label: "Call Logs",
        icon: Phone,
        shortcut: "v",
        keywords: "vapi calls transcripts recordings live monitor blacklist sentiment squad",
      },
      {
        to: "/voice/phone",
        label: "Phone",
        icon: PhoneCall,
        keywords: "softphone dial call twilio telephony inbound outbound operator",
      },
      {
        to: "/voice/agents",
        label: "Voice Agents",
        icon: Bot,
        keywords: "vapi assistants squads phone numbers campaign rules cadence",
      },
      {
        to: "/voice/outbound",
        label: "Outbound Queue",
        icon: PhoneOutgoing,
        keywords: "dispatch scheduled calls jobs retries follow up no show reminder",
      },
    ],
  },
  {
    heading: "Clients",
    items: [
      {
        to: "/crm",
        label: "CRM Overview",
        icon: Briefcase,
        shortcut: "k",
        keywords: "clients accounts lifecycle mrr health churn",
      },
      {
        to: "/crm/accounts",
        label: "Accounts",
        icon: Building2,
        keywords: "clients organisations companies",
      },
      {
        to: "/crm/deals",
        label: "Deals",
        icon: Target,
        keywords: "pipeline opportunities forecast",
      },
      {
        to: "/crm/fit",
        label: "Fit Analysis",
        icon: Gauge,
        keywords: "compatibility score grade ai qualification client fit",
      },

      {
        to: "/crm/tickets",
        label: "Tickets & Disputes",
        icon: LifeBuoy,
        keywords: "support issues sla chargeback refund",
      },
      {
        to: "/crm/journey",
        label: "Client Journey",
        icon: Route,
        shortcut: "j",
        keywords: "tracker pipeline stages kanban follow up appointments voice triggers",
      },
      { to: "/leads", label: "Leads", icon: UserPlus, keywords: "waitlist inbound capture" },
      {
        to: "/agreements",
        label: "Agreements",
        icon: FileSignature,
        keywords: "sla service level agreement docusign contract sign envelope signature",
      },
    ],
  },
  {
    heading: "Growth",
    items: [
      { to: "/handoffs", label: "Handoffs", icon: ArrowRightLeft, keywords: "client transfer" },
      { to: "/partner-portal", label: "Partner Portal", icon: Handshake, keywords: "resellers" },
    ],
  },

  {
    heading: "Billing",
    items: [
      { to: "/billing/seats", label: "Seats", icon: Users },
      { to: "/billing/purchases", label: "Purchases", icon: ShoppingCart },
      {
        to: "/billing/invoices",
        label: "Invoices",
        icon: ReceiptText,
        keywords: "invoice pdf receipts wallet cards payment methods",
      },
      {
        to: "/billing/catalog",
        label: "Pricing Catalog",
        icon: Tags,
        keywords: "prices plans packs",
      },
      {
        to: "/billing/api-usage",
        label: "API Usage",
        icon: KeyRound,
        keywords: "api keys metering piggyback byok openai resend vendor spend recharge",
      },
      { to: "/billing/topup", label: "Top-up", icon: Coins, keywords: "tokens credits" },
      {
        to: "/billing/gates",
        label: "Payment Gates",
        icon: GateIcon,
        keywords:
          "activation gate lock unlock clone access grace period trial countdown 72 hours paid unpaid stripe",
      },
    ],
  },
  {
    heading: "System",
    items: [
      { to: "/notifications", label: "Notifications", icon: Bell, shortcut: "n" },
      { to: "/settings", label: "Settings", icon: Settings, keywords: "configuration preferences" },
    ],
  },
];

/** Flattened list of every nav item, in section order. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** `g`-then-key shortcut map, keyed by the single shortcut char. */
export const NAV_SHORTCUTS: Record<string, NavItem> = Object.fromEntries(
  NAV_ITEMS.filter((item) => item.shortcut).map((item) => [item.shortcut as string, item]),
);
