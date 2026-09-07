window.__ModuleLoader__.load({
	id: "dsh-rw",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __DshRwClientExports = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name2 in all)
      __defProp(target, name2, { get: all[name2], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client/index.tsx
  var index_exports = {};
  __export(index_exports, {
    apply: () => apply,
    inject: () => inject,
    name: () => name
  });
  var import_react = __require("react");

  // src/client/locales.ts
  var zh = {
    privateKeyMissing: "\u79C1\u94A5\u7F3A\u5931",
    passwordNotSet: "\u672A\u8BBE\u5BC6\u7801",
    enterDirectory: "\u8FDB\u5165 {name}",
    fileItem: "\u6587\u4EF6\uFF1A{name}",
    loadHostsFailed: "\u83B7\u53D6\u4E3B\u673A\u5217\u8868\u5931\u8D25\uFF1A{error}",
    selectionCancelled: "\u5DF2\u53D6\u6D88\u9009\u62E9",
    localPickerUnavailable: "\u7CFB\u7EDF\u6587\u4EF6\u5939\u9009\u62E9\u5668\u4E0D\u53EF\u7528\uFF0C\u8BF7\u76F4\u63A5\u8F93\u5165\u8DEF\u5F84",
    localPickerFallback: "{error} \u2014 \u8BF7\u76F4\u63A5\u8F93\u5165\u8DEF\u5F84",
    setRemoteWorkspaceFailed: "\u8BBE\u7F6E\u8FDC\u7A0B\u5DE5\u4F5C\u533A\u5931\u8D25",
    aliasInvalid: "\u522B\u540D\u5FC5\u586B\uFF0C\u4EC5\u9650\u5B57\u6BCD\u3001\u6570\u5B57\u3001. _ -\uFF0C\u4E14\u4EE5\u5B57\u6BCD\u6216\u6570\u5B57\u5F00\u5934",
    hostRequired: "\u8BF7\u586B\u5199\u4E3B\u673A\u5730\u5740",
    userRequired: "\u8BF7\u586B\u5199\u7528\u6237\u540D",
    keyPathRequired: "\u8BF7\u586B\u5199\u79C1\u94A5\u8DEF\u5F84",
    passwordRequired: "\u8BF7\u8F93\u5165\u5BC6\u7801",
    connectionSuccess: "\u2713 \u8FDE\u63A5\u6210\u529F\uFF08{latency} ms\uFF09",
    connectionFailed: "\u8FDE\u63A5\u5931\u8D25",
    connectionFailure: "\u2717 {error}{code}",
    hostSavedRefreshFailed: "\u4E3B\u673A\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u5237\u65B0\u5217\u8868\u5931\u8D25\uFF1A{error}",
    removeHostConfirm: "\u786E\u5B9A\u5220\u9664\u624B\u52A8\u4E3B\u673A\u300C{alias}\u300D\u5417\uFF1F\u4EC5\u5220\u9664\u672C\u5730\u767B\u8BB0\uFF0C\u4E0D\u5F71\u54CD\u8FDC\u7A0B\u4E3B\u673A\u3002",
    removeHostFailed: "\u5220\u9664\u4E3B\u673A\u5931\u8D25\uFF1A{error}",
    manualHostHint: "\u4FDD\u5B58\u5230 ~/.dsh/dsh-rw.json\uFF1B\u5BC6\u7801\u548C\u53E3\u4EE4\u4E0D\u4F1A\u56DE\u663E\u3002",
    nameLabel: "\u540D\u79F0",
    aliasPlaceholder: "\u7F16\u8BD1\u673A",
    hostLabel: "\u4E3B\u673A",
    hostPlaceholder: "IP \u6216\u4E3B\u673A\u540D",
    portLabel: "\u7AEF\u53E3",
    userLabel: "\u7528\u6237",
    authMethodLabel: "\u8BA4\u8BC1\u65B9\u5F0F",
    keyPathLabel: "\u79C1\u94A5\u8DEF\u5F84",
    passwordLabel: "\u5BC6\u7801",
    passphraseLabel: "\u79C1\u94A5\u53E3\u4EE4",
    optionalPlaceholder: "\u53EF\u9009",
    passwordPlaceholder: "\u8F93\u5165\u5BC6\u7801",
    clear: "\u6E05\u7A7A",
    testing: "\u6D4B\u8BD5\u4E2D\u2026",
    testConnection: "\u6D4B\u8BD5\u8FDE\u63A5",
    saving: "\u4FDD\u5B58\u4E2D\u2026",
    save: "\u4FDD\u5B58",
    back: "\u8FD4\u56DE",
    chooseWorkDirectory: "\u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55",
    localCardTitle: "\u672C\u673A",
    remoteCardTitle: "\u8FDC\u7A0B",
    localDirectory: "\u672C\u673A\u76EE\u5F55",
    remoteWorkspace: "\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
    addRemoteHost: "\u6DFB\u52A0\u8FDC\u7A0B\u4E3B\u673A",
    localPickerHint: "\u9009\u62E9\u6587\u4EF6\u5939\uFF0C\u6216\u76F4\u63A5\u8F93\u5165\u8DEF\u5F84\u3002",
    localPathLabel: "\u672C\u673A\u8DEF\u5F84",
    localPathPlaceholder: "/Users/you/project",
    useDirectory: "\u9009\u7528",
    opening: "\u6253\u5F00\u4E2D\u2026",
    openSystemPicker: "\u6253\u5F00\u7CFB\u7EDF\u6587\u4EF6\u5939\u9009\u62E9\u5668",
    workspaceNamePlaceholder: "\u5DE5\u4F5C\u533A\u540D\u79F0\uFF08\u53EF\u9009\uFF09",
    remoteHostLabel: "\u8FDC\u7A0B\u4E3B\u673A",
    addHost: "+ \u6DFB\u52A0\u4E3B\u673A",
    removeManualHostTitle: "\u5220\u9664\u624B\u52A8\u4E3B\u673A {alias}",
    remove: "\u5220\u9664",
    choose: "\u2014 \u9009\u62E9 \u2014",
    noHosts: "\u672A\u53D1\u73B0 SSH \u4E3B\u673A\uFF0C\u8BF7\u5728\u8FD9\u91CC\u6DFB\u52A0\u6216\u914D\u7F6E ~/.ssh/config\u3002",
    remotePathLabel: "\u8FDC\u7A0B\u8DEF\u5F84",
    parentDirectory: "\u4E0A\u4E00\u7EA7",
    remotePathPlaceholder: "~/project \u6216 /srv/project",
    chooseHostFirst: "\u5148\u9009\u62E9\u8FDC\u7A0B\u4E3B\u673A",
    loading: "\u52A0\u8F7D\u4E2D\u2026",
    noMatchingDirectories: "\uFF08\u65E0\u5339\u914D\u76EE\u5F55\uFF09",
    cancel: "\u53D6\u6D88",
    setting: "\u8BBE\u7F6E\u4E2D\u2026",
    setRemoteWorkspace: "\u8BBE\u4E3A\u8FDC\u7A0B\u5DE5\u4F5C\u533A"
  };
  var en = {
    privateKeyMissing: "Private key unavailable",
    passwordNotSet: "Password not set",
    enterDirectory: "Open {name}",
    fileItem: "File: {name}",
    loadHostsFailed: "Failed to load hosts: {error}",
    selectionCancelled: "Selection cancelled",
    localPickerUnavailable: "System folder picker unavailable. Enter a path instead.",
    localPickerFallback: "{error} \u2014 enter a path instead",
    setRemoteWorkspaceFailed: "Failed to set the remote workspace",
    aliasInvalid: "Alias is required. Use letters, numbers, '.', '_' or '-', and start with a letter or number.",
    hostRequired: "Enter a host address",
    userRequired: "Enter a username",
    keyPathRequired: "Enter a private key path",
    passwordRequired: "Enter a password",
    connectionSuccess: "\u2713 Connected ({latency} ms)",
    connectionFailed: "Connection failed",
    connectionFailure: "\u2717 {error}{code}",
    hostSavedRefreshFailed: "The host was saved, but the host list could not be refreshed: {error}",
    removeHostConfirm: "Remove manual host \u201C{alias}\u201D? This only removes the local entry and does not affect the remote host.",
    removeHostFailed: "Failed to remove host: {error}",
    manualHostHint: "Saved in ~/.dsh/dsh-rw.json. Passwords and passphrases stay hidden.",
    nameLabel: "Name",
    aliasPlaceholder: "build-server",
    hostLabel: "Host",
    hostPlaceholder: "IP or hostname",
    portLabel: "Port",
    userLabel: "User",
    authMethodLabel: "Authentication",
    keyPathLabel: "Private key",
    passwordLabel: "Password",
    passphraseLabel: "Key passphrase",
    optionalPlaceholder: "Optional",
    passwordPlaceholder: "Enter password",
    clear: "Clear",
    testing: "Testing\u2026",
    testConnection: "Test connection",
    saving: "Saving\u2026",
    save: "Save",
    back: "Back",
    chooseWorkDirectory: "Choose a work directory",
    localCardTitle: "LOCAL",
    remoteCardTitle: "REMOTE",
    localDirectory: "Local directory",
    remoteWorkspace: "Remote workspace",
    addRemoteHost: "Add remote host",
    localPickerHint: "Choose a folder or enter its path.",
    localPathLabel: "Local path",
    localPathPlaceholder: "/Users/you/project",
    useDirectory: "Use",
    opening: "Opening\u2026",
    openSystemPicker: "Open system folder picker",
    workspaceNamePlaceholder: "Workspace name (optional)",
    remoteHostLabel: "Remote host",
    addHost: "+ Add host",
    removeManualHostTitle: "Remove manual host {alias}",
    remove: "Remove",
    choose: "\u2014 Choose \u2014",
    noHosts: "No SSH hosts found. Add one here or configure ~/.ssh/config.",
    remotePathLabel: "Remote path",
    parentDirectory: "Parent directory",
    remotePathPlaceholder: "~/project or /srv/project",
    chooseHostFirst: "Choose a remote host first",
    loading: "Loading\u2026",
    noMatchingDirectories: "(No matching directories)",
    cancel: "Cancel",
    setting: "Setting\u2026",
    setRemoteWorkspace: "Use as remote workspace"
  };

  // src/client/index.tsx
  var import_jsx_runtime = __require("react/jsx-runtime");
  var name = "dsh-rw";
  async function api(method, url, body) {
    const headers = {};
    const init = { method, headers };
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data && (data.error || data.message) || `HTTP ${res.status}`);
    return data;
  }
  function errText(e) {
    const m = e?.message;
    return String(typeof m === "string" && m ? m : e);
  }
  function drillable(it) {
    return it.type === "dir" || it.type === "symlink";
  }
  function hostProblem(h, t) {
    if (h.authKind === "key") return h.keyReady ? null : t("privateKeyMissing");
    return h.passwordSet ? null : t("passwordNotSet");
  }
  var ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  var emptyAddForm = () => ({ alias: "", host: "", port: "22", user: "root", authKind: "key", keyPath: "", passphrase: "", password: "" });
  var v = (name2, fb) => `var(${name2}, ${fb})`;
  var T = {
    bg: v("--dsw-alias-bg-layer-1", "rgba(128,128,128,0.07)"),
    bgHover: v("--dsw-alias-bg-layer-2", "rgba(128,128,128,0.14)"),
    border: v("--dsw-alias-border-l2", "rgba(128,128,128,0.35)"),
    borderStrong: v("--dsw-alias-border-l3", "rgba(128,128,128,0.5)"),
    accent: v("--dsw-alias-accent-primary", "#4c8dff"),
    danger: v("--dsw-static-red-500", "#e06c75"),
    ok: v("--dsw-static-green-500", "#4caf7d"),
    radius: 10,
    muted: v("--dsw-alias-label-tertiary", "rgba(128,128,128,0.7)"),
    label: v("--dsw-alias-label-primary", "#e4e4e7")
  };
  var panelBg = v("--dsw-alias-bg-layer-1", "#18181b");
  var inputS = { flex: 1, minWidth: 0, width: "100%", boxSizing: "border-box", padding: "9px 14px", borderRadius: T.radius, border: "1px solid " + T.border, background: T.bg, color: T.label, outline: "none", fontFamily: "inherit", fontSize: 14, transition: "border-color .15s" };
  var buttonS = { padding: "9px 16px", borderRadius: T.radius, border: "1px solid " + T.border, background: T.bg, color: T.label, cursor: "pointer", fontFamily: "inherit", fontSize: 14, whiteSpace: "nowrap", transition: "background .15s, border-color .15s" };
  var labelS = { fontSize: 14, color: T.muted };
  function Btn(props) {
    const [hov, setHov] = (0, import_react.useState)(false);
    const base = props.primary ? { ...buttonS, background: "#f4f4f5", border: "1px solid #f4f4f5", color: "#18181b", fontWeight: 600 } : props.danger ? { ...buttonS, color: T.danger } : buttonS;
    const hover = hov && !props.disabled ? props.primary ? { filter: "brightness(0.92)" } : { background: T.bgHover, border: "1px solid " + T.borderStrong } : {};
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        onMouseEnter: () => setHov(true),
        onMouseLeave: () => setHov(false),
        style: { ...base, ...hover, ...props.disabled ? { opacity: 0.55, cursor: "default" } : {}, ...props.style || {} },
        children: props.children
      }
    );
  }
  function TextInput(props) {
    const [focus, setFocus] = (0, import_react.useState)(false);
    const { style, onFocus, onBlur, ...rest } = props;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        ...rest,
        style: { ...inputS, ...focus ? { border: "1px solid " + T.accent } : {}, ...style || {} },
        onFocus: (e) => {
          setFocus(true);
          if (onFocus) onFocus(e);
        },
        onBlur: (e) => {
          setFocus(false);
          if (onBlur) onBlur(e);
        }
      }
    );
  }
  function SvgFolder(props) {
    const s = props.size ?? 15;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }) });
  }
  function SvgGlobe(props) {
    const s = props.size ?? 15;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "12", cy: "12", r: "9" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M3 12h18" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9s1.4-6.4 3.9-9z" })
    ] });
  }
  function SvgLink(props) {
    const s = props.size ?? 15;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" })
    ] });
  }
  function SvgArrowUp(props) {
    const s = props.size ?? 16;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M12 19V5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M5 12l7-7 7 7" })
    ] });
  }
  function SvgChevronDown(props) {
    const s = props.size ?? 16;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M6 9l6 6 6-6" }) });
  }
  function SvgChevronRight(props) {
    const s = props.size ?? 16;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M9 6l6 6-6 6" }) });
  }
  function SvgArrowLeft(props) {
    const s = props.size ?? 16;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M19 12H5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M12 19l-7-7 7-7" })
    ] });
  }
  function SvgArrowRight(props) {
    const s = props.size ?? 16;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M5 12h14" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M12 5l7 7-7 7" })
    ] });
  }
  function SvgMonitor(props) {
    const s = props.size ?? 16;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "3", y: "4", width: "18", height: "12", rx: "2" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8 20h8M12 16v4" })
    ] });
  }
  function SvgFile(props) {
    const s = props.size ?? 15;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M14 3v5h5" })
    ] });
  }
  function SvgX(props) {
    const s = props.size ?? 14;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M18 6L6 18M6 6l12 12" }) });
  }
  function IconInput(props) {
    const [focus, setFocus] = (0, import_react.useState)(false);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "stretch",
          border: "1px solid " + (focus ? T.accent : T.border),
          borderRadius: T.radius,
          background: T.bg,
          overflow: "hidden",
          transition: "border-color .15s"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { width: 44, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, borderRight: "1px solid " + T.border }, children: props.icon }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              value: props.value,
              placeholder: props.placeholder,
              onChange: props.onChange,
              onFocus: () => setFocus(true),
              onBlur: () => setFocus(false),
              style: { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: T.label, padding: "9px 14px", fontSize: 14 }
            }
          )
        ]
      }
    );
  }
  function FormRow(props) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, lineHeight: 1.2, color: T.muted, whiteSpace: "nowrap" }, children: props.label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { minWidth: 0, display: "flex", gap: 8 }, children: props.children })
    ] });
  }
  function SingleLine(props) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "div",
      {
        title: props.text,
        style: { color: props.color ?? T.muted, fontSize: 12, lineHeight: 1.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...props.style },
        children: props.text
      }
    );
  }
  function DirRow(props) {
    const [hov, setHov] = (0, import_react.useState)(false);
    const { item, drill } = props;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        title: props.t(drill ? "enterDirectory" : "fileItem", { name: item.name }),
        onClick: drill ? props.onEnter : void 0,
        onMouseEnter: () => setHov(true),
        onMouseLeave: () => setHov(false),
        style: { padding: "8px 12px", cursor: drill ? "pointer" : "default", color: T.label, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", gap: 10, alignItems: "center", fontSize: 14, borderRadius: 6, background: hov && drill ? T.bgHover : "transparent" },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: T.muted, display: "flex", flexShrink: 0 }, children: item.type === "dir" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgFolder, {}) : item.type === "symlink" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgLink, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgFile, {}) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { overflow: "hidden", textOverflow: "ellipsis", flex: 1 }, children: item.name }),
          drill ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: T.muted, display: "flex" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgChevronRight, { size: 13 }) }) : null
        ]
      }
    );
  }
  function FlowCard(props) {
    const [hov, setHov] = (0, import_react.useState)(false);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        onClick: props.onClick,
        onMouseEnter: () => setHov(true),
        onMouseLeave: () => setHov(false),
        style: {
          flex: 1,
          border: "1px solid " + (hov ? T.accent : T.border),
          borderRadius: 12,
          padding: "18px 16px",
          cursor: "pointer",
          background: hov ? T.bgHover : T.bg,
          display: "flex",
          alignItems: "center",
          gap: 12,
          transform: hov ? "translateY(-1px)" : "none",
          boxShadow: hov ? "0 6px 20px rgba(0,0,0,0.25)" : "none",
          transition: "border-color .15s, background .15s, transform .15s, box-shadow .15s"
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: hov ? T.accent : T.label, display: "flex", flexShrink: 0, transition: "color .15s" }, children: props.icon }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, minWidth: 0, fontWeight: 650, fontSize: 13, letterSpacing: "0.035em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: props.title }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: hov ? T.accent : T.muted, display: "flex", flexShrink: 0, transition: "color .15s" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgArrowRight, { size: 17 }) })
        ]
      }
    );
  }
  function DirPicker(props) {
    const { open, busy, onPicked, onCancel, locale, t } = props;
    const localeRevision = (0, import_react.useSyncExternalStore)(
      (0, import_react.useCallback)((callback) => locale.subscribe(callback), [locale]),
      (0, import_react.useCallback)(() => locale.getSnapshot().revision, [locale])
    );
    void localeRevision;
    const [view, setView] = (0, import_react.useState)("cards");
    const [hosts, setHosts] = (0, import_react.useState)([]);
    const [alias, setAlias] = (0, import_react.useState)("");
    const [path, setPath] = (0, import_react.useState)("");
    const [localPath, setLocalPath] = (0, import_react.useState)("");
    const [wsName, setWsName] = (0, import_react.useState)("");
    const [err, setErr] = (0, import_react.useState)("");
    const [loading, setLoading] = (0, import_react.useState)(false);
    const [dirItems, setDirItems] = (0, import_react.useState)([]);
    const [dirBase, setDirBase] = (0, import_react.useState)("");
    const suggestTimer = (0, import_react.useRef)(null);
    const [form, setForm] = (0, import_react.useState)(emptyAddForm);
    const [formErr, setFormErr] = (0, import_react.useState)("");
    const [testing, setTesting] = (0, import_react.useState)(false);
    const [saving, setSaving] = (0, import_react.useState)(false);
    const [testMsg, setTestMsg] = (0, import_react.useState)("");
    const [testOk, setTestOk] = (0, import_react.useState)(false);
    (0, import_react.useEffect)(() => {
      if (!open) return;
      setView("cards");
      setWsName("");
      setErr("");
      api("GET", "/api/dsh-rw/status").then((r) => {
        const list = Array.isArray(r.hosts) ? r.hosts : [];
        setHosts(list);
        const cur = r.current && typeof r.current.alias === "string" ? r.current.alias : "";
        setAlias(cur || (list[0] ? list[0].alias : ""));
      }).catch((e) => setErr(t("loadHostsFailed", { error: errText(e) })));
    }, [open, t]);
    (0, import_react.useEffect)(
      () => () => {
        if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current);
      },
      []
    );
    const loadDir = (a, dir, sync) => {
      if (!a) return;
      setLoading(true);
      setErr("");
      api("GET", `/api/dsh-rw/ls?alias=${encodeURIComponent(a)}&path=${encodeURIComponent(dir || "/")}`).then((res) => {
        const real = res.path || dir || "/";
        setDirBase(real);
        if (sync) setPath(real);
        setDirItems((Array.isArray(res.items) ? res.items : []).filter(drillable).slice(0, 400));
      }).catch((e) => {
        setDirItems([]);
        setErr(errText(e));
      }).finally(() => setLoading(false));
    };
    const completePath = (raw, aid) => {
      const a = aid || alias;
      const t2 = String(raw || "").trim();
      if (!a || !t2) {
        setDirItems([]);
        return;
      }
      const slash = t2.lastIndexOf("/");
      const parent = slash <= 0 ? "/" : t2.slice(0, slash);
      const lastSeg = slash < 0 ? t2 : t2.slice(slash + 1);
      api("GET", `/api/dsh-rw/ls?alias=${encodeURIComponent(a)}&path=${encodeURIComponent(parent)}`).then((res) => {
        const list = Array.isArray(res.items) ? res.items : [];
        setDirBase(res.path || parent);
        setDirItems(
          list.filter((it) => drillable(it) && it.name.toLowerCase().startsWith(lastSeg.toLowerCase())).slice(0, 400)
        );
      }).catch(() => setDirItems([]));
    };
    const onPathChange = (raw) => {
      setPath(raw);
      setErr("");
      if (suggestTimer.current !== null) window.clearTimeout(suggestTimer.current);
      suggestTimer.current = window.setTimeout(() => completePath(raw), 220);
    };
    const selectDir = (name2) => {
      const base = dirBase || "/";
      const next = base === "/" ? "/" + name2 : base + "/" + name2;
      setPath(next);
      setErr("");
      loadDir(alias, next);
    };
    const goUp = () => {
      const norm = String(path || "").replace(/\/+$/, "");
      const idx = norm.lastIndexOf("/");
      const parent = idx <= 0 ? "/" : norm.slice(0, idx);
      setPath(parent);
      setErr("");
      loadDir(alias, parent);
    };
    const chooseLocal = () => {
      setLoading(true);
      setErr("");
      api("POST", "/api/dsh-rw/local-pick").then((r) => {
        if (r && r.path) onPicked(String(r.path));
        else if (r && r.cancelled) setErr(t("selectionCancelled"));
        else setErr(r && r.error || t("localPickerUnavailable"));
      }).catch((e) => setErr(t("localPickerFallback", { error: errText(e) }))).finally(() => setLoading(false));
    };
    const openFlow = (t2) => {
      setView(t2);
      setErr("");
      if (t2 === "remote" && alias) {
        const start = path.trim();
        if (start) {
          loadDir(alias, start);
        } else {
          setPath("~/");
          loadDir(alias, "~/", true);
        }
      }
    };
    const commitPath = (p) => {
      const target = String(p || "").trim();
      if (!target || !alias || busy) return;
      const name2 = wsName.trim();
      api("POST", "/api/dsh-rw/workspace", { alias, path: target, ...name2 ? { name: name2 } : {} }).then((res) => {
        if (res && res.ok && res.placeholderDir) onPicked(String(res.placeholderDir));
        else setErr(res && res.error || t("setRemoteWorkspaceFailed"));
      }).catch((e) => setErr(errText(e)));
    };
    const updForm = (patch) => {
      setForm((f) => ({ ...f, ...patch }));
      setFormErr("");
      setTestMsg("");
    };
    const resetAddForm = () => {
      setForm(emptyAddForm());
      setFormErr("");
      setTestMsg("");
      setTestOk(false);
    };
    const addFormError = (forSave) => {
      if (forSave && !ALIAS_RE.test(form.alias.trim())) return t("aliasInvalid");
      if (!form.host.trim()) return t("hostRequired");
      if (!form.user.trim()) return t("userRequired");
      if (form.authKind === "key" && !form.keyPath.trim()) return t("keyPathRequired");
      if (form.authKind === "password" && !form.password) return t("passwordRequired");
      return "";
    };
    const addFormPayload = () => ({
      host: form.host.trim(),
      port: Number.parseInt(form.port, 10) || 22,
      user: form.user.trim(),
      ...form.authKind === "key" ? { keyPath: form.keyPath.trim(), ...form.passphrase ? { passphrase: form.passphrase } : {} } : { password: form.password }
    });
    const refreshHosts = () => api("GET", "/api/dsh-rw/status").then((r) => {
      const list = Array.isArray(r.hosts) ? r.hosts : [];
      setHosts(list);
      return list;
    });
    const testNewHost = () => {
      const msg = addFormError(false);
      if (msg) {
        setFormErr(msg);
        return;
      }
      setTesting(true);
      setFormErr("");
      setTestMsg("");
      api("POST", "/api/dsh-rw/test", addFormPayload()).then((r) => {
        if (r && r.ok) {
          setTestOk(true);
          setTestMsg(t("connectionSuccess", { latency: r.latencyMs ?? 0 }));
        } else {
          setTestOk(false);
          setTestMsg(t("connectionFailure", {
            error: r && r.error || t("connectionFailed"),
            code: r && r.code ? ` [${r.code}]` : ""
          }));
        }
      }).catch((e) => {
        setTestOk(false);
        setTestMsg("\u2717 " + errText(e));
      }).finally(() => setTesting(false));
    };
    const saveNewHost = () => {
      const msg = addFormError(true);
      if (msg) {
        setFormErr(msg);
        return;
      }
      const newAlias = form.alias.trim();
      setSaving(true);
      setFormErr("");
      api("POST", "/api/dsh-rw/hosts", { alias: newAlias, ...addFormPayload() }).then(() => {
        resetAddForm();
        setView("remote");
        refreshHosts().then(() => {
          setAlias(newAlias);
          setErr("");
          setPath("~/");
          loadDir(newAlias, "~/", true);
        }).catch((e) => setErr(t("hostSavedRefreshFailed", { error: errText(e) })));
      }).catch((e) => setFormErr(errText(e))).finally(() => setSaving(false));
    };
    const removeManualHost = (h) => {
      if (!window.confirm(t("removeHostConfirm", { alias: h.alias }))) return;
      setErr("");
      api("DELETE", "/api/dsh-rw/hosts", { alias: h.alias }).then(() => refreshHosts()).then((list) => {
        if (alias === h.alias) {
          const next = list[0] ? list[0].alias : "";
          setAlias(next);
          setDirItems([]);
          if (next) {
            setPath("~/");
            loadDir(next, "~/", true);
          }
        }
      }).catch((e) => setErr(t("removeHostFailed", { error: errText(e) })));
    };
    function renderAddForm() {
      const busyForm = testing || saving;
      const seg = (kind, label) => {
        const active = form.authKind === kind;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            onClick: () => updForm({ authKind: kind }),
            style: {
              ...buttonS,
              flex: 1,
              border: "1px solid " + (active ? T.accent : T.border),
              background: active ? T.bgHover : "transparent",
              color: active ? T.accent : T.label,
              fontWeight: active ? 600 : 400
            },
            children: label
          }
        );
      };
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 14 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: t("manualHostHint") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.35fr)", gap: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("nameLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.alias, onChange: (e) => updForm({ alias: e.target.value }), placeholder: t("aliasPlaceholder") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("hostLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.host, onChange: (e) => updForm({ host: e.target.value }), placeholder: t("hostPlaceholder") }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 112px", gap: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("userLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.user, onChange: (e) => updForm({ user: e.target.value }), placeholder: "root" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("portLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.port, onChange: (e) => updForm({ port: e.target.value }), placeholder: "22", inputMode: "numeric" }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(FormRow, { label: t("authMethodLabel"), children: [
          seg("key", t("keyPathLabel")),
          seg("password", t("passwordLabel"))
        ] }),
        form.authKind === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 0.9fr)", gap: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("keyPathLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.keyPath, onChange: (e) => updForm({ keyPath: e.target.value }), placeholder: "~/.ssh/id_ed25519" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("passphraseLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.passphrase, onChange: (e) => updForm({ passphrase: e.target.value }), type: "password", placeholder: t("optionalPlaceholder") }) })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormRow, { label: t("passwordLabel"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: form.password, onChange: (e) => updForm({ password: e.target.value }), type: "password", placeholder: t("passwordPlaceholder") }) }),
        formErr ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: formErr, color: T.danger }) : null,
        testMsg ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: testMsg, color: testOk ? T.ok : T.danger }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid " + T.border, paddingTop: 12, marginTop: 2 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: resetAddForm, disabled: busyForm, children: t("clear") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { onClick: testNewHost, disabled: busyForm, children: testing ? t("testing") : t("testConnection") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { primary: true, onClick: saveNewHost, disabled: busyForm, children: saving ? t("saving") : t("save") })
        ] })
      ] });
    }
    if (!open) return null;
    const selectedHost = hosts.find((h) => h.alias === alias);
    const card = (flow, icon, title) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FlowCard, { onClick: () => openFlow(flow), icon, title });
    const backBtn = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Btn,
      {
        title: t("back"),
        style: { width: 32, height: 32, padding: 0, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
        onClick: () => {
          if (view === "addHost") {
            resetAddForm();
            setView("remote");
          } else {
            setView("cards");
          }
        },
        disabled: busy,
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgArrowLeft, { size: 16 })
      }
    );
    const viewTitle = view === "cards" ? t("chooseWorkDirectory") : view === "local" ? t("localDirectory") : view === "remote" ? t("remoteWorkspace") : t("addRemoteHost");
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "div",
      {
        style: { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
        onClick: () => {
          if (!busy) onCancel();
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            style: { background: panelBg, border: "1px solid " + T.borderStrong, borderRadius: 14, boxShadow: "0 16px 56px rgba(0,0,0,0.55)", width: "min(640px, 94vw)", padding: 22, boxSizing: "border-box" },
            onClick: (e) => e.stopPropagation(),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }, children: [
                view !== "cards" ? backBtn : null,
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, children: viewTitle }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  Btn,
                  {
                    style: { padding: "4px 6px", border: "1px solid transparent", background: "transparent", color: T.muted, display: "flex", alignItems: "center" },
                    onClick: () => {
                      if (!busy) onCancel();
                    },
                    disabled: busy,
                    children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgX, {})
                  }
                )
              ] }),
              view === "cards" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 12 }, children: [
                card("local", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgMonitor, { size: 22 }), t("localCardTitle")),
                card("remote", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgGlobe, { size: 22 }), t("remoteCardTitle"))
              ] }) : null,
              view === "local" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 12 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: t("localPickerHint") }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: labelS, children: t("localPathLabel") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8 }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TextInput, { value: localPath, onChange: (e) => setLocalPath(e.target.value), placeholder: t("localPathPlaceholder") }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { primary: true, onClick: () => localPath.trim() ? onPicked(localPath.trim()) : void 0, disabled: !localPath.trim(), children: t("useDirectory") })
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { style: { alignSelf: "flex-start" }, onClick: chooseLocal, disabled: loading, children: loading ? t("opening") : t("openSystemPicker") }),
                err ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: err, color: T.danger }) : null
              ] }) : null,
              view === "remote" || view === "addHost" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", flexDirection: "column", gap: 18 }, children: view === "addHost" ? renderAddForm() : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(IconInput, { icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgFolder, {}), value: wsName, onChange: (e) => setWsName(e.target.value), placeholder: t("workspaceNamePlaceholder") }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...labelS, flex: 1 }, children: t("remoteHostLabel") }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      Btn,
                      {
                        style: { padding: "2px 9px", border: "1px solid transparent", background: "transparent", color: T.accent, fontSize: 12, whiteSpace: "nowrap" },
                        onClick: () => {
                          resetAddForm();
                          setView("addHost");
                        },
                        children: t("addHost")
                      }
                    ),
                    selectedHost && selectedHost.source === "manual" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { danger: true, style: { padding: "2px 9px", fontSize: 12, whiteSpace: "nowrap" }, title: t("removeManualHostTitle", { alias: selectedHost.alias }), onClick: () => removeManualHost(selectedHost), children: t("remove") }) : null
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { position: "relative" }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: T.accent, display: "flex", pointerEvents: "none", zIndex: 1 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgGlobe, {}) }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                      "select",
                      {
                        value: alias,
                        onChange: (e) => {
                          const a = e.target.value;
                          setAlias(a);
                          setErr("");
                          if (a) {
                            setPath("~/");
                            loadDir(a, "~/", true);
                          } else {
                            setDirItems([]);
                          }
                        },
                        style: { ...inputS, width: "100%", boxSizing: "border-box", paddingLeft: 40, paddingRight: 36, appearance: "none", WebkitAppearance: "none" },
                        children: [
                          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: t("choose") }),
                          hosts.map((h) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: h.alias, disabled: hostProblem(h, t) !== null, children: h.alias }, h.alias))
                        ]
                      }
                    ),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: T.muted, display: "flex", pointerEvents: "none" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgChevronDown, {}) })
                  ] })
                ] }),
                hosts.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: t("noHosts") }) : null,
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: labelS, children: t("remotePathLabel") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 10, alignItems: "stretch" }, children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { style: { padding: "0 12px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }, title: t("parentDirectory"), onClick: goUp, disabled: !alias, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgArrowUp, {}) }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      TextInput,
                      {
                        value: path,
                        onChange: (e) => onPathChange(e.target.value),
                        onFocus: () => completePath(path),
                        placeholder: alias ? t("remotePathPlaceholder") : t("chooseHostFirst"),
                        disabled: !alias,
                        style: { flex: 1, minWidth: 120 }
                      }
                    )
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { border: "1px solid " + T.border, borderRadius: 10, background: T.bg, maxHeight: 240, overflowY: "auto", overflowX: "hidden", padding: 4 }, children: !alias ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: t("chooseHostFirst"), style: { padding: 12 } }) : loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: t("loading"), style: { padding: 12 } }) : dirItems.length ? dirItems.map((it, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DirRow, { item: it, drill: true, onEnter: () => selectDir(it.name), t }, it.name + "-" + i)) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: t("noMatchingDirectories"), style: { padding: 12 } }) })
                ] }),
                err ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SingleLine, { text: err, color: T.danger }) : null,
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", borderTop: "1px solid " + T.border, paddingTop: 12, marginTop: 2 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { style: { border: "1px solid transparent", background: "transparent", color: T.muted }, onClick: onCancel, disabled: busy, children: t("cancel") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { primary: true, onClick: () => commitPath(path), disabled: busy || !alias || !path.trim(), children: busy ? t("setting") : t("setRemoteWorkspace") })
                ] })
              ] }) }) : null,
              view === "local" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Btn, { style: { border: "1px solid transparent", background: "transparent", color: T.muted }, onClick: onCancel, children: t("cancel") }) }) : null
            ]
          }
        )
      }
    );
  }
  var LOCALE_NS = "dsh-rw";
  var inject = ["slots", "locale"];
  function apply(ctx) {
    const get = ctx?.get;
    if (typeof get !== "function") return;
    const slots = get.call(ctx, "slots");
    const locale = get.call(ctx, "locale");
    if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function" || !locale || typeof locale.register !== "function" || typeof locale.bind !== "function" || typeof locale.subscribe !== "function" || typeof locale.getSnapshot !== "function") return;
    const registerDictionaries = () => locale.register(LOCALE_NS, { zh, en });
    const effect = ctx.effect;
    if (typeof effect === "function") {
      effect.call(ctx, registerDictionaries, "dsh-rw: locale dictionaries");
    } else {
      registerDictionaries();
    }
    const t = locale.bind(LOCALE_NS);
    const LocalizedDirPicker = (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DirPicker, { ...props, locale, t });
    slots.inject(
      "conversation.hero.workspace.directoryFlow",
      () => slots.inject("sidebar.workspaces.directoryFlow", function* () {
        yield slots.register({ name: "conversation.hero.workspace.directoryFlow", id: "dsh-rw", priority: -100 }, LocalizedDirPicker);
        yield slots.register({ name: "sidebar.workspaces.directoryFlow", id: "dsh-rw", priority: -100 }, LocalizedDirPicker);
      })
    );
  }
  return __toCommonJS(index_exports);
})();
		Object.assign(module.exports, __DshRwClientExports);
		return module.exports;
	},
});
