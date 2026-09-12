import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="ctx-chev">
    <path d="M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5z" />
  </svg>
);

const PAD = 8;

// Keep a box on screen: slide it up when it would run off the bottom, and
// open it leftwards when it would run off the right. Spotify does the same
// with its context menu, which is why it never spills past the footer.
function fit(x, y, w, h, preferLeft = false) {
  const W = window.innerWidth, H = window.innerHeight;
  let nx = preferLeft ? x - w : x;
  if (nx + w > W - PAD) nx = Math.max(PAD, W - PAD - w);
  if (nx < PAD) nx = PAD;
  let ny = y;
  if (ny + h > H - PAD) ny = Math.max(PAD, H - PAD - h);
  return { x: nx, y: ny };
}

function Panel({ x, y, items, onClose, depth = 0, anchorRight = false, onEnter, onLeave }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  const [open, setOpen] = useState(null); // index of the open submenu
  const [subAt, setSubAt] = useState(null);
  const closeTimer = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ ...fit(x, y, r.width, r.height, anchorRight), ready: true });
  }, [x, y, anchorRight, items.length]);

  const openSub = (i, target) => {
    clearTimeout(closeTimer.current);
    const r = target.getBoundingClientRect();
    const menu = ref.current.getBoundingClientRect();
    // Open to the right of the panel; Panel() flips it left when there is no room.
    const spaceRight = window.innerWidth - menu.right;
    setSubAt({ x: spaceRight > 240 ? menu.right + 2 : menu.left - 2, y: r.top - 4, left: spaceRight <= 240 });
    setOpen(i);
  };
  const scheduleClose = () => { closeTimer.current = setTimeout(() => setOpen(null), 250); };

  return (
    <>
      <div
        ref={ref}
        className={`ctxmenu ctxmenu-fixed ${depth ? 'ctxmenu-sub' : ''}`}
        style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
        onMouseLeave={() => { if (open != null) scheduleClose(); onLeave?.(); }}
        onMouseEnter={() => { clearTimeout(closeTimer.current); onEnter?.(); }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (!it) return null;
          if (it.sep) return <div key={`sep${i}`} className="ctxmenu-sep" />;
          if (it.label && !it.onClick && !it.sub) return <div key={`lbl${i}`} className="ctxmenu-label">{it.label}</div>;
          return (
            <button
              key={it.key || it.label}
              className={`ctxitem ${it.danger ? 'danger' : ''} ${open === i ? 'open' : ''}`}
              disabled={it.disabled}
              onMouseEnter={(e) => (it.sub ? openSub(i, e.currentTarget) : setOpen(null))}
              onClick={(e) => {
                e.stopPropagation();
                if (it.sub) { openSub(i, e.currentTarget); return; }
                onClose();
                it.onClick?.();
              }}
            >
              <span className="ctx-ico">{it.icon || null}</span>
              <span className="ctx-label">{it.label}</span>
              {it.sub && <Chevron />}
            </button>
          );
        })}
      </div>
      {open != null && items[open]?.sub && subAt && (
        // The submenu is a sibling, not a child: hovering it must cancel THIS
        // panel's pending close, or it vanishes the moment the pointer arrives.
        <Panel x={subAt.x} y={subAt.y} items={items[open].sub} onClose={onClose} depth={depth + 1} anchorRight={subAt.left}
          onEnter={() => clearTimeout(closeTimer.current)} onLeave={() => scheduleClose()} />
      )}
    </>
  );
}

/**
 * Spotify-style context menu. `items`: [{ label, icon, onClick, sub: [...],
 * danger, disabled } | { sep: true } | { label } (a heading)].
 * Rendered in a portal at a fixed screen position, kept on screen, with
 * hover-opened submenus. Closes on outside click, Escape, scroll or resize.
 */
export default function ContextMenu({ x, y, items, onClose, anchorRight = false }) {
  useEffect(() => {
    const down = (e) => { if (!e.target.closest?.('.ctxmenu')) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    const bye = () => onClose();
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', bye);
    document.addEventListener('scroll', bye, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', bye);
      document.removeEventListener('scroll', bye, true);
    };
  }, [onClose]);
  return createPortal(<Panel x={x} y={y} items={items} onClose={onClose} anchorRight={anchorRight} />, document.body);
}
