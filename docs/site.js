// Shared bits for the public pages.
// SUPPORT_EMAIL: the address customers should write to. Leave empty to hide contact links.
const SUPPORT_EMAIL = "";

// Old links (email confirmations, password resets) pointed at this page with #/... or #access_token=...
// Send them on to the app, keeping the part after #.
if (location.hash && (location.hash.startsWith("#/") || /access_token|error_description|type=/.test(location.hash))) {
  location.replace("app/" + location.hash);
}

document.addEventListener("DOMContentLoaded", () => {
  const y = document.getElementById("yr"); if (y) y.textContent = new Date().getFullYear();
  document.querySelectorAll("[data-email]").forEach((el) => {
    if (!SUPPORT_EMAIL) { el.hidden = true; return; }
    el.hidden = false;
    if (el.tagName === "A") el.href = "mailto:" + SUPPORT_EMAIL;
    if (!el.textContent.trim() || el.dataset.email === "show") el.textContent = SUPPORT_EMAIL;
  });
  document.querySelectorAll("[data-contact]").forEach((el) => (el.hidden = !SUPPORT_EMAIL));
});
