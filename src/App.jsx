import { useState, useEffect, useRef, useCallback } from "react";
import { auth, db, googleProvider } from "./firebase.js";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

/* ------------------------------------------------------------------ */
/* sig2noise — pick 3 things for the next 18 hours. The rest is noise. */
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

const loadLocal = () => {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
  } catch (e) {
    return null;
  }
};

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

const ERR_HELP = {
  "permission-denied":
    "Firestore rejected the request — publish the sig2noise rules block in Firebase → Firestore → Rules.",
  unavailable: "Can't reach Firestore — check your connection.",
};

export default function App() {
  const [user, setUser] = useState(undefined);
  const [state, setState] = useState(null);
  const [input, setInput] = useState("");
  const [flash, setFlash] = useState(false);
  const [syncErr, setSyncErr] = useState(null); // string error code or null
  const [drag, setDrag] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [dropHint, setDropHint] = useState(null);
  const saveTimer = useRef(null);
  const dragRef = useRef(null);
  const lastSaved = useRef("");

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u ?? null)), []);

  /* load: Firestore when signed in, localStorage otherwise */
  useEffect(() => {
    if (user === undefined) return;
    setState(null);
    setSyncErr(null);
    if (!user) {
      setState(normalize(loadLocal()));
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
        setSyncErr(null);
      },
      (err) => {
        // Never hang on "tuning in…" — fall back to local data and say what broke.
        setSyncErr(err?.code || "unknown");
        setState((prev) => prev ?? normalize(loadLocal()));
      }
    );
    return unsub;
  }, [user]);

  /* debounced save */
  useEffect(() => {
    if (!state || user === undefined) return;
    const json = JSON.stringify(state);
    if (json === lastSaved.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      lastSaved.current = json;
      localStorage.setItem(LOCAL_KEY, json); // always keep a local copy
      if (user) {
        try {
          await setDoc(doc(db, "sig2noise", user.uid), state);
          setSyncErr(null);
        } catch (e) {
          setSyncErr(e?.code || "unknown");
        }
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [state, user]);

  /* mutations */
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

  const updateText = (id, text) => {
    const t = text.trim();
    if (t)
      setState((s) => ({
        ...s,
        signal: s.signal.map((i) => (i.id === id ? { ...i, text: t } : i)),
        noise: s.noise.map((i) => (i.id === id ? { ...i, text: t } : i)),
      }));
    setEditingId(null);
  };

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

  /* pointer drag (mouse + touch) */
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

  if (user === undefined || !state) {
    return (
      <div className="app">
        <div className="loading mono">TUNING IN…</div>
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
    <div className="app" onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {/* scrolling ticker */}
      <div className="ticker">
        <div className="ticker-track mono">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i}>
              PROTECT THE SIGNAL&nbsp;&nbsp;·&nbsp;&nbsp;3 THINGS&nbsp;&nbsp;·&nbsp;&nbsp;NEXT 18
              HOURS&nbsp;&nbsp;·&nbsp;&nbsp;EVERYTHING ELSE CAN WAIT&nbsp;&nbsp;·&nbsp;&nbsp;
            </span>
          ))}
        </div>
      </div>

      <div className="frame">
        {/* meta row */}
        <div className="metarow mono">
          <span>{dateLabel.toUpperCase()}</span>
          <span className="metarow-right">
            <span className={"status " + (syncErr ? "status-err" : "")}>
              {user
                ? syncErr
                  ? "SYNC ERROR"
                  : "● SYNCED — " + (user.displayName?.split(" ")[0] || "").toUpperCase()
                : "○ THIS DEVICE ONLY"}
            </span>
            {user ? (
              <button className="linkbtn mono" onClick={() => signOut(auth)}>
                SIGN OUT
              </button>
            ) : (
              <button
                className="linkbtn mono"
                onClick={() =>
                  signInWithPopup(auth, googleProvider).catch((e) => setSyncErr(e?.code || "auth"))
                }
              >
                SIGN IN TO SYNC
              </button>
            )}
          </span>
        </div>

        {syncErr && (
          <div className="errbar mono">
            {ERR_HELP[syncErr] || `Sync error (${syncErr}) — working from this device's copy.`}
          </div>
        )}

        {/* masthead */}
        <header className="masthead">
          <h1 className="display">
            <span className="display-solid">SIGNAL</span>
            <span className="display-outline">/NOISE</span>
          </h1>
          <p className="tagline">
            <em>The company will take as much of you as you give it.</em> Choose what gets the
            sharpest version of you — for the next <em>eighteen hours</em>.
          </p>
        </header>

        {/* waveform divider — fills amber as signals clear */}
        <Waveform cleared={cleared} allSet={allSet} />

        {/* THE SIGNAL */}
        <section
          data-zone="signal"
          className={
            "zone " + (flash ? "shake " : "") + (dropHint?.list === "signal" ? "zone-target " : "")
          }
        >
          <div className="zonelabel">
            <span className="zonelabel-index mono">01</span>
            <span className="zonelabel-name">THE SIGNAL</span>
            <span className="zonelabel-note">what actually moves things</span>
          </div>

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
              editing={editingId === item.id}
              onStartEdit={setEditingId}
              onEdit={updateText}
            />
          ))}
          {state.signal.length < 3 &&
            Array.from({ length: 3 - state.signal.length }).map((_, i) => (
              <div key={i} className="emptyrow">
                <span className="bignum bignum-ghost">
                  {String(state.signal.length + i + 1).padStart(2, "0")}
                </span>
                <span className="emptynote">reserved — promote something worth it</span>
              </div>
            ))}
        </section>

        {/* THE NOISE */}
        <section
          data-zone="noise"
          className={"zone zone-noise " + (dropHint?.list === "noise" ? "zone-target-noise" : "")}
        >
          <div className="zonelabel">
            <span className="zonelabel-index mono">02</span>
            <span className="zonelabel-name zonelabel-name-dim">THE NOISE</span>
            <span className="zonelabel-note">
              real, urgent-looking, and still able to wait · {state.noise.length}
            </span>
          </div>

          <div className="inputrow">
            <input
              className="input"
              value={input}
              placeholder="Capture it here. Don't obey it."
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
            />
            <button className="addbtn mono" onClick={addItem}>
              CAPTURE ↵
            </button>
          </div>

          {state.noise.length === 0 && (
            <div className="quiet">
              <em>Quiet.</em> Asks, fires and "quick things" land here first — then you decide.
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
              editing={editingId === item.id}
              onStartEdit={setEditingId}
              onEdit={updateText}
            />
          ))}
        </section>

        {/* THE RECORD */}
        <footer className="zone zone-record">
          <div className="zonelabel">
            <span className="zonelabel-index mono">03</span>
            <span className="zonelabel-name zonelabel-name-dim">THE RECORD</span>
            <span className="zonelabel-note">last seven days</span>
          </div>
          <div className="record">
            {strip.map((d, i) => (
              <div key={i} className="recday" title={`${d.date}: ${d.done}/${d.total || 3}`}>
                <div className="recbars">
                  {[2, 1, 0].map((seg) => (
                    <div key={seg} className={"recseg " + (d.done > seg ? "recseg-lit" : "")} />
                  ))}
                </div>
                <div className={"recdate mono " + (d.today ? "recdate-today" : "")}>
                  {d.today ? "NOW" : d.date.slice(5)}
                </div>
              </div>
            ))}
          </div>
        </footer>

        <div className="colophon mono">SIG/NOISE — RUTHLESS PRIORITIZATION · {state.date}</div>
      </div>

      {drag && (
        <div className="ghost" style={{ left: drag.x + 12, top: drag.y - 20 }}>
          {drag.text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Waveform({ cleared, allSet }) {
  const bars = 48;
  const litUntil = Math.round((cleared / 3) * bars);
  return (
    <div className="wave" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const h = 8 + Math.abs(Math.sin(i * 1.7) * 26) + Math.abs(Math.sin(i * 0.4) * 10);
        return (
          <div
            key={i}
            className={"wavebar " + (i < litUntil ? "wavebar-lit " : "") + (allSet ? "wavebar-live" : "")}
            style={{ height: h + "px", animationDelay: (i % 12) * 0.12 + "s" }}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Row({ item, index, zone, rank, dragging, hint, onToggle, onRemove, onPromote, onDemote, startDrag, editing, onStartEdit, onEdit }) {
  const isSignal = zone === "signal";
  return (
    <div
      data-row
      data-row-id={item.id}
      data-zone-name={zone}
      data-index={index}
      className={
        "row " +
        (isSignal ? "row-signal " : "row-noise ") +
        (dragging ? "row-dragging " : "") +
        (hint ? "row-hint " : "") +
        (item.done ? "row-done " : "")
      }
    >
      <span className="handle" onPointerDown={(e) => startDrag(e, item, zone)} aria-label="Drag to reorder">
        ⠿
      </span>

      {isSignal && (
        <span className={"bignum " + (item.done ? "bignum-done" : "")}>
          {String(rank).padStart(2, "0")}
        </span>
      )}

      <button
        onClick={() => onToggle(item.id)}
        className={"check mono " + (item.done ? "check-on" : "")}
        aria-label={item.done ? "Mark not done" : "Mark done"}
      >
        {item.done ? "DONE" : "MARK"}
      </button>

      {editing ? (
        <input
          className={"editinput " + (isSignal ? "text-signal" : "text-noise")}
          autoFocus
          defaultValue={item.text}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEdit(item.id, e.target.value);
            if (e.key === "Escape") onEdit(item.id, item.text);
          }}
          onBlur={(e) => onEdit(item.id, e.target.value)}
        />
      ) : (
        <span
          className={"text " + (isSignal ? "text-signal" : "text-noise")}
          onClick={() => onStartEdit(item.id)}
          title="Tap to edit"
        >
          {item.text}
          {item.carried && <span className="carried mono"> · CARRIED</span>}
        </span>
      )}

      <div className="rowbtns">
        {isSignal ? (
          <button className="minibtn mono" onClick={() => onDemote(item.id)} title="Back to noise">
            ↓
          </button>
        ) : (
          <button className="minibtn mono minibtn-up" onClick={() => onPromote(item.id)} title="Make it a signal">
            ↑
          </button>
        )}
        <button className="minibtn mono minibtn-del" onClick={() => onRemove(item.id)} title="Delete">
          ×
        </button>
      </div>
    </div>
  );
}
