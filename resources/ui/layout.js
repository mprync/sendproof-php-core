import { formatNumber, t } from "./i18n.js";

const DESKTOP_BREAKPOINT = 56;
const SIDEBAR_MIN_REM = 14;
const SIDEBAR_MAX_REM = 24;
const PANE_MIN_REM = 18;
const KEYBOARD_STEP_REM = 1;

const cssPixels = (value) => Number.parseFloat(value) || 0;

export function clampTrack(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function keyboardTrackValue(value, key, minimum, maximum, step) {
  if (key === "Home") return minimum;
  if (key === "End") return maximum;
  const multiplier = key === "PageUp" || key === "PageDown" ? 4 : 1;
  const direction =
    key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp" ? -1 : 1;
  return clampTrack(value + direction * step * multiplier, minimum, maximum);
}

/** Add desktop splitters while leaving the mobile drawer and view switcher intact. */
export function createLayout(workspace, preferenceKey) {
  const handles = [...workspace.querySelectorAll("[data-layout-divider]")];
  const sidebar = workspace.querySelector(".sidebar");
  // The main column is whichever pane is showing (Try it's request, or a reading pane), so the
  // divider is shared by every view.
  const mainPane = () => workspace.querySelector(":scope > .pane:not([hidden])");
  let resizing = null;
  let resizeObserver;
  const storageKey = preferenceKey && `sendproof-layout:${preferenceKey}`;
  let saved;
  if (storageKey) {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (Number.isFinite(value?.sidebar) && Number.isFinite(value?.request)) saved = value;
    } catch { /* A stored preference can be invalid or inaccessible. */ }
  }

  const isDesktop = () =>
    typeof window === "undefined" ||
    window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}rem)`).matches;

  const rootFontSize = () =>
    cssPixels(getComputedStyle(document.documentElement).fontSize) || 16;

  const measurements = () => {
    const workspaceWidth = workspace.getBoundingClientRect().width;
    const rem = rootFontSize();
    const sidebarWidth = sidebar.getBoundingClientRect().width;
    const requestWidth = mainPane()?.getBoundingClientRect().width ?? 0;
    const paneMinimum = Math.max(
      PANE_MIN_REM * rem,
      Math.min(24 * rem, workspaceWidth * 0.25),
    );
    const sidebarMinimum = SIDEBAR_MIN_REM * rem;
    const sidebarMaximum = Math.min(
      SIDEBAR_MAX_REM * rem,
      workspaceWidth - paneMinimum * 2,
    );
    const currentSidebar = clampTrack(
      sidebarWidth,
      sidebarMinimum,
      sidebarMaximum,
    );
    const requestMinimum = paneMinimum;
    const requestMaximum = workspaceWidth - currentSidebar - paneMinimum;
    return {
      workspaceWidth,
      rem,
      sidebarWidth: currentSidebar,
      requestWidth: clampTrack(requestWidth, requestMinimum, requestMaximum),
      sidebarMinimum,
      sidebarMaximum,
      requestMinimum,
      requestMaximum,
    };
  };

  const updateHandle = (handle, value, minimum, maximum) => {
    handle.setAttribute("aria-valuemin", String(Math.round(minimum)));
    handle.setAttribute("aria-valuemax", String(Math.round(maximum)));
    handle.setAttribute("aria-valuenow", String(Math.round(value)));
    const px = formatNumber(Math.round(value));
    handle.setAttribute("aria-valuetext", t("shell.pixels", { px }));
    // Dividers are placed from the inline start, so they sit correctly in right-to-left layouts.
    if (handle.style) handle.style.insetInlineStart = `${Math.round(handle === handles[0] ? value : value + sidebar.getBoundingClientRect().width)}px`;
    const tip = handle.querySelector?.(".size-tip");
    if (tip) tip.textContent = t("shell.sizeTip", { px });
  };

  const apply = (sidebarWidth, requestWidth) => {
    const metrics = measurements();
    const nextSidebar = clampTrack(
      sidebarWidth,
      metrics.sidebarMinimum,
      metrics.sidebarMaximum,
    );
    const nextRequest = clampTrack(
      requestWidth,
      metrics.requestMinimum,
      metrics.workspaceWidth - nextSidebar - metrics.requestMinimum,
    );
    workspace.style.setProperty("--sidebar-width", `${nextSidebar}px`);
    workspace.style.setProperty("--request-width", `${nextRequest}px`);
    updateHandle(
      handles[0],
      nextSidebar,
      metrics.sidebarMinimum,
      metrics.sidebarMaximum,
    );
    updateHandle(
      handles[1],
      nextRequest,
      metrics.requestMinimum,
      metrics.workspaceWidth - nextSidebar - metrics.requestMinimum,
    );
  };

  const sync = () => {
    if (!isDesktop()) return;
    if (workspace.dataset?.sidebar === "closed") {
      const divider = handles[1];
      if (divider.style) divider.style.insetInlineStart = `${Math.round(mainPane()?.getBoundingClientRect().width ?? 0)}px`;
      return;
    }
    const metrics = measurements();
    if (saved) {
      const side = clampTrack(saved.sidebar * metrics.rem, metrics.sidebarMinimum, metrics.sidebarMaximum);
      apply(side, (metrics.workspaceWidth - side) * saved.request);
      return;
    }
    updateHandle(handles[0], metrics.sidebarWidth, metrics.sidebarMinimum, metrics.sidebarMaximum);
    updateHandle(handles[1], metrics.requestWidth, metrics.requestMinimum, metrics.requestMaximum);
  };

  const save = () => {
    const metrics = measurements();
    saved = { sidebar: metrics.sidebarWidth / metrics.rem,
      request: metrics.requestWidth / (metrics.workspaceWidth - metrics.sidebarWidth) };
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(saved));
  };

  const reset = () => {
    saved = null;
    if (storageKey) localStorage.removeItem(storageKey);
    workspace.style.removeProperty("--sidebar-width");
    workspace.style.removeProperty("--request-width");
    sync();
  };

  const showTip = (handle, visible) => {
    handle.classList?.toggle("is-active", visible);
    const tip = handle.querySelector?.(".size-tip");
    if (tip) tip.hidden = !visible;
  };

  const move = (clientX) => {
    if (!resizing || !isDesktop()) return;
    const metrics = measurements();
    // Distance from the workspace's inline start: its left edge, or its right edge in RTL.
    const bounds = workspace.getBoundingClientRect();
    const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
    const offset = rtl ? bounds.right - clientX : clientX - bounds.left;
    if (resizing.type === "sidebar") {
      apply(offset, metrics.requestWidth);
    } else {
      apply(metrics.sidebarWidth, offset - metrics.sidebarWidth);
    }
  };

  const stop = () => {
    if (!resizing) return;
    showTip(resizing.handle, false);
    resizing = null;
    save();
    document.body.classList.remove("layout-resizing");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
  };

  const onPointerMove = (event) => {
    event.preventDefault();
    move(event.clientX);
  };

  const onPointerDown = (event) => {
    if (!isDesktop() || workspace.dataset?.sidebar === "closed" || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    resizing = { type: handle.dataset.layoutDivider, handle };
    showTip(handle, true);
    document.body.classList.add("layout-resizing");
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", stop, { once: true });
    document.addEventListener("pointercancel", stop, { once: true });
  };

  const onKeyDown = (event) => {
    // Chords such as ⌥← belong to the workbench's own shortcuts, not to the divider.
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (!isDesktop() || workspace.dataset?.sidebar === "closed") return;
    const handle = event.currentTarget;
    const metrics = measurements();
    const isSidebar = handle.dataset.layoutDivider === "sidebar";
    const minimum = isSidebar ? metrics.sidebarMinimum : metrics.requestMinimum;
    const maximum = isSidebar
      ? metrics.sidebarMaximum
      : metrics.workspaceWidth - metrics.sidebarWidth - metrics.requestMinimum;
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)
    ) return;
    event.preventDefault();
    const current = isSidebar ? metrics.sidebarWidth : metrics.requestWidth;
    // In right-to-left layouts the left arrow widens the start-side pane.
    const mirrored = document.documentElement.dir === "rtl" ? { ArrowLeft: "ArrowRight", ArrowRight: "ArrowLeft" }[event.key] ?? event.key : event.key;
    const value = keyboardTrackValue(
      current,
      mirrored,
      minimum,
      maximum,
      KEYBOARD_STEP_REM * metrics.rem,
    );
    apply(isSidebar ? value : metrics.sidebarWidth, isSidebar ? metrics.requestWidth : value);
    save();
    showTip(handle, true);
  };

  const onBlur = event => showTip(event.currentTarget, false);
  handles.forEach((handle) => {
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("keydown", onKeyDown);
    handle.addEventListener("blur", onBlur);
    handle.addEventListener("dblclick", reset);
  });
  sync();

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(workspace);
  } else {
    window.addEventListener("resize", sync);
  }

  return {
    refresh: sync,
    destroy() {
      stop();
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", sync);
      handles.forEach((handle) => {
        handle.removeEventListener("pointerdown", onPointerDown);
        handle.removeEventListener("keydown", onKeyDown);
        handle.removeEventListener("blur", onBlur);
        handle.removeEventListener("dblclick", reset);
      });
    },
  };
}
