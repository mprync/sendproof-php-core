import { dereference } from "./api.js";
import {
  coerceHeaderValue, createHeaderRow, formatHeaderLines, headerNameFix, headerRowsToObject,
  headerVariables, inspectHeaderRows, normalizeHeaderRows, parseHeaderLines,
} from "./headers.js";
import { resolveSchema, validateSchemaValue } from "./schema.js";
import { newUuid } from "./uuid.js";
import { esc, icon, stateBlock } from "./components.js";
import { t, th } from "./i18n.js";
import { matchesShortcut, shortcutAttrs, shortcutHint } from "./shortcuts.js";

// Presets: [message key for the menu label, header name, header value]. Names and values are
// sent as written; only the label is translated.
const presets = [
  ["kv.preset.acceptJson", "Accept", "application/json"],
  ["kv.preset.requestId", "X-Request-ID", "{{uuid}}"],
  ["kv.preset.bypassCache", "Cache-Control", "no-cache"],
];
// Suggested header names (never translated) with the message key for their hint.
const standardHeaders = [
  ["Accept", "kv.std.accept"],
  ["Accept-Language", "kv.std.acceptLanguage"],
  ["Authorization", "kv.std.authorization"],
  ["Cache-Control", "kv.std.cacheControl"],
  ["Content-Type", "kv.std.contentType"],
  ["If-Match", "kv.std.ifMatch"],
  ["If-Modified-Since", "kv.std.ifModifiedSince"],
  ["If-None-Match", "kv.std.ifNoneMatch"],
  ["If-Unmodified-Since", "kv.std.ifUnmodifiedSince"],
  ["Prefer", "kv.std.prefer"],
  ["Range", "kv.std.range"],
  ["X-Request-ID", "kv.std.requestId"],
];
const keyOf = name => name.trim().toLowerCase();
const parameterKey = name => "header:" + name;
const declaredId = name => "declared-header-" + name;
const hasValue = value => value !== undefined && value !== null && value !== "";
const asText = value => value != null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
const isIdempotency = name => keyOf(name) === "idempotency-key";

/** Own header draft controls and prepare their values for the existing request API. */
export function createHeaderEditor({ state, $, parameterSchema, getMediaType, onChange = () => {} }) {
  let owner;
  let optionalDraft = new Map();
  let manualKeys = new Set();
  let bulk;
  let navTarget;
  let popup;

  function syncDraft() {
    state.paramValues ||= {};
    if (owner === state.paramValues) return;
    owner = state.paramValues;
    optionalDraft = new Map();
    manualKeys = new Set();
    bulk = undefined;
  }

  function customRows() {
    return state.headers = normalizeHeaderRows(state.headers);
  }

  function schemaFor(parameter) {
    return resolveSchema(parameterSchema(parameter), state.doc);
  }

  function documentedParameters() {
    return (state.op?.parameters || []).map(raw => dereference(raw, state.doc))
      .filter(parameter => parameter?.in === "header" && parameter.name);
  }

  function managedRows() {
    if (!state.op) return [];
    const session = state.cap?.identity;
    const selectedBody = dereference(state.op.operation?.requestBody, state.doc);
    const content = selectedBody?.content || {};
    const mediaType = getMediaType ? getMediaType() :
      (Object.hasOwn(content, "application/json") ? "application/json" : Object.keys(content)[0]);
    return [
      ...(session ? [{ id: "managed-header-cookie", name: "Cookie", value: t("kv.sessionCookie"), tag: session.name, managed: true }] : []),
      ...(mediaType ? [{ id: "managed-header-content-type", name: "Content-Type", value: mediaType, managed: true }] : []),
    ];
  }

  function getRows() {
    syncDraft();
    const managed = managedRows();
    const managedNames = new Set(managed.map(row => keyOf(row.name)));
    const documented = documentedParameters().filter(parameter => !managedNames.has(keyOf(parameter.name)));
    const declared = [];
    const optional = [];
    for (const parameter of documented) {
      const name = parameter.name;
      const value = state.paramValues[parameterKey(name)];
      const draft = optionalDraft.get(name);
      const primary = !!parameter.required || isIdempotency(name);
      if (!primary && !hasValue(value) && !draft) {
        optional.push(parameter);
        continue;
      }
      declared.push({
        id: declaredId(name), name, parameter, primary,
        enabled: !!parameter.required || (draft?.enabled ?? true),
        value: draft?.enabled === false ? draft.value : value,
      });
    }
    return { declared, managed, custom: customRows(), optional };
  }

  function context() {
    return { lastId: state.lastResponse?.body?.id };
  }

  function inspect(data, requestTime = false) {
    const rows = [...data.managed, ...data.declared, ...data.custom].map(row => ({
      ...row,
      // A session name is descriptive metadata. The browser supplies its cookie.
      value: row.managed ? "" : asText(row.value),
    }));
    const resolved = inspectHeaderRows(rows, { ...context(), ...(requestTime ? { uuid: newUuid } : {}) });
    const errors = [...resolved.errors];
    const parameters = [];
    for (const row of resolved.rows.filter(row => row.parameter)) {
      const schema = parameterSchema(row.parameter);
      const original = data.declared.find(item => item.id === row.id).value;
      const value = typeof original !== "string" && !headerVariables(asText(original)).length
        ? original : coerceHeaderValue(row.value, schemaFor(row.parameter));
      if (!errors.some(error => error.id === row.id)) {
        const schemaErrors = schema == null ? [] : validateSchemaValue({
          schema, value, document: state.doc, required: !!row.parameter.required,
        });
        const messages = schemaErrors.map(error => error.message);
        if (!messages.length && row.parameter.required && !hasValue(value)) messages.push(t("kv.requiredValue"));
        for (const message of messages) errors.push({ id: row.id, field: "value", message });
      }
      parameters.push({ ...row.parameter, value });
    }
    return { errors, parameters };
  }

  function issues() {
    const data = getRows();
    const customIds = new Set(data.custom.map(row => row.id));
    const errors = inspect(data).errors.filter(issue => !bulk?.errors.length || !customIds.has(issue.id));
    return [
      ...(bulk?.errors ?? []).map(message => ({ path: "Headers", message, inputId: "header-bulk" })),
      ...errors.map(issue => ({
        path: "Headers",
        message: issue.message,
        inputId: bulk && customIds.has(issue.id) ? "header-bulk" : `${issue.id}-${issue.field}`,
      })),
    ];
  }

  function values() {
    const data = getRows();
    return headerRowsToObject(data.custom, context());
  }

  function parameters() {
    const prepared = inspect({ ...getRows(), custom: [] }, true);
    if (prepared.errors.length) {
      const error = new Error(prepared.errors.map(issue => issue.message).join("\n"));
      error.validation = true;
      error.issues = prepared.errors.map(issue => ({
        path: "Headers", tab: "Headers", message: issue.message, inputId: `${issue.id}-${issue.field}`,
      }));
      throw error;
    }
    return prepared.parameters;
  }

  function headerCount(data) {
    return data.managed.length + data.declared.filter(row => row.enabled && hasValue(row.value)).length +
      data.custom.filter(row => row.enabled !== false && row.name.trim()).length;
  }

  function group(title, rows, detail = "") {
    if (!rows.length) return "";
    return `<div class="kv-row group" role="row"><span role="rowheader" aria-colspan="4">
      ${title}${detail ? `<span class="spacer"></span><span>${detail}</span>` : ""}
    </span></div>${rows.join("")}`;
  }

  function cell(column, classes, markup = "", attrs = "", interactive = Boolean(markup)) {
    return `<div class="c ${classes}" role="gridcell" aria-colindex="${column}"
      ${interactive ? `data-grid-cell="${column}" tabindex="-1"` : ""} ${attrs}>${markup}</div>`;
  }

  function checkbox(row) {
    if (row.managed) return `<span class="checkbox locked" role="img" aria-label="${esc(t("kv.managed"))}">${icon("lock")}</span>`;
    const enabled = row.enabled !== false;
    const label = sendLabel(row.name);
    return `<label class="kv-check">
      <input type="checkbox" data-header-enabled id="${esc(row.id)}-enabled" aria-label="${esc(label)}"
        tabindex="-1" ${enabled ? "checked" : ""} ${row.parameter?.required ? "disabled" : ""}>
      <span class="checkbox ${enabled ? "on" : ""}" aria-hidden="true">${icon("check")}</span>
    </label>`;
  }

  // Accessible names for a row's controls; an unnamed row is a "new header".
  const sendLabel = name => name ? t("kv.sendName", { name }) : t("kv.sendNew");
  const valueLabel = name => name ? t("kv.valueFor", { name }) : t("kv.headerValue");
  const actionsLabel = name => t("kv.moreActions", { name: name || t("kv.newHeader") });

  function valuePreview(value) {
    const tokens = headerVariables(value);
    if (!tokens.length) return esc(value);
    let result = "";
    let offset = 0;
    for (const token of tokens) {
      result += esc(value.slice(offset, token.index)) + `<span class="var-token">${esc(token[0])}</span>`;
      offset = token.index + token[0].length;
    }
    const guidance = tokens.length === 1 && tokens[0][0] === value
      ? { uuid: "kv.hint.uuid", now: "kv.hint.now", "last.id": "kv.hint.lastId" }[tokens[0][1]] : "";
    return result + esc(value.slice(offset)) + (guidance ? `<span class="kv-variable-hint faint">${esc(t(guidance))}</span>` : "");
  }

  function preview(field, value) {
    return value ? (field === "value" ? valuePreview(value) : esc(value)) : esc(t(field === "value" ? "kv.valuePlaceholder" : "kv.namePlaceholder"));
  }

  function inputField(row, field) {
    const nameField = field === "name";
    const value = asText(row[field]);
    return `<div class="kv-field">
      <input id="${esc(row.id)}-${field}" data-header-field="${field}" tabindex="-1"
        aria-label="${nameField ? esc(t("kv.namePlaceholder")) : esc(valueLabel(row.name))}"
        value="${esc(value)}" placeholder="${esc(t(nameField ? "kv.namePlaceholder" : "kv.valuePlaceholder"))}" spellcheck="false" autocomplete="off"
        ${nameField ? 'role="combobox" aria-autocomplete="list" aria-controls="header-suggestions" aria-expanded="false"' : ""}>
      <span class="kv-display ${nameField ? "name" : "val"}${value ? "" : " placeholder"}" aria-hidden="true">${preview(field, value)}</span>
    </div>`;
  }

  function rowMarkup(row) {
    const id = esc(row.id);
    const kind = row.managed ? "managed" : row.parameter ? "declared" : "custom";
    const auto = isIdempotency(row.name) && row.parameter && hasValue(row.value) && !manualKeys.has(row.name);
    const name = row.parameter || row.managed ? `<span class="name">${esc(row.name)}</span>` : inputField(row, "name");
    const value = row.managed ? `<span class="val">${esc(row.value)}</span>` : inputField(row, "value");
    const badge = auto ? `<span class="tag tag-accent" data-header-auto>${icon("wand", true)} ${esc(t("kv.auto"))}</span>` :
      row.tag ? `<span class="tag">${esc(row.tag)}</span>` : "";
    const regenerate = row.parameter && isIdempotency(row.name) ?
      `<button class="btn btn-ghost btn-icon btn-xs" type="button" data-header-command="regenerate" tabindex="-1"
        aria-label="${esc(t("kv.regenerate", { name: row.name }))}">${icon("refresh", true)}</button>` : "";
    const actions = row.managed ? "" : regenerate +
      `<button class="btn btn-ghost btn-icon btn-xs" type="button" data-header-command="actions" tabindex="-1"
        aria-label="${esc(actionsLabel(row.name))}" aria-expanded="false">${icon("more", true)}</button>`;
    return `<div class="kv-row${row.managed ? " is-managed" : ""}${row.enabled === false ? " is-disabled" : ""}"
      role="row" data-header-row data-header-id="${id}" data-header-kind="${kind}">
      ${cell(1, "check", checkbox(row))}
      ${cell(2, "name-c", name + (row.parameter || row.managed ? "" : invalidIcon()), row.parameter || row.managed ? 'aria-readonly="true"' : "")}
      ${cell(3, "val-c", value + badge + (row.managed ? "" : invalidIcon()), row.managed ? 'aria-readonly="true"' : "")}
      ${cell(4, "acts", actions)}
    </div>`;
  }

  function invalidIcon() {
    return `<span class="kv-invalid-icon" aria-hidden="true">${icon("alert", true)}</span>`;
  }

  function toolbar(data) {
    return `<div class="kv-toolbar">
      <span class="faint kv-count" data-header-count aria-live="polite">${countText(data)}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" type="button" data-header-command="presets" aria-expanded="false">
        ${icon("list", true)}${esc(t("kv.presets"))}${icon("chevron-down", true)}
      </button>
      <div class="segmented" role="group" aria-label="${esc(t("kv.editorMode"))}">
        <button type="button" data-header-command="table" aria-pressed="${!bulk}">${esc(t("kv.table"))}</button>
        <button type="button" data-header-command="bulk" aria-pressed="${!!bulk}">${esc(t("kv.bulkEdit"))}</button>
      </div>
    </div>`;
  }

  function countText(data) {
    return t("kv.count", { n: headerCount(data) });
  }

  const hasCustomRows = data => data.custom.length || data.declared.some(row => !row.primary);

  /** No custom headers yet (mock 36): the managed ones stay listed and nothing looks empty. */
  function emptyCustom(data) {
    const sent = data.managed.length + data.declared.filter(row => row.primary).length;
    return `<div class="kv-row kv-empty" role="row" style="display:block"><div role="gridcell">${stateBlock({
      glyph: '', compact: true, title: esc(t("kv.emptyTitle")), body: esc(t("kv.emptyBody", { n: sent })),
      actions: [`<button type="button" class="btn btn-sm" data-action="add-header" ${shortcutAttrs('add-header')}>${icon('plus', true)}${esc(t("kv.add"))} ${shortcutHint('add-header')}</button>`,
        `<button type="button" class="btn btn-ghost btn-sm" data-header-command="presets">${icon('list', true)}${esc(t("kv.applyPreset"))}</button>`],
    })}</div></div>`;
  }

  function grid(data) {
    const addRow = `<div class="kv-row kv-add" role="row">
      ${cell(1, "check", '<span class="checkbox" aria-hidden="true"></span>', "", false)}
      ${cell(2, "name-c", `<button class="kv-add-button" type="button" data-action="add-header" tabindex="-1" ${shortcutAttrs('add-header', 'add-row')}>${esc(t("kv.add"))}</button>`)}
      ${cell(3, "val-c", `<span class="val placeholder" aria-hidden="true">${esc(t("kv.valuePlaceholder"))}</span>`, "", false)}
      ${cell(4, "acts")}
    </div>`;
    return `<div class="kv-table" id="header-list" role="grid" aria-label="${esc(t("kv.grid"))}" aria-colcount="4">
      <div class="kv-row head" role="row">
        <div class="c" role="columnheader"><span class="sr-only">${esc(t("kv.col.send"))}</span></div>
        <div class="c" role="columnheader">${esc(t("kv.col.name"))}</div><div class="c" role="columnheader">${esc(t("kv.col.value"))}</div>
        <div class="c" role="columnheader"><span class="sr-only">${esc(t("kv.col.actions"))}</span></div>
      </div>
      ${group(esc(t("kv.group.required")), data.declared.filter(row => row.primary).map(rowMarkup))}
      ${group(esc(t("kv.group.managed")), data.managed.map(rowMarkup), esc(t("kv.group.managedDetail")))}
      ${group(esc(t("kv.group.custom")), [...data.declared.filter(row => !row.primary).map(rowMarkup), ...(!bulk ? [...data.custom.map(rowMarkup), hasCustomRows(data) ? addRow : emptyCustom(data)] : [])])}
    </div>`;
  }

  function specChips(data) {
    const used = new Set(data.custom.map(row => keyOf(row.name)));
    const options = data.optional.filter(parameter => !used.has(keyOf(parameter.name)));
    return options.length ? `<div class="optional-props kv-spec" role="group" aria-label="${esc(t("kv.addDocumented"))}">
      <span class="lead-label">${esc(t("kv.fromSpec"))}</span>
      ${options.map(parameter => `<button type="button" class="prop-chip" data-header-command="spec" data-header-name="${esc(parameter.name)}">
        ${icon("plus", true)}${esc(parameter.name)}<span class="t">${esc(t(schemaFor(parameter).format === "uuid" ? "kv.uuid" : "field.optional"))}</span>
      </button>`).join("")}
    </div>` : "";
  }

  function bulkMarkup() {
    return `<div class="kv-bulk">
      <label class="label" for="header-bulk">${esc(t("kv.customHeaders"))}</label>
      <textarea class="code" id="header-bulk" spellcheck="false" placeholder="${esc(t("kv.bulkPlaceholder"))}"
        aria-describedby="header-bulk-hint">${esc(bulk.text)}</textarea>
      <p class="kv-note" id="header-bulk-hint">${esc(t("kv.bulkHint"))}</p>
    </div>`;
  }

  function markErrors(data = getRows()) {
    const editor = $("#editor");
    const status = editor.querySelector("[data-header-count]");
    const summary = editor.querySelector("[data-header-notes]");
    if (!status || !summary) return;
    const count = countText(data);
    if (status.textContent !== count) status.textContent = count;
    const rows = [...data.declared, ...data.custom];
    const byId = new Map(rows.map(row => [row.id, row]));
    const errors = inspect(data).errors.filter(error => {
      const row = byId.get(error.id);
      return row?.parameter || row?.name || row?.value;
    });
    const byRow = Map.groupBy(errors, error => error.id);
    const notes = [...byRow].filter(([id]) => !bulk || byId.get(id).parameter).map(([id, errors]) => {
      const row = byId.get(id);
      const fix = !row.parameter && errors.some(error => error.field === "name") && headerNameFix(row.name);
      return `<div class="kv-note is-error" id="${esc(id)}-error">${icon("alert", true)}
        <span>${th("kv.noteLine", { name: esc(row.name || t("kv.customFallback")), message: esc(errors.map(error => error.message).join(" ")) })}</span>
        ${fix && !bulk ? `<button class="btn btn-ghost btn-xs" type="button" data-header-command="fix" data-header-fix="${esc(id)}">${esc(t("kv.fix"))}</button>` : ""}
      </div>`;
    });
    const bulkErrors = bulk && [...bulk.errors, ...data.custom.flatMap(row =>
      (byRow.get(row.id) || []).map(error => error.message))];
    if (bulkErrors?.length) {
      notes.unshift(`<div class="kv-note is-error" id="header-bulk-error">${icon("alert", true)}
        <span>${esc(bulkErrors.join(" "))}</span></div>`);
    }
    const contents = notes.join("") || `<div class="kv-note">${icon("info", true)}
      <span>${th("kv.variables", { uuid: "<code>{{uuid}}</code>", now: "<code>{{now}}</code>", last: "<code>{{last.id}}</code>" })}</span></div>`;
    if (summary.dataset.content !== contents) {
      summary.innerHTML = contents;
      summary.dataset.content = contents;
    }
    const bulkInput = $("#header-bulk");
    if (bulkInput) {
      bulkInput.setAttribute("aria-invalid", String(!!bulkErrors.length));
      bulkInput.setAttribute("aria-describedby", bulkErrors.length ? "header-bulk-hint header-bulk-error" : "header-bulk-hint");
    }
    for (const node of editor.querySelectorAll("[data-header-row]")) {
      const id = node.dataset.headerId;
      const problems = byRow.get(id) || [];
      for (const input of node.querySelectorAll("[data-header-field]")) {
        const invalid = problems.some(error => error.field === input.dataset.headerField);
        input.closest("[data-grid-cell]").classList.toggle("is-invalid", invalid);
        input.setAttribute("aria-invalid", String(invalid));
        if (invalid) input.setAttribute("aria-describedby", id + "-error");
        else input.removeAttribute("aria-describedby");
      }
    }
  }

  function update() {
    markErrors();
    onChange();
  }

  function render(focusId) {
    const data = getRows();
    navTarget = popup = undefined;
    const editor = $("#editor");
    editor.innerHTML = `<div class="header-editor">
      ${toolbar(data)}${grid(data)}${bulk ? bulkMarkup() : ""}
      <div data-header-notes aria-live="polite"></div>${specChips(data)}
      <div class="pop kv-suggest" id="hdr-suggest" hidden>
        <div role="listbox" aria-label="${esc(t("kv.suggestions"))}" class="pop-group" id="header-suggestions"></div>
        <div class="pop-foot" aria-hidden="true"><span>${th("kv.move", { key: shortcutHint('up', 'down') })}</span><span>${th("kv.pick", { key: shortcutHint('enter') })}</span>
          <span>${th("kv.toValue", { key: shortcutHint('tab') })}</span><span class="spacer"></span><span>${shortcutHint('escape')}</span></div>
      </div>
      <div class="pop kv-menu" id="header-menu" hidden></div>
    </div>`;
    const root = editor.firstElementChild;
    root.addEventListener("input", onInput);
    root.addEventListener("change", event => {
      if (event.target.matches("[data-header-enabled]")) toggleRow(event.target.closest("[data-header-row]").dataset.headerId);
    });
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKey);
    root.addEventListener("focusin", event => {
      const cell = event.target.closest("[data-grid-cell]");
      if (cell) setRoving(event.target);
    });
    root.addEventListener("focusout", event => {
      if (popup && event.relatedTarget !== popup.anchor && !popup.node.contains(event.relatedTarget)) closePopup();
    });
    root.addEventListener("pointerdown", event => {
      if (event.target.closest("[data-header-option]")) event.preventDefault();
      else if (popup && !popup.node.contains(event.target) && !popup.anchor.contains(event.target)) closePopup();
    });
    const first = root.querySelector("[data-grid-cell]");
    if (first) setRoving(first);
    markErrors(data);
    if (focusId) editor.ownerDocument.getElementById(focusId)?.focus();
  }

  function setRoving(node) {
    if (navTarget) navTarget.tabIndex = -1;
    navTarget = node;
    navTarget.tabIndex = 0;
  }

  function rowFor(target) {
    const id = target.closest("[data-header-row]")?.dataset.headerId;
    const data = getRows();
    return [...data.declared, ...data.custom].find(row => row.id === id);
  }

  function setDeclaredValue(row, value) {
    state.paramValues[parameterKey(row.name)] = coerceHeaderValue(value, schemaFor(row.parameter));
    if (!row.parameter.required) optionalDraft.set(row.name, { enabled: true });
  }

  function refreshField(input) {
    const value = input.value;
    const display = input.nextElementSibling;
    display.classList.toggle("placeholder", !value);
    display.innerHTML = preview(input.dataset.headerField, value);
  }

  function onInput(event) {
    const input = event.target;
    if (input.id === "header-bulk") {
      bulk.text = input.value;
      const result = parseHeaderLines(input.value, customRows());
      bulk.errors = result.errors;
      if (!result.errors.length) state.headers = result.rows;
      update();
      return;
    }
    const field = input.dataset.headerField;
    if (!field) return;
    const row = rowFor(input);
    if (row.parameter) {
      if (row.enabled === false) optionalDraft.set(row.name, { enabled: false, value: input.value });
      else setDeclaredValue(row, input.value);
      manualKeys.add(row.name);
      input.closest("[data-grid-cell]").querySelector("[data-header-auto]")?.remove();
    } else {
      row[field] = input.value;
    }
    if (field === "name") {
      const rowNode = input.closest("[data-header-row]");
      rowNode.querySelector("[data-header-enabled]").setAttribute("aria-label", sendLabel(row.name));
      rowNode.querySelector('[data-header-field="value"]').setAttribute("aria-label", valueLabel(row.name));
      rowNode.querySelector('[data-header-command="actions"]').setAttribute("aria-label", actionsLabel(row.name));
      suggest(input);
    }
    refreshField(input);
    update();
  }

  function toggleRow(id) {
    const data = getRows();
    const declared = data.declared.find(row => row.id === id);
    if (declared?.parameter.required) return;
    if (declared) {
      if (declared.enabled) {
        optionalDraft.set(declared.name, { enabled: false, value: declared.value });
        state.paramValues[parameterKey(declared.name)] = undefined;
      } else {
        setDeclaredValue(declared, asText(declared.value));
      }
    } else {
      const row = data.custom.find(item => item.id === id);
      if (!row) return;
      row.enabled = row.enabled === false;
      if (bulk) bulk.text = formatHeaderLines(data.custom);
    }
    render(id + "-enabled");
    onChange();
  }

  function add() {
    if (bulk?.errors.length) return;
    bulk = undefined;
    const row = createHeaderRow();
    customRows().push(row);
    render(row.id + "-name");
    onChange();
  }

  function remove(id) {
    if (bulk?.errors.length) return;
    state.headers = customRows().filter(row => row.id !== id);
    if (bulk) bulk.text = formatHeaderLines(state.headers);
    render();
    $("#editor").querySelector('[data-action="add-header"], #header-bulk')?.focus();
    onChange();
  }

  function showBulk() {
    syncDraft();
    bulk ||= { text: formatHeaderLines(customRows()), errors: [] };
    render("header-bulk");
  }

  function showTable() {
    if (bulk?.errors.length) {
      $("#header-bulk").focus();
      return;
    }
    bulk = undefined;
    render();
    $('[data-header-command="table"]').focus();
  }

  function addDocumented(parameter, customId, value) {
    const name = parameter.name;
    const schema = schemaFor(parameter);
    const initial = value || (schema.format === "uuid" ? "{{uuid}}" : asText(parameter.example ?? schema.default));
    setDeclaredValue({ name, parameter }, initial);
    if (customId) {
      state.headers = customRows().filter(row => row.id !== customId);
      if (bulk) bulk.text = formatHeaderLines(state.headers);
    }
    render(declaredId(name) + "-value");
    onChange();
  }

  function applyPreset(index) {
    if (bulk?.errors.length) {
      $("#header-bulk").focus();
      return;
    }
    const [, name, value] = presets[index];
    const data = getRows();
    const declared = [...data.declared.map(row => row.parameter), ...data.optional]
      .find(parameter => keyOf(parameter.name) === keyOf(name));
    let row = data.custom.find(item => keyOf(item.name) === keyOf(name));
    if (declared) {
      addDocumented(declared, row?.id, value);
      return;
    }
    if (row) Object.assign(row, { value, enabled: true });
    else data.custom.push(row = createHeaderRow(name, value));
    if (bulk) bulk.text = formatHeaderLines(data.custom);
    render(bulk ? "header-bulk" : row.id + "-value");
    onChange();
  }

  function closePopup() {
    if (!popup) return;
    popup.node.hidden = true;
    popup.anchor.setAttribute("aria-expanded", "false");
    popup.anchor.removeAttribute("aria-activedescendant");
    popup = undefined;
  }

  function openPopup(anchor, node, details, alignRight = false) {
    closePopup();
    popup = { anchor, node, ...details };
    node.hidden = false;
    anchor.setAttribute("aria-expanded", "true");
    const editor = anchor.closest(".header-editor");
    const rect = editor.getBoundingClientRect();
    const from = (details.options ? anchor.closest("[data-grid-cell]") : anchor).getBoundingClientRect();
    const width = node.offsetWidth;
    const left = (alignRight ? from.right - width : from.left) - rect.left;
    node.style.left = Math.max(0, Math.min(left, rect.width - width)) + "px";
    node.style.top = from.bottom - rect.top + 4 + "px";
  }

  function suggest(input) {
    const query = keyOf(input.value);
    const data = getRows();
    const activeRow = input.closest("[data-header-row]");
    const used = new Set([...data.declared, ...data.managed, ...data.custom]
      .filter(row => row.id !== activeRow.dataset.headerId && row.enabled !== false).map(row => keyOf(row.name)));
    const documented = data.optional.map(parameter => ({ name: parameter.name, detail: parameter.description, parameter }));
    const documentedNames = new Set(documented.map(option => keyOf(option.name)));
    const options = [...documented, ...standardHeaders
      .filter(([name]) => !documentedNames.has(keyOf(name))).map(([name, hint]) => ({ name, detail: t(hint) }))]
      .filter(option => query && keyOf(option.name).startsWith(query) && !used.has(keyOf(option.name))).slice(0, 6);
    if (!options.length) {
      closePopup();
      return;
    }
    const list = $("#header-suggestions");
    list.innerHTML = options.map((option, index) => `<div class="opt-row" id="header-option-${index}" role="option"
      aria-selected="false" data-header-option="${index}">
      <span class="main mono"><mark>${esc(option.name.slice(0, query.length))}</mark>${esc(option.name.slice(query.length))}</span>
      ${option.detail ? `<span class="sub">${esc(option.detail)}</span>` : ""}
      ${option.parameter ? `<span class="end"><span class="tag tag-accent">${esc(t("kv.inSpec"))}</span></span>` : ""}
    </div>`).join("");
    openPopup(input, $("#hdr-suggest"), { options });
    selectSuggestion(0);
  }

  function selectSuggestion(index) {
    popup.selected = (index + popup.options.length) % popup.options.length;
    popup.node.querySelectorAll("[data-header-option]").forEach((option, index) => {
      const active = index === popup.selected;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
      if (active) popup.anchor.setAttribute("aria-activedescendant", option.id);
    });
  }

  function pickSuggestion(index) {
    const { anchor, options } = popup;
    const option = options[index];
    const row = rowFor(anchor);
    closePopup();
    if (option.parameter) {
      addDocumented(option.parameter, row.id, row.value);
      return;
    }
    anchor.value = option.name;
    // Use the same draft update and live validation path as ordinary typing.
    anchor.dispatchEvent(new Event("input", { bubbles: true }));
    closePopup();
    anchor.closest("[data-header-row]").querySelector('[data-header-field="value"]').focus();
  }

  function menu(anchor, choices, rowId) {
    if (popup?.anchor === anchor) {
      closePopup();
      return;
    }
    const node = $("#header-menu");
    node.innerHTML = `<div class="pop-group">${choices.map(([label, command, index]) =>
      `<button class="opt-row" type="button" data-header-command="${command}" ${index == null ? "" : `data-header-preset="${index}"`}>
        <span class="main">${esc(label)}</span></button>`).join("")}</div>`;
    openPopup(anchor, node, { rowId }, true);
    node.querySelector("button").focus();
  }

  function onClick(event) {
    const option = event.target.closest("[data-header-option]");
    if (option) {
      pickSuggestion(Number(option.dataset.headerOption));
      return;
    }
    const button = event.target.closest("[data-header-command]");
    if (!button) return;
    const command = button.dataset.headerCommand;
    if (command === "bulk") showBulk();
    if (command === "table") showTable();
    if (command === "presets") menu(button, presets.map(([label], index) => [t(label), "preset", index]));
    if (command === "preset") applyPreset(Number(button.dataset.headerPreset));
    if (command === "spec") {
      if (bulk?.errors.length) {
        $("#header-bulk").focus();
        return;
      }
      const data = getRows();
      const parameter = data.optional.find(parameter => parameter.name === button.dataset.headerName);
      const draft = data.custom.find(row => keyOf(row.name) === keyOf(button.dataset.headerName));
      if (parameter) addDocumented(parameter, draft?.id, draft?.value);
    }
    if (command === "actions") {
      const row = rowFor(button);
      const choices = row.parameter ? [[t("kv.clear"), "clear"]] : [[t("kv.remove"), "remove"]];
      if (!row.parameter?.required) choices.unshift([t(row.enabled === false ? "kv.enable" : "kv.disable"), "toggle"]);
      menu(button, choices, row.id);
    }
    if (command === "toggle") toggleRow(popup.rowId);
    if (command === "remove") remove(popup.rowId);
    if (command === "clear" || command === "regenerate") {
      const row = command === "clear" ? getRows().declared.find(row => row.id === popup.rowId) : rowFor(button);
      if (command === "clear" && row.enabled === false) optionalDraft.set(row.name, { enabled: false, value: "" });
      else setDeclaredValue(row, command === "clear" ? "" : newUuid());
      if (command === "clear") manualKeys.add(row.name);
      else manualKeys.delete(row.name);
      render(row.id + "-value");
      onChange();
    }
    if (command === "fix") {
      const row = customRows().find(row => row.id === button.dataset.headerFix);
      row.name = headerNameFix(row.name) || row.name;
      render(row.id + "-name");
      onChange();
    }
  }

  function focusCell(cell, fromRight = false) {
    if (!cell) return false;
    const controls = [...cell.querySelectorAll("button, input:not(:disabled)")];
    const target = controls.at(fromRight ? -1 : 0) || cell;
    target.focus();
    return true;
  }

  function onKey(event) {
    if (event.isComposing) return;
    const { target, key } = event;
    if (popup && matchesShortcut('escape', event)) {
      const { anchor } = popup;
      closePopup();
      anchor.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (popup?.options && target === popup.anchor && ['up', 'down', 'enter'].some(id => matchesShortcut(id, event))) {
      if (matchesShortcut('enter', event)) pickSuggestion(popup.selected);
      else selectSuggestion(popup.selected + (key === "ArrowDown" ? 1 : -1));
      event.preventDefault();
      return;
    }
    if (popup && popup.node.contains(target) && ["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) {
      const buttons = [...popup.node.querySelectorAll("button")];
      const index = buttons.indexOf(target) + (key === "ArrowUp" ? -1 : 1);
      const next = key === "Home" ? 0 : key === "End" ? buttons.length - 1 : (index + buttons.length) % buttons.length;
      buttons[next]?.focus();
      event.preventDefault();
      return;
    }
    const cell = target.closest("[data-grid-cell]");
    if (!cell) return;
    const isText = !!target.dataset.headerField;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if ((key === "Tab" || key === "Enter") && target.dataset.headerField === "name") {
      event.preventDefault();
      closePopup();
      target.closest("[data-header-row]").querySelector('[data-header-field="value"]').focus();
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      if (isText && (target.selectionStart !== target.selectionEnd ||
        (key === "ArrowLeft" ? target.selectionStart > 0 : target.selectionEnd < target.value.length))) return;
      const fromRight = key === "ArrowLeft";
      const buttons = [...cell.querySelectorAll("button")];
      const adjacent = buttons[buttons.indexOf(target) + (fromRight ? -1 : 1)];
      if (buttons.includes(target) && adjacent) {
        adjacent.focus();
        event.preventDefault();
        return;
      }
      const cells = [...cell.parentElement.querySelectorAll("[data-grid-cell]")];
      if (focusCell(cells[cells.indexOf(cell) + (fromRight ? -1 : 1)], fromRight)) event.preventDefault();
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const rows = [...$("#header-list").querySelectorAll(".kv-row:not(.head, .group)")];
      const offset = key === "ArrowDown" ? 1 : -1;
      for (let index = rows.indexOf(cell.parentElement) + offset; rows[index]; index += offset) {
        if (focusCell(rows[index].querySelector(`[data-grid-cell="${cell.dataset.gridCell}"]`))) {
          event.preventDefault();
          break;
        }
      }
    }
  }

  return { render, issues, values, parameters, count: () => headerCount(getRows()), add, remove, showBulk, toggleRow };
}
