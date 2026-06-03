export const YANDEX_METRIKA_COUNTER_ID = 109623512;

type MetrikaParamValue = string | number | boolean | null | undefined;
export type MetrikaGoalParams = Record<string, MetrikaParamValue>;

type YandexMetrika = (counterId: number, method: string, ...args: unknown[]) => void;

declare global {
  interface Window {
    ym?: YandexMetrika;
    dataLayer?: unknown[];
  }
}

let trackingInstalled = false;
let lastTrackedPath = "";

function safeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function safeValue(value: MetrikaParamValue) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/[a-f0-9]{16,}/g, "id")
    .replace(/[^a-z0-9_./:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || undefined;
}

function safeParams(params: MetrikaGoalParams = {}) {
  return Object.entries(params).reduce<Record<string, string | number | boolean>>((result, [key, value]) => {
    const safeParamKey = safeKey(key);
    const safeParamValue = safeValue(value);
    if (safeParamKey && safeParamValue !== undefined) result[safeParamKey] = safeParamValue;
    return result;
  }, {});
}

function metrikaReady() {
  return typeof window !== "undefined" && typeof window.ym === "function";
}

export function trackMetrikaGoal(goal: string, params: MetrikaGoalParams = {}) {
  if (!metrikaReady()) return;
  const safeGoal = safeKey(goal);
  if (!safeGoal) return;
  try {
    window.ym?.(YANDEX_METRIKA_COUNTER_ID, "reachGoal", safeGoal, safeParams(params));
  } catch {
    // Analytics must never break the app.
  }
}

export function currentAnalyticsPath() {
  if (typeof window === "undefined") return "/";
  const path = window.location.pathname || "/";
  return path
    .replace(/^\/share\/[^/?#]+/i, "/share/:token")
    .replace(/^\/f\/[^/?#]+/i, "/f/:token")
    .replace(/^\/u\/[^/?#]+/i, "/u/:slug");
}

export function analyticsEndpoint(path: string) {
  try {
    const url = new URL(path, window.location.origin);
    return url.pathname
      .replace(/\/[a-z0-9_-]{8,}(?=\/|$)/gi, "/:id")
      .replace(/\/[0-9]+(?=\/|$)/g, "/:id")
      .slice(0, 120);
  } catch {
    return "unknown";
  }
}

function routeKind(path = currentAnalyticsPath()) {
  if (path.startsWith("/share/")) return "shared_chat";
  if (path.startsWith("/f/")) return "shared_file";
  if (path.startsWith("/u/")) return "public_profile";
  if (path.replace(/\/+$/g, "") === "/admin") return "admin";
  return "app";
}

export function trackMetrikaHit(params: MetrikaGoalParams = {}) {
  if (!metrikaReady()) return;
  const path = currentAnalyticsPath();
  if (path === lastTrackedPath) return;
  lastTrackedPath = path;
  try {
    window.ym?.(YANDEX_METRIKA_COUNTER_ID, "hit", path, {
      params: safeParams({ ...params, route_kind: routeKind(path) })
    });
  } catch {
    // Analytics must never break the app.
  }
}

function targetElement(event: Event) {
  return event.target instanceof Element ? event.target : null;
}

function compactClassName(element: Element) {
  return (element.getAttribute("class") || "")
    .split(/\s+/)
    .map((item) => safeKey(item))
    .filter((item) => item && !["active", "disabled", "open", "spin", "loading"].includes(item))
    .slice(0, 3)
    .join(".");
}

function elementControl(element: Element) {
  const explicit = safeKey(element.getAttribute("data-metrika") || element.getAttribute("data-analytics") || "");
  if (explicit) return explicit;
  const className = compactClassName(element);
  if (className) return className;
  if (element instanceof HTMLInputElement && element.type) return `input_${safeKey(element.type)}`;
  return safeKey(element.getAttribute("role") || element.tagName.toLowerCase()) || "control";
}

function elementKind(element: Element) {
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLInputElement) return `input_${safeKey(element.type || "text")}`;
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLTextAreaElement) return "textarea";
  return safeKey(element.getAttribute("role") || element.tagName.toLowerCase()) || "element";
}

function formControl(form: HTMLFormElement | null) {
  if (!form) return undefined;
  return compactClassName(form) || safeKey(form.getAttribute("name") || form.id || "form");
}

function linkKind(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute("href") || "";
  if (!href) return "empty";
  if (href.startsWith("#")) return "anchor";
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin ? "internal" : "external";
  } catch {
    return "unknown";
  }
}

function isDownloadLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute("href") || "";
  return Boolean(anchor.download)
    || /\/download(?:[/?#]|$)/i.test(href)
    || /\.(zip|tar|gz|rar|7z|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|svg)(?:[?#].*)?$/i.test(href);
}

function trackControlClick(event: MouseEvent) {
  const element = targetElement(event)?.closest("button,a,input,[role='button'],[role='menuitem']");
  if (!element) return;
  const params: MetrikaGoalParams = {
    control: elementControl(element),
    kind: elementKind(element),
    route_kind: routeKind(),
    form: formControl(element.closest("form"))
  };
  if (element instanceof HTMLAnchorElement) {
    params.link_kind = linkKind(element);
    if (isDownloadLink(element)) trackMetrikaGoal("file_download", params);
  }
  trackMetrikaGoal("ui_click", params);
}

function trackFormSubmit(event: SubmitEvent) {
  const form = targetElement(event)?.closest("form");
  if (!form) return;
  const submitter = event.submitter instanceof Element ? event.submitter : null;
  trackMetrikaGoal("form_submit", {
    form: formControl(form),
    submitter: submitter ? elementControl(submitter) : undefined,
    route_kind: routeKind()
  });
}

function trackControlChange(event: Event) {
  const element = targetElement(event)?.closest("select,input");
  if (!element) return;
  if (element instanceof HTMLInputElement) {
    const type = (element.type || "text").toLowerCase();
    if (!["checkbox", "radio", "range", "color", "file"].includes(type)) return;
    trackMetrikaGoal("ui_change", {
      control: elementControl(element),
      kind: elementKind(element),
      route_kind: routeKind(),
      checked: type === "checkbox" || type === "radio" ? element.checked : undefined,
      files_count: type === "file" ? element.files?.length ?? 0 : undefined
    });
    return;
  }
  trackMetrikaGoal("ui_change", {
    control: elementControl(element),
    kind: elementKind(element),
    route_kind: routeKind()
  });
}

function trackLocationChange(source: string) {
  window.setTimeout(() => trackMetrikaHit({ source }), 0);
}

function installHistoryTracking() {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;
  window.history.pushState = function pushState(...args: Parameters<History["pushState"]>) {
    const result = originalPushState.apply(this, args);
    trackLocationChange("push_state");
    return result;
  };
  window.history.replaceState = function replaceState(...args: Parameters<History["replaceState"]>) {
    const result = originalReplaceState.apply(this, args);
    trackLocationChange("replace_state");
    return result;
  };
}

function trackClientError(kind: string, error: unknown) {
  const errorName = error instanceof Error ? error.name : typeof error;
  trackMetrikaGoal("client_error", {
    kind,
    error_name: errorName || "unknown",
    route_kind: routeKind()
  });
}

export function installMetrikaEventTracking() {
  if (trackingInstalled || typeof window === "undefined") return;
  trackingInstalled = true;
  window.dataLayer = window.dataLayer || [];

  document.addEventListener("click", trackControlClick, true);
  document.addEventListener("submit", (event) => trackFormSubmit(event as SubmitEvent), true);
  document.addEventListener("change", trackControlChange, true);
  window.addEventListener("popstate", () => trackLocationChange("popstate"));
  window.addEventListener("online", () => trackMetrikaGoal("browser_online", { route_kind: routeKind() }));
  window.addEventListener("offline", () => trackMetrikaGoal("browser_offline", { route_kind: routeKind() }));
  window.addEventListener("appinstalled", () => trackMetrikaGoal("pwa_installed", { route_kind: routeKind() }));
  window.addEventListener("beforeinstallprompt", () => trackMetrikaGoal("pwa_install_prompt", { route_kind: routeKind() }));
  window.addEventListener("error", (event) => trackClientError("error", event.error));
  window.addEventListener("unhandledrejection", (event) => trackClientError("unhandledrejection", event.reason));
  document.addEventListener("visibilitychange", () => {
    trackMetrikaGoal(document.visibilityState === "visible" ? "page_visible" : "page_hidden", {
      route_kind: routeKind()
    });
  });

  installHistoryTracking();
  lastTrackedPath = currentAnalyticsPath();
  trackMetrikaGoal("app_loaded", { route_kind: routeKind() });
}
