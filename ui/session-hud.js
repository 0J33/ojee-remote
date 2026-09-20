/* ============================================================
   The session's HUD, ported from rdp.ojee.net's index.html.

   Two floating overlays over a full-bleed remote screen, which is
   the layout that made the original usable on a phone: the desktop
   gets the entire viewport and the controls sit on top of it,
   dismissable.

   Every control here exists because a touchscreen cannot do what a
   mouse and keyboard can:

     L / M / R      a phone has no right mouse button
     Ctrl Alt ⇧ ⌘   you cannot hold a modifier and tap a letter
     ⌃⌥⌦            Ctrl+Alt+Del is unreachable any other way
     the key row    Esc, Tab, arrows, Home/End, PgUp/PgDn, F1–F12
     ⌨              raises the OS keyboard for typing text
     Clip Send/Get  the clipboard both ways; a browser only allows it
                    from a click, so it is a button rather than a sync

   Ids are prefixed rd- so the session can be scoped to its own
   root and mounted inside the console shell rather than owning
   the document.
   ============================================================ */

export function hudMarkup() {
  const keys = [
    // Text, not glyphs: Geist Mono has no ⌫ / ⏎ / ⌦, so those rendered as
    // tofu boxes. Arrows exist in the face and stay.
    ['Escape', 'Esc'], ['Tab', 'Tab'], ['Backspace', 'Bksp'], ['Enter', 'Enter'],
    ['Delete', 'Del'], ['ArrowUp', '↑'], ['ArrowDown', '↓'],
    ['ArrowLeft', '←'], ['ArrowRight', '→'],
    ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'],
  ];
  const fkeys = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

  return `
  <div class="rs">
    <div id="rd-screen" class="rs-screen" tabindex="-1"></div>

    <aside id="rd-hud-top" class="rs-hud rs-hud--top" aria-label="Session controls">
      <div class="rs-hud-main">
        <div id="rd-status" class="rs-status" aria-live="polite">connecting…</div>

        <div class="rs-group" id="rd-devices-group" hidden>
          <span class="rs-label">Dev</span>
          <div id="rd-devices" class="rs-chips"></div>
        </div>

        <div class="rs-group" id="rd-monitors-group">
          <span class="rs-label">Mon</span>
          <div id="rd-monitors" class="rs-chips"></div>
        </div>

        <div class="rs-group">
          <span class="rs-label">Fit</span>
          <div class="rs-chips">
            <button data-fit="contain" class="rs-chip on">Fit</button>
            <button data-fit="100" class="rs-chip">1:1</button>
          </div>
        </div>

        <!-- Clipboard is two buttons, not a silent sync: a browser will only
             read or write the clipboard on a user gesture, and a background
             sync would also hand this machine's clipboard to whoever is
             sitting at the other one. -->
        <div class="rs-group" id="rd-clip-group">
          <span class="rs-label">Clip</span>
          <div class="rs-chips">
            <button id="rd-clip-send" class="rs-chip" title="Send this device's clipboard to the remote machine">Send</button>
            <button id="rd-clip-get" class="rs-chip" title="Copy the remote machine's clipboard to this device">Get</button>
          </div>
        </div>
      </div>

      <div class="rs-hud-actions">
        <button id="rd-hide" class="rs-icon" title="Hide controls" aria-label="Hide controls">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"
                  d="M5 9 L12 16 L19 9"/>
          </svg>
        </button>
        <button id="rd-exit" class="rs-icon rs-icon--danger" title="Exit to devices"
                aria-label="Exit to devices">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"
                  d="M14 5 H19 V19 H14 M14 12 H4 M8 8 L4 12 L8 16"/>
          </svg>
        </button>
      </div>
    </aside>

    <aside id="rd-hud-bottom" class="rs-hud rs-hud--bottom" aria-label="Keys and clicks">
      <div class="rs-row rs-keys" aria-label="Special keys">
        ${keys.map(([k, lbl]) =>
          `<button class="rs-chip" data-key="${k}">${lbl}</button>`).join('')}
        <details class="rs-details">
          <summary class="rs-chip">Fn ▾</summary>
          <div class="rs-chips rs-fkeys">
            ${fkeys.map((k) => `<button class="rs-chip" data-key="${k}">${k}</button>`).join('')}
          </div>
        </details>
      </div>

      <div class="rs-row rs-actions">
        <div class="rs-cell" aria-label="Modifier keys">
          <span class="rs-cell-label">Mods</span>
          <div class="rs-cell-body">
            <button class="rs-chip rs-mod" data-mod="Control">Ctrl</button>
            <button class="rs-chip rs-mod" data-mod="Alt">Alt</button>
            <button class="rs-chip rs-mod" data-mod="Shift">Shift</button>
            <button class="rs-chip rs-mod" data-mod="Meta">Super</button>
            <button class="rs-chip rs-chip--warn" id="rd-ctrlaltdel"
                    title="Send Ctrl+Alt+Del">C-A-Del</button>
          </div>
        </div>
        <div class="rs-cell" aria-label="Mouse clicks">
          <span class="rs-cell-label">Click</span>
          <div class="rs-cell-body">
            <button class="rs-chip" id="rd-click-left" aria-label="Left click">L</button>
            <button class="rs-chip" id="rd-click-middle" aria-label="Middle click">M</button>
            <button class="rs-chip" id="rd-click-right" aria-label="Right click">R</button>
            <button class="rs-chip rs-chip--kbd" id="rd-kbd"
                    title="On-screen keyboard" aria-label="On-screen keyboard">KBD</button>
          </div>
        </div>
      </div>
    </aside>

    <button id="rd-reveal" class="rs-reveal" aria-label="Show controls">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"
              d="M5 9 L12 16 L19 9" transform="rotate(180 12 12)"/>
      </svg>
    </button>
  </div>`;
}
