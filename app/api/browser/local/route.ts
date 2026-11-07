import { openLocalBrowserPage, watchLocalBrowser } from "@/lib/server/local-browser";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return watchLocalBrowser(request, new URL(request.url).searchParams.get("bot") ?? "");
}

export function POST(request: Request) {
  return openLocalBrowserPage(request);
}
