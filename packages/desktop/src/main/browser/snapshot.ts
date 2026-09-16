import type { ElementRef } from "@cookiemonster/cm-browser/protocol"

const MAX_ELEMENTS = 200
const MAX_ELEMENT_TEXT = 160
const MAX_VISIBLE_TEXT = 12_000

export type SnapshotElement = Omit<ElementRef, "ref"> & {
  readonly token: string
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

export type PageSnapshot = {
  readonly generation: string
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly truncated: boolean
  readonly elements: readonly SnapshotElement[]
}

// Only execute in cm-browser-snapshot, never the page's main world.
// ponytail: bounded DOM naming subset, not an AX/ARIA engine; no editable values or persistent observers.
export const snapshotScript = (
  id: string,
  reference?: { generation: string; token: string; fill?: boolean },
) => `(() => {
  const id = ${JSON.stringify(id)}, reference = ${JSON.stringify(reference ?? null)};
  const newToken = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("");
  let state = globalThis.__cmSnapshot;
  if (!state || state.document !== document || state.root !== document.documentElement) {
    if (reference) return null;
    state = globalThis.__cmSnapshot = {
      document, root: document.documentElement, generation: newToken(),
      tokens: new WeakMap(), snapshots: new Map()
    };
  }
  let truncated = false, visits = 0, textVisits = 0, characters = 48000, manualSlots = 0;
  const compact = (value, limit = ${MAX_ELEMENT_TEXT}) => {
    if (value.length > limit) truncated = true;
    return value.slice(0, limit).replace(/\\s+/g, " ").trim();
  };
  const attr = (el, name, limit = ${MAX_ELEMENT_TEXT}) => compact(el.getAttribute(name) || "", limit);
  const parent = node => node.assignedSlot || node.parentNode || (node instanceof ShadowRoot ? node.host : null);
  const chain = el => {
    const result = [];
    for (let node = el; node; node = parent(node)) {
      if (result.length >= 192) return null;
      result.push(node, node.parentNode, node.getRootNode());
      if (node === document) return result;
    }
    return null;
  };
  const sensitive = el => {
    for (let node = el, depth = 0; node; node = parent(node)) {
      if (++depth > 64) { truncated = true; return true; }
      if (!(node instanceof Element)) continue;
      if (node.matches("input,textarea") || node.isContentEditable) return true;
      const editable = node.getAttribute("contenteditable");
      if (editable !== null && editable !== "false") return true;
    }
    return false;
  };
  const visible = el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth &&
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const disabled = el => {
    if (el.matches(":disabled")) return true;
    for (let node = el, depth = 0; node; node = parent(node)) {
      if (++depth > 64) return true;
      if (node instanceof Element && (node.hasAttribute("inert") || attr(node, "aria-disabled") === "true")) return true;
    }
    return false;
  };
  const fillKind = el => {
    if (el instanceof HTMLInputElement)
      return !el.readOnly && ["text","search","email","url","tel","password","number"].includes(el.type) ? "input:" + el.type : "";
    if (el instanceof HTMLTextAreaElement) return el.readOnly ? "" : "textarea";
    if (el.matches("button,select,option,a[href],summary")) return "";
    return el.isContentEditable ? "contenteditable:" + el.contentEditable : "";
  };
  const roleOf = el => {
    const explicit = attr(el, "role", 64).split(" ")[0];
    if (explicit) return explicit;
    if (el.matches("button,summary,input[type=button],input[type=submit],input[type=reset],input[type=image]")) return "button";
    if (el.matches("a[href],area[href]")) return "link";
    if (el.matches("input[type=checkbox]")) return "checkbox";
    if (el.matches("input[type=radio]")) return "radio";
    if (el.matches("input[type=range]")) return "slider";
    if (el.matches("input[type=number]")) return "spinbutton";
    if (el.matches("select")) return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (el.matches("option")) return "option";
    if (el.matches("input:not([type=hidden]),textarea") || el.isContentEditable) return "textbox";
    return "";
  };
  const interactive = el => el.matches("a[href],button,input:not([type=hidden]),select,textarea,summary,option,[contenteditable],[tabindex]") ||
    ["button","link","tab","menuitem","menuitemcheckbox","menuitemradio","checkbox","radio","switch","option","textbox","combobox","listbox","slider","spinbutton","treeitem"].includes(roleOf(el));
  const ignored = el => el.matches("script,style,noscript,template,iframe,object,embed");
  const content = (root, limit) => {
    if (sensitive(root)) return "";
    let text = "";
    const seen = new Set();
    const walk = (node, depth) => {
      if (text.length >= limit || characters <= 0 || textVisits >= 4000) { truncated = true; return; }
      textVisits++;
      if (depth > 64) { truncated = true; return; }
      if (seen.has(node)) return;
      seen.add(node);
      if (node instanceof Element && (ignored(node) || sensitive(node))) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const count = Math.min(node.length, limit - text.length, characters);
        const part = node.substringData(0, count);
        characters -= count;
        if (count < node.length) truncated = true;
        text += part;
        return;
      }
      if (node instanceof Element && node.matches("img")) {
        const part = attr(node, "alt", Math.min(limit - text.length, characters));
        characters -= part.length;
        text += part;
      }
      if (node instanceof HTMLSlotElement) {
        const owner = node.getRootNode();
        if (owner instanceof ShadowRoot) {
          // ponytail: manual assignment order is not DOM order; omit rather than allocate assignedNodes.
          if (owner.slotAssignment === "manual") { truncated = true; manualSlots++; return; }
          let assigned = false;
          // Scan lazily: an exhausted budget cannot prove that fallback is rendered.
          for (let child = owner.host.firstChild; child; child = child.nextSibling) {
            if (text.length >= limit || characters <= 0 || textVisits >= 4000) { truncated = true; return; }
            textVisits++;
            if (child.assignedSlot !== node) continue;
            assigned = true;
            walk(child, depth + 1);
          }
          if (assigned) return;
        }
      }
      if (node instanceof Element && node.shadowRoot) {
        walk(node.shadowRoot, depth + 1);
        return;
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child, depth + 1);
        if (text.length >= limit || characters <= 0 || textVisits >= 4000) { truncated = true; break; }
      }
    };
    walk(root, 0);
    return compact(text, limit);
  };
  const nameOf = el => {
    const root = el.getRootNode(), omitted = manualSlots;
    const ids = attr(el, "aria-labelledby", 512).split(/\\s+/).slice(0, 8);
    let label = "";
    for (const id of ids) {
      const target = id && root.getElementById?.(id);
      if (target) label = compact(label + " " + content(target, ${MAX_ELEMENT_TEXT}));
    }
    if (label) return label;
    label = attr(el, "aria-label");
    if (label) return label;
    const labels = el.labels;
    for (let i = 0; labels && i < Math.min(labels.length, 8); i++)
      label = compact(label + " " + content(labels[i], ${MAX_ELEMENT_TEXT}));
    if (label) return label;
    if (el.matches("img,input[type=image]")) label = attr(el, "alt");
    label = label || content(el, ${MAX_ELEMENT_TEXT});
    return label || (manualSlots !== omitted ? "" : attr(el, "title") || attr(el, "placeholder"));
  };
  const describe = (el, token) => {
    const role = roleOf(el), rect = el.getBoundingClientRect();
    const element = { token, tag: el.localName, role, label: nameOf(el), text: content(el, ${MAX_ELEMENT_TEXT}),
      disabled: disabled(el), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    if (el.matches("input[type=checkbox],input[type=radio]")) element.checked = el.indeterminate ? "mixed" : el.checked;
    else if (["checkbox","radio","switch","menuitemcheckbox","menuitemradio"].includes(role)) {
      const value = attr(el, "aria-checked");
      if (value === "mixed" || value === "true" || value === "false") element.checked = value === "mixed" ? value : value === "true";
    }
    if (el.matches("option")) element.selected = el.selected;
    else if (["tab","option","row","gridcell","treeitem"].includes(role)) {
      const value = attr(el, "aria-selected");
      if (value === "true" || value === "false") element.selected = value === "true";
    }
    if (el.matches("summary") && el.parentElement?.matches("details")) element.expanded = el.parentElement.open;
    else {
      const value = attr(el, "aria-expanded");
      if (value === "true" || value === "false") element.expanded = value === "true";
    }
    return element;
  };
  const page = elements => {
    let title = "", count = 0;
    for (let node = document.head?.firstChild; node; node = node.nextSibling) {
      if (++count > 4000) { truncated = true; break; }
      if (node instanceof Element && node.localName === "title") { title = content(node, 256); break; }
    }
    return { generation: state.generation, url: location.href, title, visibleText: "", truncated, elements };
  };
  if (reference) {
    if (state.generation !== reference.generation) return null;
    const stored = state.snapshots.get(id)?.get(reference.token), el = stored?.node.deref();
    if (!el?.isConnected || el.ownerDocument !== document) return null;
    const ancestry = chain(el);
    if (!ancestry || ancestry.length !== stored.chain.length ||
      ancestry.some((node, index) => node !== (stored.chain[index]?.deref() ?? null))) return null;
    if (!visible(el) || disabled(el) || !interactive(el)) return null;
    if (reference.fill && (!stored.fillKind || fillKind(el) !== stored.fillKind)) return null;
    const rect = el.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit?.shadowRoot && depth < 64; depth++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    let reached = false;
    for (let node = hit, depth = 0; node && depth < 64; node = parent(node), depth++) {
      if (node === el) { reached = true; break; }
    }
    if (!reached) return null;
    return page([describe(el, reference.token)]);
  }
  const elements = [], entries = new Map(), seen = new Set();
  let visibleText = "";
  const walk = (node, depth) => {
    if (visits >= 4000) { truncated = true; return; }
    visits++;
    if (depth > 64) { truncated = true; return; }
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof Element) {
      if (ignored(node)) return;
      if (interactive(node) && visible(node)) {
        if (elements.length >= ${MAX_ELEMENTS}) truncated = true;
        else {
          const ancestry = chain(node);
          if (ancestry) {
            let token = state.tokens.get(node);
            if (!token) { token = newToken(); state.tokens.set(node, token); }
            entries.set(token, { node: new WeakRef(node), fillKind: fillKind(node),
              chain: ancestry.map(node => node ? new WeakRef(node) : null) });
            elements.push(describe(node, token));
          } else truncated = true;
        }
      }
      if (sensitive(node)) return;
    }
    if (node.nodeType === Node.TEXT_NODE && node.parentElement && !sensitive(node.parentElement)) {
      if (visibleText.length >= ${MAX_VISIBLE_TEXT} || characters <= 0) truncated = true;
      else if (visible(node.parentElement)) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth)
          visibleText = compact(visibleText + " " + content(node, Math.min(${MAX_VISIBLE_TEXT} - visibleText.length, characters)), ${MAX_VISIBLE_TEXT});
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child, depth + 1);
      if (visits >= 4000) { truncated = true; break; }
    }
    // Visit light children once, then open roots; never expand assignedNodes (unbounded allocation).
    if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot, depth + 1);
  };
  walk(document.body || document.documentElement, 0);
  state.snapshots.set(id, entries);
  while (state.snapshots.size > 10) state.snapshots.delete(state.snapshots.keys().next().value);
  return { ...page(elements), visibleText, truncated };
})()`

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown) => (typeof value === "string" ? value : "")
const token = (value: unknown) => (typeof value === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(value) ? value : "")

export function parseSnapshot(value: unknown): PageSnapshot | undefined {
  const response = object(value)
  if (!response || "exceptionDetails" in response) return
  const input = object(object(response.result)?.value)
  if (!input || !token(input.generation)) return
  let truncated = input.truncated === true
  const bounded = (value: unknown, limit: number) => {
    const result = text(value)
    if (result.length > limit) truncated = true
    return result.slice(0, limit)
  }
  const source = Array.isArray(input.elements) ? input.elements : []
  if (source.length > MAX_ELEMENTS) truncated = true
  const elements = source.slice(0, MAX_ELEMENTS).flatMap((entry) => parseElement(entry, bounded))
  const title = bounded(input.title, 256),
    visibleText = bounded(input.visibleText, MAX_VISIBLE_TEXT)
  return { generation: token(input.generation), url: text(input.url), title, visibleText, truncated, elements }
}

function parseElement(value: unknown, bounded: (value: unknown, limit: number) => string): SnapshotElement[] {
  const el = object(value),
    rect = object(el?.rect)
  if (
    !el ||
    !rect ||
    !token(el.token) ||
    !["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]))
  )
    return []
  const role = bounded(el.role, 64)
  const boolean = (value: unknown) =>
    value === true || value === "true" ? true : value === false || value === "false" ? false : undefined
  const checked = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)
    ? el.checked === "mixed"
      ? ("mixed" as const)
      : boolean(el.checked)
    : undefined
  const selected = ["tab", "option", "row", "gridcell", "treeitem"].includes(role) ? boolean(el.selected) : undefined
  return [
    {
      token: token(el.token),
      tag: bounded(el.tag, 64),
      role,
      label: bounded(el.label, MAX_ELEMENT_TEXT),
      text: bounded(el.text, MAX_ELEMENT_TEXT),
      ...(checked !== undefined ? { checked } : {}),
      ...(selected !== undefined ? { selected } : {}),
      ...(boolean(el.expanded) !== undefined ? { expanded: boolean(el.expanded) } : {}),
      ...(boolean(el.disabled) !== undefined ? { disabled: boolean(el.disabled) } : {}),
      rect: { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) },
    },
  ]
}
