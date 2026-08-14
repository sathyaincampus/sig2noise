import { useState, useEffect, useRef, useCallback } from "react";
import { auth, db, googleProvider } from "./firebase.js";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

/* ------------------------------------------------------------------ */
/* sig2noise — pick 3 things for the next 18 hours. The rest is noise. */
/* Signed out: saves to this device (localStorage).                    */
/* Signed in:  syncs live across devices via Firestore.                */
/* ------------------------------------------------------------------ */

const LOCAL_KEY = "sig2noise-v1";

const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

const freshState = () => ({ date: localDate(), signal: [], noise: [], history: [] });

/* Roll the day over: archive yesterday's score, carry unfinished signals into noise */
const normalize = (raw) => {
  const s = { ...freshState(), ...(raw || {}) };
  const today = localDate();
  if (s.date === today) return s;
  const done = (s.signal || []).filter((i) => i.done).length;
  const total = (s.signal || []).length;
  const history = [...(s.history || [])];
  if (total > 0) history.push({ date: s.date, done, total });
  const carried = (s.signal || [])
    .filter((i) => !i.done)
    .map((i) => ({ ...i, done: false, carried: true }));
  return {
    date: today,
    signal: [],
    noise: [...carried, ...(s.noise || []).filter((i) => !i.done)],
    history: history.slice(-30),
  };
};

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = auth still resolving
  const [state, setState] = useState(null);
  const [input, setInput] = useState("");
  const [flash, setFlash] = useState(false);
  const [syncErr, setSyncErr] = useState(false);
  const [drag, setDrag] = useState(null);
  const [dropHint, setDropHint] = useState(null);
  const saveTimer = useRef(null);
  const dragRef = useRef(null);
  const lastSaved = useRef("");

  /* ---------------- auth ---------------- */
  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u ?? null)), []);

  /* ---------------- load: Firestore when signed in, localStorage otherwise ---- */
  useEffect(() => {
    if (user === undefined) return;
    setState(null);
    if (!user) {
      let raw = null;
      try {
        raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
      } catch (e) { /* corrupt or empty — start fresh */ }
      setState(normalize(raw));
      return;
    }
    const ref = doc(db, "sig2noise", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const incoming = normalize(snap.exists() ? snap.data() : null);
        const json = JSON.stringify(incoming);
        if (json !== lastSaved.current) {
          lastSaved.current = json;
          setState(incoming);
        }
        setSyncErr(false);
      },
      () => setSyncErr(true)
    );
    return unsub;
  }, [user]);

  /* ---------------- debounced save ---------------- */
  useEffect(() => {
    if (!state || user === undefined) return;
    const json = JSON.stringify(state);
    if (json === lastSaved.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      lastSaved.current = json;
      if (user) {
        try {
          await setDoc(doc(db, "sig2noise", user.uid), state);
          setSyncErr(false);
        } catch (e) {
          setSyncErr(true);
        }
      } else {
        localStorage.setItem(LOCAL_KEY, json);
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [state, user]);

  /* ---------------- mutations ---------------- */
  const rejectFull = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 500);
  };

  const addItem = () => {
    const text = input.trim();
    if (!text || !state) return;
    setState((s) => ({ ...s, noise: [{ id: uid(), text, done: false }, ...s.noise] }));
    setInput("");
  };

  const toggleDone = (id) =>
    setState((s) => ({
      ...s,
      signal: s.signal.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
      noise: s.noise.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
    }));

  const removeItem = (id) =>
    setState((s) => ({
      ...s,
      signal: s.signal.filter((i) => i.id !== id),
      noise: s.noise.filter((i) => i.id !== id),
    }));

  const moveItem = useCallback((id, toList, toIndex) => {
    setState((s) => {
      const fromList = s.signal.some((i) => i.id === id) ? "signal" : "noise";
      const item = [...s.signal, ...s.noise].find((i) => i.id === id);
      if (!item) return s;
      if (toList === "signal" && fromList !== "signal" && s.signal.length >= 3) {
        rejectFull();
        return s;
      }
      const signal = s.signal.filter((i) => i.id !== id);
      const noise = s.noise.filter((i) => i.id !== id);
      const target = toList === "signal" ? signal : noise;
      const idx = toIndex == null ? target.length : Math.min(toIndex, target.length);
      target.splice(idx, 0, { ...item, carried: false });
      return { ...s, signal, noise };
    });
  }, []);

  const promote = (id) => moveItem(id, "signal", null);
  const demote = (id) => moveItem(id, "noise", 0);

  /* ---------------- pointer drag (mouse + touch) ---------------- */
  const startDrag = (e, item, from) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const d = { id: item.id, from, text: item.text, x: e.clientX, y: e.clientY };
    dragRef.current = d;
    setDrag(d);
  };

  const onDragMove = (e) => {
    if (!dragRef.current) return;
    const d = { ...dragRef.current, x: e.clientX, y: e.clientY };
    dragRef.current = d;
    setDrag(d);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el?.closest?.("[data-row]");
    const zone = el?.closest?.("[data-zone]");
    if (row && row.dataset.rowId !== d.id) {
      setDropHint({ list: row.dataset.zoneName, index: Number(row.dataset.index) });
    } else if (zone) {
      setDropHint({ list: zone.dataset.zone, index: null });
    } else {
      setDropHint(null);
    }
  };

  const endDrag = () => {
    const d = dragRef.current;
    if (d && dropHint) moveItem(d.id, dropHint.list, dropHint.index);
    dragRef.current = null;
    setDrag(null);
    setDropHint(null);
  };

  /* ---------------- render ---------------- */
  if (user === undefined || !state) {
    return (
      <div style={sx.app}>
        <style>{css}</style>
        <div style={{ ...sx.mono, color: "#7C8799", padding: 40 }}>tuning in…</div>
      </div>
    );
  }

  const cleared = state.signal.filter((i) => i.done).length;
  const allSet = state.signal.length === 3;
  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const strip = [
    ...state.history.slice(-7),
    { date: state.date, done: cleared, total: state.signal.length, today: true },
  ];

  return (
    <div style={sx.app} onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <style>{css}</style>

      {/* ---------- top bar: sync status + auth ---------- */}
      <div style={sx.topBar}>
        <span style={{ ...sx.mono, fontSize: 10, letterSpacing: "0.14em", color: syncErr ? "#E4574B" : "#4A566B" }}>
          {user ? (syncErr ? "SYNC ERROR — CHECK RULES" : "SYNCED · " + (user.displayName?.split(" ")[0] || "").toUpperCase()) : "THIS DEVICE ONLY"}
        </span>
        {user ? (
          <button style={sx.authBtn} onClick={() => signOut(auth)}>Sign out</button>
        ) : (
          <button style={sx.authBtn} onClick={() => signInWithPopup(auth, googleProvider).catch(() => setSyncErr(true))}>
            Sign in to sync
          </button>
        )}
      </div>

      {/* ---------- header ---------- */}
      <header style={sx.header}>
        <div>
          <div style={sx.eyebrow}>
            <span style={{ ...sx.dot, background: allSet ? "#FFB224" : "#3A4557" }} className={allSet ? "pulse" : ""} />
            {allSet ? "ON AIR" : "CHOOSE YOUR 3"}
          </div>
          <h1 style={sx.title}>SIGNAL</h1>
          <div style={sx.sub}>{dateLabel} · next 18 hours</div>
        </div>

        <div style={sx.vuWrap} aria-label={`${cleared} of 3 signals cleared`}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                ...sx.vuSeg,
                background: state.signal[i]?.done ? "#FFB224" : state.signal[i] ? "#3E3116" : "#242D3D",
                boxShadow: state.signal[i]?.done ? "0 0 14px rgba(255,178,36,.45)" : "none",
              }}
            />
          ))}
          <div style={{ ...sx.mono, fontSize: 11, color: "#7C8799", marginTop: 6 }}>{cleared}/3 cleared</div>
        </div>
      </header>

      {/* ---------- signal zone ---------- */}
      <section
        data-zone="signal"
        style={{
          ...sx.signalZone,
          borderColor: flash ? "#E4574B" : dropHint?.list === "signal" ? "#FFB224" : "#2B3548",
        }}
        className={flash ? "shake" : ""}
      >
        {state.signal.map((item, idx) => (
          <Row
            key={item.id}
            item={item}
            index={idx}
            zone="signal"
            rank={idx + 1}
            dragging={drag?.id === item.id}
            hint={dropHint?.list === "signal" && dropHint?.index === idx}
            onToggle={toggleDone}
            onRemove={removeItem}
            onDemote={demote}
            startDrag={startDrag}
          />
        ))}
        {state.signal.length < 3 &&
          Array.from({ length: 3 - state.signal.length }).map((_, i) => (
            <div key={i} style={sx.emptySlot}>
              <span style={{ ...sx.mono, color: "#4A566B", fontSize: 12 }}>
                open slot — drag something up that actually moves things
              </span>
            </div>
          ))}
      </section>

      {/* ---------- noise zone ---------- */}
      <section
        data-zone="noise"
        style={{ ...sx.noiseZone, outline: dropHint?.list === "noise" ? "1px dashed #7C8799" : "none" }}
      >
        <div style={sx.noiseHead}>
          <span style={{ ...sx.mono, letterSpacing: "0.18em", fontSize: 11, color: "#7C8799" }}>
            NOISE — it can wait
          </span>
          <span style={{ ...sx.mono, fontSize: 11, color: "#4A566B" }}>{state.noise.length}</span>
        </div>

        <div style={sx.inputRow}>
          <input
            style={sx.input}
            value={input}
            placeholder="Everything lands here first…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addItem()}
          />
          <button style={sx.addBtn} onClick={addItem}>Add</button>
        </div>

        {state.noise.length === 0 && (
          <div style={{ ...sx.mono, color: "#4A566B", fontSize: 12, padding: "14px 4px" }}>
            Quiet. Capture asks, fires and "quick things" here — then decide.
          </div>
        )}

        {state.noise.map((item, idx) => (
          <Row
            key={item.id}
            item={item}
            index={idx}
            zone="noise"
            dragging={drag?.id === item.id}
            hint={dropHint?.list === "noise" && dropHint?.index === idx}
            onToggle={toggleDone}
            onRemove={removeItem}
            onPromote={promote}
            startDrag={startDrag}
          />
        ))}
      </section>

      {/* ---------- 7-day strip ---------- */}
      <footer style={sx.footer}>
        <div style={{ ...sx.mono, fontSize: 11, color: "#7C8799", letterSpacing: "0.18em", marginBottom: 10 }}>
          LAST 7 DAYS
        </div>
        <div style={sx.stripRow}>
          {strip.map((d, i) => (
            <div key={i} style={sx.stripDay} title={`${d.date}: ${d.done}/${d.total || 3}`}>
              <div style={sx.stripBars}>
                {[2, 1, 0].map((seg) => (
                  <div
                    key={seg}
                    style={{
                      ...sx.stripSeg,
                      background: d.done > seg ? "#FFB224" : "#242D3D",
                      opacity: d.today ? 1 : 0.75,
                    }}
                  />
                ))}
              </div>
              <div style={{ ...sx.mono, fontSize: 9, color: d.today ? "#E8ECF3" : "#4A566B" }}>
                {d.today ? "now" : d.date.slice(5)}
              </div>
            </div>
          ))}
        </div>
      </footer>

      {drag && <div style={{ ...sx.ghost, left: drag.x + 10, top: drag.y - 18 }}>{drag.text}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Row({ item, index, zone, rank, dragging, hint, onToggle, onRemove, onPromote, onDemote, startDrag }) {
  const isSignal = zone === "signal";
  return (
    <div
      data-row
      data-row-id={item.id}
      data-zone-name={zone}
      data-index={index}
      style={{
        ...sx.row,
        opacity: dragging ? 0.35 : item.done && !isSignal ? 0.5 : 1,
        borderTop: hint ? "2px solid #FFB224" : isSignal ? "1px solid #2B3548" : "1px dashed #2B3548",
      }}
    >
      <span style={sx.handle} onPointerDown={(e) => startDrag(e, item, zone)} aria-label="Drag to reorder">
        ⠿
      </span>

      {isSignal && <span style={sx.rank}>{rank}</span>}

      <button
        onClick={() => onToggle(item.id)}
        style={{
          ...sx.check,
          borderColor: item.done ? "#FFB224" : "#4A566B",
          background: item.done ? "#FFB224" : "transparent",
          color: item.done ? "#171D28" : "transparent",
        }}
        aria-label={item.done ? "Mark not done" : "Mark done"}
      >
        ✓
      </button>

      <span
        style={{
          ...(isSignal ? sx.textSignal : sx.textNoise),
          textDecoration: item.done ? "line-through" : "none",
        }}
      >
        {item.text}
        {item.carried && <span style={sx.carried}> · carried over</span>}
      </span>

      <div style={sx.rowBtns}>
        {isSignal ? (
          <button style={sx.miniBtn} onClick={() => onDemote(item.id)} title="Back to noise">▾</button>
        ) : (
          <button style={sx.miniBtn} onClick={() => onPromote(item.id)} title="Make it a signal">▴</button>
        )}
        <button style={{ ...sx.miniBtn, color: "#5A6478" }} onClick={() => onRemove(item.id)} title="Delete">×</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
const MONO = "'IBM Plex Mono', ui-monospace, monospace";
const DISPLAY = "'Archivo', system-ui, sans-serif";

const sx = {
  app: {
    minHeight: "100vh",
    background: "#171D28",
    color: "#E8ECF3",
    fontFamily: DISPLAY,
    maxWidth: 640,
    margin: "0 auto",
    padding: "16px 18px 60px",
    touchAction: "pan-y",
  },
  mono: { fontFamily: MONO },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 },
  authBtn: {
    background: "transparent",
    border: "1px solid #2B3548",
    color: "#7C8799",
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 11,
    fontFamily: MONO,
    cursor: "pointer",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 26 },
  eyebrow: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: "0.22em",
    color: "#7C8799",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  title: { fontSize: 44, fontWeight: 900, letterSpacing: "0.04em", margin: "6px 0 2px", lineHeight: 1 },
  sub: { fontFamily: MONO, fontSize: 12, color: "#7C8799" },
  vuWrap: { display: "flex", flexDirection: "column", alignItems: "flex-end", paddingTop: 6 },
  vuSeg: { width: 46, height: 10, borderRadius: 2, marginBottom: 5, transition: "background .3s" },

  signalZone: {
    border: "1px solid #2B3548",
    borderRadius: 10,
    background: "#1F2735",
    padding: "6px 0",
    marginBottom: 22,
    transition: "border-color .2s",
  },
  emptySlot: { padding: "16px 16px", borderTop: "1px dashed #2B3548", minHeight: 24 },

  noiseZone: { borderRadius: 10, padding: "2px 2px 8px" },
  noiseHead: { display: "flex", justifyContent: "space-between", padding: "0 4px 10px" },
  inputRow: { display: "flex", gap: 8, marginBottom: 8 },
  input: {
    flex: 1,
    background: "#1F2735",
    border: "1px solid #2B3548",
    borderRadius: 8,
    color: "#E8ECF3",
    padding: "11px 12px",
    fontSize: 16,
    fontFamily: DISPLAY,
    outline: "none",
  },
  addBtn: {
    background: "#FFB224",
    color: "#171D28",
    border: "none",
    borderRadius: 8,
    padding: "0 18px",
    fontWeight: 700,
    fontFamily: DISPLAY,
    fontSize: 14,
    cursor: "pointer",
  },

  row: { display: "flex", alignItems: "center", gap: 10, padding: "12px 12px" },
  handle: { cursor: "grab", color: "#4A566B", fontSize: 15, touchAction: "none", userSelect: "none", padding: "4px 2px" },
  rank: { fontFamily: MONO, color: "#FFB224", fontSize: 13, width: 14, textAlign: "center" },
  check: {
    width: 22,
    height: 22,
    minWidth: 22,
    borderRadius: "50%",
    border: "1.5px solid",
    fontSize: 12,
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all .15s",
  },
  textSignal: { flex: 1, fontSize: 16, fontWeight: 600, lineHeight: 1.35 },
  textNoise: { flex: 1, fontSize: 14, color: "#8C96A6", lineHeight: 1.35 },
  carried: { fontFamily: MONO, fontSize: 10, color: "#7A5A1E" },
  rowBtns: { display: "flex", gap: 2 },
  miniBtn: { background: "transparent", border: "none", color: "#7C8799", fontSize: 16, cursor: "pointer", padding: "2px 6px" },

  footer: { marginTop: 34, borderTop: "1px solid #2B3548", paddingTop: 16 },
  stripRow: { display: "flex", gap: 10 },
  stripDay: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  stripBars: { display: "flex", flexDirection: "column", gap: 2 },
  stripSeg: { width: 22, height: 6, borderRadius: 1 },

  ghost: {
    position: "fixed",
    zIndex: 50,
    background: "#2B3548",
    border: "1px solid #FFB224",
    color: "#E8ECF3",
    padding: "6px 10px",
    borderRadius: 6,
    fontSize: 13,
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    boxShadow: "0 6px 20px rgba(0,0,0,.4)",
  },
};

const css = `
* { box-sizing: border-box; }
body { margin: 0; background: #171D28; }
input::placeholder { color: #4A566B; }
button:focus-visible, input:focus-visible, span:focus-visible { outline: 2px solid #FFB224; outline-offset: 2px; }
.pulse { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.shake { animation: shake .4s; }
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-5px)} 75%{transform:translateX(5px)} }
@media (prefers-reduced-motion: reduce) { .pulse, .shake { animation: none; } }
`;
