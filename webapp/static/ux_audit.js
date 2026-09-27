/* Findability audit -- open the app with ?audit in the URL.
 *
 * For each task a first-time user has, it answers two questions about the
 * control that task needs, on the layout as it is right now:
 *   - clicks: how many things you must open or switch on before it is even
 *     visible (a closed section, a mode that hides it);
 *   - screens: how far down the sidebar it sits, in sidebar heights.
 * It also counts section headings that open and close but do not look like
 * something you can press -- the "which of these can I click?" problem.
 *
 * What it cannot tell you is whether people understand the words. That takes
 * real people doing the tasks (README, 「怎麼評估好不好用」). Treat this as the
 * regression check you run after every layout change, not as the verdict.
 */
(function () {
  const TASKS = [
    ["換成自己的上班地點", "Set your own workplace", "#addrInput"],
    ["設單程上限", "Set the one-way limit", "#maxTotal"],
    ["開關一種通勤方式", "Toggle a commute mode", "#modeTransfer"],
    ["新增廠車點", "Add a shuttle pickup", "#btnAddShuttle"],
    ["調接駁上限", "Change the feeder limit", "#feederMin"],
    ["調住家步行半徑", "Change the walk radius", "#walkR"],
    ["看候選清單", "See the candidate list", "#prioList"],
    ["匯出 CSV", "Export CSV", "#btnExport"],
    ["儲存設定", "Save settings", "#btnSave"],
    ["切換語言", "Switch language", "#langToggle"],
  ];
  const side = document.getElementById("sidebar");
  // A closed <details> keeps its content laid out (content-visibility), so
  // getClientRects() alone would call it visible.
  const shown = el => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true })
    : el.getClientRects().length > 0) && !el.closest("details:not([open]) > :not(summary)");

  // Opening what hides `el` (collapsed sections, sections a mode switch hides),
  // counting one click each; returns an undo function so the page is left as found.
  function reveal(el) {
    const undo = [];
    let clicks = 0;
    for (let n = el; n && n !== side; n = n.parentElement) {
      if (n.tagName === "DETAILS" && !n.open) { n.open = true; clicks++; undo.push(() => { n.open = false; }); }
      if (n.style && n.style.display === "none") {
        n.style.display = ""; clicks++; undo.push(() => { n.style.display = "none"; });
      }
      if (n.hidden) { n.hidden = false; clicks++; undo.push(() => { n.hidden = true; }); }
    }
    return { clicks, undo: () => undo.reverse().forEach(f => f()) };
  }

  function audit() {
    const zh = (document.documentElement.lang || "zh").startsWith("zh");
    const rows = TASKS.map(([tz, te, sel]) => {
      const el = document.querySelector(sel);
      if (!el) return { task: zh ? tz : te, clicks: null, screens: null };
      const r = reveal(el);
      const top = el.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop;
      const screens = shown(el) ? +(top / side.clientHeight).toFixed(2) : null;
      r.undo();
      return { task: zh ? tz : te, clicks: r.clicks, screens };
    });

    // Something that opens and closes has to look pressable: set apart from
    // body text (a filled/bordered box, or link colour) and carrying a marker
    // that is actually drawn -- a chevron, a ▾, or a button-like chip. Plain
    // text with a 10px ▸ reads as a bullet point, not as a control.
    const body = getComputedStyle(side).color;
    const drawn = (el, pseudo) => {
      const p = getComputedStyle(el, pseudo);
      return p.display !== "none" && !/^(none|normal)$/.test(p.content) &&
        (parseFloat(p.fontSize) >= 12 || parseFloat(p.width) >= 6);
    };
    const pressable = el => {
      const s = getComputedStyle(el);
      const setApart = parseFloat(s.borderTopWidth) > 0 || !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor) ||
        s.color !== body;
      const chip = [...el.querySelectorAll("*")].some(c => parseFloat(getComputedStyle(c).borderTopWidth) > 0);
      return s.cursor === "pointer" && setApart && (drawn(el, "::before") || drawn(el, "::after") || chip);
    };
    const summaries = [...side.querySelectorAll("summary")].filter(shown);
    const twins = summaries.filter(s => !pressable(s)).length;

    const controls = [...side.querySelectorAll("input,select,button,textarea")].filter(shown).length;
    return { rows, twins, summaries: summaries.length, controls,
      sidebarScreens: +(side.scrollHeight / side.clientHeight).toFixed(2),
      viewport: innerWidth + "x" + innerHeight };
  }

  function show(res) {
    console.table(res.rows);
    console.log(res);
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;right:12px;top:12px;z-index:10000;background:#fff;color:#111;" +
      "border:1px solid #ccc;border-radius:8px;padding:10px 12px;font:12px/1.5 system-ui;max-width:360px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.2)";
    box.innerHTML = "<b>Findability audit</b> (" + res.viewport + ")<table style='margin-top:6px;border-collapse:collapse'>" +
      res.rows.map(r => "<tr><td style='padding:1px 8px 1px 0'>" + r.task + "</td><td>" +
        (r.clicks === null ? "—" : r.clicks + " click") + "</td><td style='padding-left:8px'>" +
        (r.screens === null ? "" : r.screens + " scr") + "</td></tr>").join("") +
      "</table><div style='margin-top:6px'>visible controls " + res.controls + " · sidebar " + res.sidebarScreens +
      " screens · collapsible headings that don't look pressable " + res.twins + "/" + res.summaries + "</div>";
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  }

  window.uxAudit = audit;
  window.uxAuditShow = () => show(audit());
})();
