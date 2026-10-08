import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { session, loading } = useAuth();
  // The mobile gateway host has no console: its front page is the access form.
  if (typeof window !== "undefined" && window.location.hostname.startsWith("mobile.")) {
    return <Navigate to="/access" />;
  }
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="font-mono text-sm text-muted-foreground">booting…</div>
      </div>
    );
  }
  return <Navigate to={session ? "/dashboard" : "/auth"} />;
}
