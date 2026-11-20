// Standalone replacement for the browser side of `@hatch/space-sdk/client`
// (a Muse-internal package that is not on npm and must not be vendored).
//
// The app used four things from it:
//   - `createActionClient` — a typed proxy that POSTs `{ action, args }`
//     to `./actions` and returns the `data` field. Here it posts to the
//     same-origin `/actions` endpoint served by `server/src/index.ts`.
//   - `ApiRequest` / `ApiResponse` — types derived from the action
//     function signatures.
//   - `spaceQueryClient` — the shared TanStack Query client (conservative
//     defaults: no refetch on window focus, 30s stale time, one retry).
//   - `SafeAreaTopScrim` / `setFailureNoticeText` — a top safe-area
//     scrim and the wording for the automatic save-failure notice shown
//     when a mutation has no `onError` of its own.
//
// Only public npm packages are needed here: `@tanstack/react-query`
// and `react`.

import { createElement, type CSSProperties } from "react";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import type { z } from "zod";

/** Error thrown when an action call fails; carries the HTTP status. */
export class ActionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ActionError";
    this.status = status;
  }
}

type ActionMap = Record<
  string,
  { request: z.ZodTypeAny; response: z.ZodTypeAny }
>;

type ActionClient<T extends ActionMap> = {
  [K in keyof T]: (
    args: z.infer<T[K]["request"]>,
  ) => Promise<z.infer<T[K]["response"]>>;
};

export function createActionClient<T extends ActionMap>(): ActionClient<T> {
  return new Proxy(
    {},
    {
      get(_target, name) {
        // Symbol keys and promise-protocol names must not resolve to a
        // phantom action (same hazard the SDK guarded against).
        if (typeof name !== "string") return undefined;
        if (name === "then" || name === "catch" || name === "finally") {
          return undefined;
        }
        return async (args: unknown) => {
          const response = await fetch("/actions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: name, args: args ?? {} }),
          });
          const body = (await response.json().catch(() => ({}))) as {
            data?: unknown;
            error?: unknown;
          };
          if (!response.ok) {
            throw new ActionError(
              typeof body?.error === "string"
                ? body.error
                : `请求失败（HTTP ${response.status}）`,
              response.status,
            );
          }
          if (body && typeof body === "object" && body.error) {
            throw new ActionError(String(body.error), response.status);
          }
          return body.data;
        };
      },
    },
  ) as ActionClient<T>;
}

export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

// --- Failure notice -------------------------------------------------------

const NOTICE_ID = "nbn-plan-monitor-failure-notice";
const VISIBLE_MS = 6_000;
const FALLBACK = "操作没成功，请重试。";

let hideTimer: ReturnType<typeof setTimeout> | undefined;
let pageText:
  | ((error: unknown, message: string) => string | null | undefined)
  | undefined;

/** Lets a page word the automatic save-failure notice in its own language. */
export function setFailureNoticeText(
  text: (error: unknown, message: string) => string | null | undefined,
): void {
  pageText = text;
}

/** Shows an error's readable message at the bottom of the page briefly. */
export function showFailureNotice(error: unknown): void {
  if (typeof document === "undefined" || document.body === null) return;
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : FALLBACK;
  let text: string | null | undefined;
  try {
    text = pageText?.(error, message);
  } catch {
    text = undefined;
  }
  if (text === null || text === "") return;
  const shown = text ?? message;
  let notice = document.getElementById(NOTICE_ID);
  if (notice === null) {
    notice = document.createElement("div");
    notice.id = NOTICE_ID;
    notice.setAttribute("role", "alert");
    Object.assign(notice.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "100",
      maxWidth: "calc(100vw - 32px)",
      background: "#14232e",
      color: "#fff",
      padding: "10px 16px",
      borderRadius: "8px",
      fontSize: "14px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    });
    document.body.appendChild(notice);
  }
  notice.textContent = shown;
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => notice?.remove(), VISIBLE_MS);
}

export const spaceQueryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (
        mutation.options.onError === undefined &&
        mutation.options.onSettled === undefined
      ) {
        showFailureNotice(error);
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// --- Safe-area scrim -------------------------------------------------------
// Fixed top safe-area protection (same geometry the SDK component used:
// covers the device status-bar inset with a small fade that collapses to
// zero on desktop).

const TOP_SAFE_AREA_SCRIM_HEIGHT =
  "calc(var(--twsa-safe-area-inset-top) + min(2rem, var(--twsa-safe-area-inset-top)))";
const TOP_SAFE_AREA_GRADIENT_MASK =
  "linear-gradient(to bottom, rgba(0, 0, 0, 1) 0%, rgba(0, 0, 0, 0.99) 10%, rgba(0, 0, 0, 0.96) 20%, rgba(0, 0, 0, 0.90) 30%, rgba(0, 0, 0, 0.80) 40%, rgba(0, 0, 0, 0.67) 50%, rgba(0, 0, 0, 0.52) 60%, rgba(0, 0, 0, 0.36) 70%, rgba(0, 0, 0, 0.20) 80%, rgba(0, 0, 0, 0.08) 90%, rgba(0, 0, 0, 0) 100%)";

export function SafeAreaTopScrim({
  variant = "gradient",
  backgroundColor,
  zIndex = 40,
  className,
  style,
  ...props
}: {
  variant?: "gradient" | "blur" | "solid";
  backgroundColor?: string;
  zIndex?: number;
  className?: string;
  style?: CSSProperties;
  [key: string]: unknown;
}) {
  const resolvedBackgroundColor =
    backgroundColor ?? style?.backgroundColor ?? "var(--bg)";
  const managedStyle: CSSProperties = {
    ...style,
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex,
    pointerEvents: "none",
    height:
      variant === "gradient"
        ? TOP_SAFE_AREA_SCRIM_HEIGHT
        : "var(--twsa-safe-area-inset-top)",
    backgroundColor: resolvedBackgroundColor,
  };
  if (variant === "gradient") {
    managedStyle.maskImage = TOP_SAFE_AREA_GRADIENT_MASK;
    managedStyle.WebkitMaskImage = TOP_SAFE_AREA_GRADIENT_MASK;
  } else if (variant === "blur") {
    managedStyle.backdropFilter = style?.backdropFilter ?? "blur(12px)";
    managedStyle.WebkitBackdropFilter =
      style?.WebkitBackdropFilter ?? "blur(12px)";
  }
  return createElement("div", {
    ...props,
    "aria-hidden": (props["aria-hidden"] as boolean | undefined) ?? true,
    className,
    style: managedStyle,
  });
}
