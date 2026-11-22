import { esc as safe, icon, method } from "./components.js";
import { formatTime, t } from "./i18n.js";
import { modelKind, modelSize } from "./schema-model.js";
import { matchesShortcut, shortcutAttrs, shortcutHint } from "./shortcuts.js";

/** The command palette (⌘K): operations, scoped actions, result tabs, models and history. */
export function createNavigation({
  state,
  $,
  selectOperation,
  run,
  renderOperation,
  openModel = () => {},
  commands = () => [],
}) {
  function palette(historyOnly = false, initialScope = "All") {
    const overlay = $("#overlay");
    const opener = document.activeElement;
    overlay.innerHTML = `
      <div class="scrim palette-scrim" data-action="close"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="${safe(t("palette.label"))}">
        <div class="pop-search">
          ${icon("search")}
          <input role="combobox" aria-expanded="true" aria-controls="pal-list"
            aria-label="${safe(t("palette.search"))}"
            placeholder="${safe(t("palette.placeholder"))}">
          <span class="scope">${safe(scopeLabel(historyOnly ? "History" : initialScope))}</span>
        </div>
        <div class="pal-list" id="pal-list" role="listbox" aria-label="${safe(t("palette.results"))}"></div>
        <div class="pop-foot">
          <span>${shortcutHint('updown')} ${safe(t("palette.move"))}</span>
          <span>${shortcutHint('enter')} ${safe(t("palette.run"))}</span>
          <span>${shortcutHint('tab')} ${safe(t("palette.scope"))}</span>
          <span class="spacer"></span><button class="btn btn-ghost btn-xs" type="button" data-palette-shortcuts ${shortcutAttrs('shortcuts')}>${shortcutHint('shortcuts')} ${safe(t("palette.allShortcuts"))}</button>
        </div>
      </div>`;

    function scopeLabel(value) {
      return value === "All" ? state.op?.title || t("palette.scope.All") : t("palette.scope." + value);
    }
    const input = overlay.querySelector("input");
    const list = overlay.querySelector(".pal-list");
    const app = document.querySelector?.(".app");
    if (app) app.inert = true;
    let scope = historyOnly ? "History" : initialScope;
    let selected = 0;
    let items = [];

    const highlighted = (value, query) => {
      const text = String(value ?? "");
      const index = query ? text.toLowerCase().indexOf(query) : -1;
      if (index < 0) return safe(text);
      return (
        safe(text.slice(0, index)) +
        "<mark>" +
        safe(text.slice(index, index + query.length)) +
        "</mark>" +
        safe(text.slice(index + query.length))
      );
    };

    const draw = () => {
      const query = input.value.trim().toLowerCase();
      const operations = historyOnly
        ? []
        : state.ops.map((op, index) => ({
            group: "Operations",
            label: op.title,
            context: op.group,
            op,
            index,
          }));
      const actions = historyOnly ? [] : commands().map(command => ({
        ...command, group: command.group === "Result" ? "Result" : "Actions",
      }));
      const history = state.history.map((entry) => ({
        group: "History",
        label: t("palette.replay", { title: entry.op.title }),
        context: t("palette.fromHistory", { time: formatTime(entry.when) }),
        entry,
      }));
      const schemas = historyOnly
        ? []
        : Object.entries(state.doc.components?.schemas || {}).map(
            ([name, schema]) => ({
              group: "Models",
              label: name,
              model: name,
              context: t("palette.modelContext", { kind: t("side.kind." + modelKind(schema, state.doc).id), n: modelSize(schema, state.doc) }),
            }),
          );
      items = [...actions.filter(item => item.group !== "Result"), ...operations,
        ...actions.filter(item => item.group === "Result"), ...history, ...schemas].filter(
        (item) =>
          (scope === "All" || scope === item.group) &&
          `${item.label} ${item.context || ""} ${item.op?.path || ""} ${item.op?.method || ""}`
            .toLowerCase()
            .includes(query),
      ).slice(0, 250);
      selected = Math.min(selected, Math.max(0, items.length - 1));
      let group = "";
      list.innerHTML =
        items
          .map((item, index) => {
            const heading =
              item.group === group
                ? ""
                : `<div class="pop-label" role="presentation">${safe(item.group === "Actions" ? t("palette.group.actions") : t("palette.scope." + item.group))}</div>`;
            group = item.group;
            const glyph = item.op
              ? method(item.op.method)
              : icon(item.icon || (item.model ? "box" : "history"), true);
            return `${heading}<button class="opt-row pal-item" type="button" role="option" id="palette-item-${index}"
          aria-selected="${index === selected}" tabindex="-1" data-palette-index="${index}" ${item.id ? shortcutAttrs(item.id) : ""}>
          ${glyph}
          <span class="stack"><span class="main">${highlighted(item.label, query)}</span>
            ${item.context ? `<span class="sub">${highlighted(item.context, query)}</span>` : ""}</span>
          ${item.id && shortcutAttrs(item.id) ? `<span class="end">${shortcutHint(item.id)}</span>` : ""}
        </button>`;
          })
          .join("") ||
        `<div class="pop-label" role="option" aria-selected="false" aria-disabled="true">${safe(t("palette.none"))}</div>`;
      if (items.length)
        input.setAttribute("aria-activedescendant", `palette-item-${selected}`);
      else input.removeAttribute("aria-activedescendant");
    };

    const close = () => {
      overlay.innerHTML = "";
      if (app) app.inert = false;
      opener?.focus();
    };
    const choose = async (index, preview = false) => {
      const item = items[index];
      if (!item) return;
      close();
      if (item.model) {
        openModel(item.model);
        return;
      }
      if (item.op) {
        selectOperation(item.index);
        if (preview) await run(true);
      } else if (item.run) {
        item.run();
      } else if (item.entry) {
        const entry = item.entry;
        const opIndex = state.ops.findIndex(
          (op) => op.method === entry.op.method && op.path === entry.op.path,
        );
        if (opIndex < 0) return;
        selectOperation(opIndex);
        state.body = structuredClone(entry.body);
        state.paramValues = structuredClone(entry.params);
        state.headers = structuredClone(entry.headers || []);
        renderOperation();
        if (preview) await run(true);
      }
    };

    input.addEventListener("input", () => {
      selected = 0;
      draw();
    });
    overlay.querySelector(".palette").addEventListener("keydown", (event) => {
      if (matchesShortcut("escape", event)) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (
        !input.hidden &&
        (matchesShortcut("down", event) || matchesShortcut("up", event))
      ) {
        event.preventDefault();
        selected =
          (selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          Math.max(items.length, 1);
        draw();
        list.querySelector(`[id="palette-item-${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
        input.focus();
      } else if (!input.hidden && (matchesShortcut("enter", event) || matchesShortcut("lookup-preview", event))) {
        event.preventDefault();
        event.stopPropagation();
        const focused = event.target.closest("[data-palette-index]");
        choose(
          focused ? Number(focused.dataset.paletteIndex) : selected,
          event.metaKey || event.ctrlKey,
        );
      } else if (event.key === "Tab") {
        if (!historyOnly && !input.hidden) {
          const scopes = ["All", "Actions", "Operations", "Result", "Models", "History"];
          scope = scopes[(scopes.indexOf(scope) + (event.shiftKey ? -1 : 1) + scopes.length) % scopes.length];
          overlay.querySelector(".scope").textContent = scopeLabel(scope);
          selected = 0;
          draw();
          input.focus();
          event.preventDefault();
          return;
        }
        const focusable = [
          ...overlay.querySelectorAll(
            "input:not([hidden]), [data-palette-shortcuts]",
          ),
        ];
        const index = focusable.indexOf(document.activeElement);
        if (
          (!event.shiftKey && index === focusable.length - 1) ||
          (event.shiftKey && index <= 0)
        ) {
          event.preventDefault();
          focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
        }
      }
    });
    overlay.onclick = (event) => {
      if (event.target.closest('.scrim')) {
        event.stopPropagation();
        close();
        return;
      }
      if (event.target.closest("[data-palette-shortcuts]")) {
        close();
        commands().find(command => command.id === "shortcuts")?.run();
        return;
      }
      const item = event.target.closest("[data-palette-index]");
      if (item) choose(Number(item.dataset.paletteIndex));
    };
    draw();
    input.focus();
  }
  return { palette };
}
