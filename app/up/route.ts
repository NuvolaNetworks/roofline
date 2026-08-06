// ALB health check target. Dependency-free and unauthenticated on purpose —
// the platform hardens target groups to /up (never the heavy homepage).
export function GET() {
  return new Response("ok");
}
