export function createDebugController({ statusEl, statusBodyEl, statusToggleEl, maxLines = 200 }) {
  const debugLines = [];

  function dbg(label, value) {
    let text;
    if (value === undefined) text = label;
    else if (typeof value === 'object') {
      try { text = `${label} ${JSON.stringify(value)}`; } catch { text = `${label} [object]`; }
    } else text = `${label} ${value}`;
    console.log(text);
    debugLines.push(text);
    while (debugLines.length > maxLines) debugLines.shift();
    statusBodyEl.textContent = debugLines.join('\n');
    statusBodyEl.scrollTop = statusBodyEl.scrollHeight;
  }

  function setExpanded(expanded) {
    statusEl.classList.toggle('expanded', expanded);
    statusToggleEl.textContent = expanded ? 'Collapse' : 'Expand';
  }

  return { dbg, setExpanded, debugLines };
}
