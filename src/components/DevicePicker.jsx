import React, { useEffect, useRef, useState } from 'react';
import { LOCAL_DEVICE } from '../player/usePlayer.js';

const ICONS = {
  local: 'M4 4h16v11H4zM8 19h8M12 15v4',
  cast: 'M2 16v3h3M2 12v7h7M2 8v11h11M15 5h7v14h-7',
  bluos: 'M7 3h10v18H7zM12 7v.01M12 12a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
};

function DeviceIcon({ kind }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[kind] || ICONS.cast} />
    </svg>
  );
}

/**
 * The device selector. Groups discovered players by family so the Bluesound gear
 * and the Cast gear read as distinct things rather than one flat list.
 */
export default function DevicePicker({ devices, active, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const all = [LOCAL_DEVICE, ...devices];
  const groups = [
    { label: 'This device', items: all.filter((d) => d.kind === 'local') },
    { label: 'Speakers & TVs', items: all.filter((d) => d.kind === 'cast') },
    { label: 'Bluesound', items: all.filter((d) => d.kind === 'bluos') },
  ].filter((g) => g.items.length);

  const remoteCount = devices.length;

  return (
    <div className="devicepicker" ref={ref}>
      <button
        className={`devicebtn ${active.kind !== 'local' ? 'casting' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`Playing on ${active.name}`}
      >
        <DeviceIcon kind={active.kind} />
        <span className="devicebtn-name">{active.name}</span>
      </button>

      {open && (
        <div className="devicemenu" role="menu">
          <div className="devicemenu-head">
            <strong>Play on</strong>
            <span>{remoteCount ? `${remoteCount} found` : 'searching...'}</span>
          </div>

          {groups.map((g) => (
            <div className="devicegroup" key={g.label}>
              <div className="devicegroup-label">{g.label}</div>
              {g.items.map((d) => (
                <button
                  key={d.id}
                  className={`deviceitem ${d.id === active.id ? 'active' : ''}`}
                  onClick={() => { onSelect(d); setOpen(false); }}
                  role="menuitem"
                >
                  <DeviceIcon kind={d.kind} />
                  <span className="deviceitem-text">
                    <span className="deviceitem-name">{d.name}</span>
                    <span className="deviceitem-model">{d.model}</span>
                  </span>
                  {d.id === active.id && <span className="deviceitem-dot" />}
                </button>
              ))}
            </div>
          ))}

          {!remoteCount && (
            <p className="devicemenu-empty">
              No speakers found yet. Chromecast and Bluesound players appear here
              automatically once they are awake on the same network.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
