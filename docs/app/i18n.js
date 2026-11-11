// Delegiq languages: English (written in the code), French and Arabic.
// Every screen is written in English; this module swaps the words for the chosen language as they appear,
// and turns the layout right-to-left for Arabic. Words people type (task titles, names, comments) are left alone.
import { FR, AR, PATTERNS } from "./i18n-words.js";

export const LANGS = { en: "English", fr: "Français", ar: "العربية" };
const read = () => { try { return localStorage.getItem("delegiq.lang"); } catch { return null; } };
const guess = (navigator.language || "en").slice(0, 2);
export let LANG = LANGS[read()] ? read() : LANGS[guess] ? guess : "en";
export const LOCALE = () => ({ ar: "ar-u-nu-latn", fr: "fr-FR", en: "en-GB" }[LANG]);
const DICT = { fr: FR, ar: AR };

export function T(s) {
  if (LANG === "en" || s == null) return s;
  const str = String(s), d = DICT[LANG];
  if (d[str] != null) return d[str];
  const t = str.trim();
  if (t !== str && d[t] != null) return str.replace(t, d[t]);
  for (const [re, out] of PATTERNS) {
    const m = t.match(re);
    if (m) { const v = out[LANG](...m.slice(1)); if (v != null) return str.replace(t, v); }
  }
  return str;
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);
const ATTRS = ["placeholder", "aria-label", "title", "alt"];
function translateNode(root) {
  if (LANG === "en" || !root) return;
  if (root.nodeType === 3) { fixText(root); return; }
  if (root.nodeType !== 1) return;
  if (root.closest && root.closest("[data-notr]")) return;
  fixAttrs(root);
  root.querySelectorAll?.("[placeholder],[aria-label],[title],[alt]").forEach(fixAttrs);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!n.parentElement || SKIP.has(n.parentElement.tagName) || n.parentElement.closest("[data-notr]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const list = []; while (w.nextNode()) list.push(w.currentNode);
  list.forEach(fixText);
}
function fixText(n) {
  const v = n.nodeValue; if (!v || !v.trim()) return;
  if (n.parentElement && (SKIP.has(n.parentElement.tagName) || n.parentElement.closest("[data-notr]"))) return;
  const t = T(v); if (t !== v) n.nodeValue = t;
}
function fixAttrs(el) {
  if (el.closest("[data-notr]")) return;
  for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const t = T(v); if (t !== v) el.setAttribute(a, t); } }
}

let observer = null;
export function applyLang() {
  const html = document.documentElement;
  html.lang = LANG; html.dir = LANG === "ar" ? "rtl" : "ltr";
  if (observer) { observer.disconnect(); observer = null; }
  if (LANG === "en") return;
  translateNode(document.body);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") fixText(m.target);
      else if (m.type === "attributes") fixAttrs(m.target);
      else m.addedNodes.forEach(translateNode);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
export function setLang(l) {
  if (!LANGS[l]) return;
  LANG = l;
  try { localStorage.setItem("delegiq.lang", l); } catch {}
  applyLang();
}
