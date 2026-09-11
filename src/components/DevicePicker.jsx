import React, { useEffect, useRef, useState } from 'react';
import { LOCAL_DEVICE } from '../player/usePlayer.js';

// Filled paths (Material-style) rather than strokes: the Cast glyph in
// particular is unreadable as an outline at 18px.
const ICONS = {
  local: 'M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6v2h6v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z',
  cast:
    'M21 3H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z' +
    'M1 18v3h3c0-1.66-1.34-3-3-3z' +
    'M1 14v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7z' +
    'M1 10v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10z',
  bluos: 'M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-5 3.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm0 13a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
};

function DeviceIcon({ kind }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
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

  // A BluOS sync group plays as one speaker: commands to any member drive every
  // member. Listing members separately implies you can pick one, which is false
  // -- choosing either starts both. Collapse each group onto its master and
  // label it with everyone in it.
  const slaveHosts = new Set(
    devices.flatMap((d) => (d.slaves || []).map((s) => s.host))
  );
  const visible = devices.filter((d) => !(d.kind === 'bluos' && (d.isSlave || slaveHosts.has(d.host))));
  const labelFor = (d) => {
    if (d.kind !== 'bluos' || !d.slaves?.length) return d.name;
    return [d.name, ...d.slaves.map((s) => s.name)].join(' + ');
  };
  const subtitleFor = (d) => {
    if (d.kind === 'bluos' && d.slaves?.length) {
      return `Grouped · ${d.slaves.length + 1} speakers`;
    }
    return d.model;
  };

  const all = [LOCAL_DEVICE, ...visible];
  const groups = [
    { label: 'This device', items: all.filter((d) => d.kind === 'local') },
    { label: 'Speakers & TVs', items: all.filter((d) => d.kind === 'cast') },
    { label: 'Bluesound', items: all.filter((d) => d.kind === 'bluos') },
  ].filter((g) => g.items.length);

  const remoteCount = visible.length;
  const isBrowser = typeof window !== 'undefined' && !window.conduit;

  return (
    <div className="devicepicker" ref={ref}>
      <button
        className={`devicebtn ${active.kind !== 'local' ? 'casting' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`Playing on ${active.name}`}
      >
        <DeviceIcon kind={active.kind} />
        <span className="devicebtn-name">{labelFor(active)}</span>
      </button>

      {open && (
        <div className="devicemenu" role="menu">
          <div className="devicemenu-head">
            <strong>Play on</strong>
            <span>{remoteCount ? `${remoteCount} found` : (isBrowser ? '' : 'searching...')}</span>
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
                    <span className="deviceitem-name">{labelFor(d)}</span>
                    <span className="deviceitem-model">{subtitleFor(d)}</span>
                  </span>
                  {d.id === active.id && <span className="deviceitem-dot" />}
                </button>
              ))}
            </div>
          ))}

          {!remoteCount && isBrowser && (
            <p className="devicemenu-empty">
              Speaker control lives in the Conduit desktop app for now. In your
              browser you can play through this device.
            </p>
          )}
          {!remoteCount && !isBrowser && (
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
