import React, { useState, useEffect, useReducer } from 'react';
import { Play, Pause, RotateCcw, Plus, Activity, Server, Database, Printer, Lock, Box, Cpu, Layers, AlertCircle, Zap } from 'lucide-react';

// --- CONSTANTS & THEME ---
const COLORS = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B",
  "#8B5CF6", "#EC4899", "#6366F1", "#14B8A6"
];

// System Resources (Kernel Objects - Cause System Blocking)
const INITIAL_RESOURCES = {
  "Database": { type: 'MUTEX', value: 1, max: 1, holders: [], queue: [] },
  "Printer": { type: 'SEMAPHORE', value: 2, max: 2, holders: [], queue: [] },
  "Disk I/O": { type: 'SEMAPHORE', value: 1, max: 1, holders: [], queue: [] }
};

// Monitors (User Level Sync - Managed by Library/Runtime)
const INITIAL_MONITORS = {
  "Buffer": {
    lockedBy: null, // Thread ID
    queue: [], // Entry Queue (Mutex)
    cvs: {
      "NotFull": [],  // Waiting Threads
      "NotEmpty": []  // Waiting Threads
    },
    data: 0 // For visualization (e.g., items in buffer)
  }
};

const initialState = {
  time: 0,
  isRunning: false,
  processes: {}, // { pid: { id, color, lwpCount, type } }
  threads: [],
  runningThreads: [null, null], // [threadId | null]
  readyQueue: [], // [threadId]
  blockedQueue: [], // [threadId]
  terminatedQueue: [], // [threadId]
  resources: JSON.parse(JSON.stringify(INITIAL_RESOURCES)),
  monitors: JSON.parse(JSON.stringify(INITIAL_MONITORS)),
  logs: [],
  config: {
    algorithm: "RR",
    quantum: 4,
    cpuCount: 2,
    threadingModel: "One-to-One", // "One-to-One", "Many-to-One", "Many-to-Many"
    defaultLWP: 2 // For M:M
  },
  quantumCounters: {}
};

// --- LOGIC ENGINE ---

function schedulerReducer(state, action) {
  // Helper: Check if a thread can be dispatched based on Threading Model
  const canDispatch = (thread, currentRun, currentBlock) => {
    if (state.config.threadingModel === "One-to-One") return true;

    const process = state.processes[thread.processId];
    if (!process) return true;

    // Count how many threads of this process are 'Active' (Running or Blocked on System)
    // In M:1, a System Block (I/O) holds the LWP.
    const activeCount =
      currentRun.filter(tid => tid && state.threads.find(t => t.id === tid)?.processId === process.id).length +
      currentBlock.filter(tid => {
        const t = state.threads.find(th => th.id === tid);
        return t?.processId === process.id && t?.blockedType === 'SYSTEM';
      }).length;

    const limit = state.config.threadingModel === "Many-to-One" ? 1 : process.lwpCount;
    return activeCount < limit;
  };

  switch (action.type) {
    case 'TICK': {
      if (!state.isRunning) return state;

      let newState = { ...state, time: state.time + 1 };
      let newLogs = [...state.logs];
      let newThreads = [...state.threads]; // Deep copy ideally

      // 1. ARRIVAL
      newThreads.forEach(t => {
        if (t.state === "NEW" && t.arrivalTime <= newState.time) {
          t.state = "READY";
          newState.readyQueue.push(t.id);
          newLogs.unshift(`[${newState.time}] T${t.id} (P${t.processId}) Arrived -> Ready`);
        }
      });

      // 2. CPU EXECUTION & SCHEDULING
      let newRunning = [...newState.runningThreads];
      let newQuantum = { ...newState.quantumCounters };
      let newReady = [...newState.readyQueue];

      // A. Execution Phase
      for (let i = 0; i < newState.config.cpuCount; i++) {
        let tid = newRunning[i];
        if (newQuantum[i] === undefined) newQuantum[i] = 0;

        if (tid) {
          const tIndex = newThreads.findIndex(t => t.id === tid);
          const t = newThreads[tIndex];

          if (!t) {
            newRunning[i] = null;
            continue;
          }

          // History
          if (t.history.length > 0 && t.history[t.history.length - 1].state === "RUNNING") {
            t.history[t.history.length - 1].end = newState.time;
          } else {
            t.history.push({ start: newState.time - 1, end: newState.time, state: "RUNNING" });
          }

          t.remainingTime -= 1;
          newQuantum[i] += 1;

          // Termination
          if (t.remainingTime <= 0) {
            t.state = "TERMINATED";
            // Release Monitor locks if held (Crash safety)
            if (t.monitorHeld) {
              // Simplified release logic for crash
              newState.monitors[t.monitorHeld].lockedBy = null;
              t.monitorHeld = null;
            }
            newRunning[i] = null;
            newState.terminatedQueue.push(t.id);
            newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Terminated`);
            newQuantum[i] = 0;
          }
          // Quantum Expiry (RR)
          else if (newState.config.algorithm === "RR" && newQuantum[i] >= newState.config.quantum) {
            t.state = "READY";
            newRunning[i] = null;
            newReady.push(t.id);
            newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Quantum Expired`);
            newQuantum[i] = 0;
          }
        }
      }

      // B. Dispatch Phase
      for (let i = 0; i < newState.config.cpuCount; i++) {
        if (newRunning[i] === null) {
          // Filter candidates based on LWP availability (Threading Model)
          const candidates = newReady.filter(tid => {
            const t = newThreads.find(th => th.id === tid);
            return canDispatch(t, newRunning, newState.blockedQueue);
          });

          if (candidates.length > 0) {
            // Simple FIFO for candidates for now (can expand to Priority/SJF)
            const candidateId = candidates[0];
            const t = newThreads.find(th => th.id === candidateId);

            // Remove from Ready (Note: need to remove specific ID)
            newReady = newReady.filter(id => id !== candidateId);

            t.state = "RUNNING";
            newRunning[i] = candidateId;
            newQuantum[i] = 0;
            newLogs.unshift(`[${newState.time}] CPU ${i}: Dispatched T${t.id} (P${t.processId})`);
          }
        }
      }

      newState.readyQueue = newReady;
      newState.runningThreads = newRunning;
      newState.quantumCounters = newQuantum;
      newState.threads = newThreads;
      newState.logs = newLogs.slice(0, 60);
      return newState;
    }

    case 'CREATE_PROCESS': {
      const { threadCount, burst, priority, model } = action.payload;
      const pid = Object.keys(state.processes).length + 1;
      const color = COLORS[(pid - 1) % COLORS.length];

      const newProcess = {
        id: pid,
        color: color,
        lwpCount: model === "Many-to-One" ? 1 : (model === "Many-to-Many" ? state.config.defaultLWP : threadCount),
        type: "USER"
      };

      const newThreads = [];
      for (let i = 0; i < threadCount; i++) {
        const tid = state.threads.length + i + 1;
        newThreads.push({
          id: tid,
          processId: pid,
          burstTime: burst,
          remainingTime: burst,
          priority: priority,
          arrivalTime: state.time, // Immediate arrival
          state: "NEW",
          color: color,
          history: [],
          heldResources: [],
          monitorHeld: null, // Name of monitor held
          blockedType: null // 'SYSTEM' or 'USER'
        });
      }

      return {
        ...state,
        processes: { ...state.processes, [pid]: newProcess },
        threads: [...state.threads, ...newThreads],
        logs: [`[${state.time}] Created Process P${pid} with ${threadCount} Threads (${state.config.threadingModel})`, ...state.logs]
      };
    }

    case 'TOGGLE_RUN': return { ...state, isRunning: !state.isRunning };
    case 'RESET': return { ...initialState, config: state.config };

    case 'UPDATE_CONFIG':
      // Handle CPU resize logic similar to before...
      let resRunning = [...state.runningThreads];
      if (action.payload.cpuCount !== state.config.cpuCount) {
        resRunning = Array(action.payload.cpuCount).fill(null);
        // Eject all to ready to be safe
        state.runningThreads.forEach(tid => {
          if (tid) {
            const t = state.threads.find(th => th.id === tid);
            t.state = "READY";
            state.readyQueue.push(tid);
          }
        });
      }
      return { ...state, runningThreads: resRunning, config: { ...state.config, ...action.payload } };

    // --- SYNCHRONIZATION LOGIC ---

    case 'RESOURCE_OP': {
      // Handle System Resources (Semaphores)
      // Blocking here is "SYSTEM" level -> Holds LWP in Many-to-One
      const { tid, resName, op } = action.payload;
      let nextState = { ...state };
      let res = nextState.resources[resName];
      let t = nextState.threads.find(th => th.id === tid);

      if (op === 'REQ') {
        if (res.value > 0) {
          res.value--;
          res.holders.push(tid);
          t.heldResources.push(resName);
          nextState.logs.unshift(`[${state.time}] T${tid} Acquired ${resName}`);
        } else {
          res.queue.push(tid);
          t.state = "BLOCKED";
          t.blockedType = 'SYSTEM'; // CRITICAL: Holds LWP in M:1
          // Remove from CPU
          const cpuIdx = nextState.runningThreads.indexOf(tid);
          if (cpuIdx !== -1) nextState.runningThreads[cpuIdx] = null;
          nextState.blockedQueue.push(tid);
          nextState.logs.unshift(`[${state.time}] T${tid} Blocked on ${resName} (System)`);
        }
      } else if (op === 'REL') {
        if (t.heldResources.includes(resName)) {
          res.value++;
          res.holders = res.holders.filter(h => h !== tid);
          t.heldResources = t.heldResources.filter(r => r !== resName);
          nextState.logs.unshift(`[${state.time}] T${tid} Released ${resName}`);

          if (res.queue.length > 0) {
            const wokenId = res.queue.shift();
            const wokenT = nextState.threads.find(th => th.id === wokenId);
            res.value--;
            res.holders.push(wokenId);
            wokenT.heldResources.push(resName);
            wokenT.state = "READY";
            wokenT.blockedType = null;
            nextState.blockedQueue = nextState.blockedQueue.filter(id => id !== wokenId);
            nextState.readyQueue.push(wokenId);
            nextState.logs.unshift(`[${state.time}] T${wokenId} Unblocked (Got ${resName})`);
          }
        }
      }
      return nextState;
    }

    case 'MONITOR_OP': {
      // Handle Monitor Operations (Enter, Exit, Wait, Signal)
      // Blocking here is "USER" level -> Yields LWP (usually)
      const { tid, monName, op, cvName } = action.payload;
      let nextState = { ...state };
      let mon = nextState.monitors[monName];
      let t = nextState.threads.find(th => th.id === tid);
      const cpuIdx = nextState.runningThreads.indexOf(tid);

      if (op === 'ENTER') {
        if (mon.lockedBy === null) {
          mon.lockedBy = tid;
          t.monitorHeld = monName;
          nextState.logs.unshift(`[${state.time}] T${tid} Entered Monitor ${monName}`);
        } else {
          mon.queue.push(tid);
          t.state = "BLOCKED";
          t.blockedType = 'USER'; // Yields LWP
          if (cpuIdx !== -1) nextState.runningThreads[cpuIdx] = null;
          nextState.blockedQueue.push(tid);
          nextState.logs.unshift(`[${state.time}] T${tid} Waiting for Monitor ${monName}`);
        }
      }
      else if (op === 'EXIT') {
        if (mon.lockedBy === tid) {
          mon.lockedBy = null;
          t.monitorHeld = null;
          nextState.logs.unshift(`[${state.time}] T${tid} Exited Monitor ${monName}`);

          // MESA Semantics: Wake up next thread waiting for Monitor Entry
          if (mon.queue.length > 0) {
            const wokenId = mon.queue.shift();
            const wokenT = nextState.threads.find(th => th.id === wokenId);
            mon.lockedBy = wokenId;
            wokenT.monitorHeld = monName;
            wokenT.state = "READY";
            wokenT.blockedType = null;
            nextState.blockedQueue = nextState.blockedQueue.filter(id => id !== wokenId);
            nextState.readyQueue.push(wokenId);
          }
        }
      }
      else if (op === 'WAIT') {
        // 1. Release Lock
        mon.lockedBy = null;

        // 2. Add to CV Queue
        mon.cvs[cvName].push(tid);

        // 3. Block Thread
        t.state = "BLOCKED";
        t.blockedType = 'USER';
        if (cpuIdx !== -1) nextState.runningThreads[cpuIdx] = null;
        nextState.blockedQueue.push(tid);

        // 4. Admit next entry (Mesa)
        if (mon.queue.length > 0) {
          const wokenId = mon.queue.shift();
          const wokenT = nextState.threads.find(th => th.id === wokenId);
          mon.lockedBy = wokenId;
          wokenT.monitorHeld = monName;
          wokenT.state = "READY";
          wokenT.blockedType = null;
          nextState.blockedQueue = nextState.blockedQueue.filter(id => id !== wokenId);
          nextState.readyQueue.push(wokenId);
        }
        nextState.logs.unshift(`[${state.time}] T${tid} Wait on CV ${cvName}`);
      }
      else if (op === 'SIGNAL') {
        if (mon.cvs[cvName].length > 0) {
          const wokenId = mon.cvs[cvName].shift();
          const wokenT = nextState.threads.find(th => th.id === wokenId);

          // Mesa: Signaled thread goes to Monitor Entry Queue (or Ready if lock avail, but lock is held by signaler)
          // Simply: Move from CV Queue to Monitor Entry Queue
          mon.queue.unshift(wokenId); // High priority entry?
          // Still blocked, but now waiting for Monitor, not CV
          nextState.logs.unshift(`[${state.time}] T${tid} Signaled ${cvName} -> T${wokenId} moved to Entry Q`);
        }
      }

      return nextState;
    }

    default: return state;
  }
}

// --- UI COMPONENTS ---

const Card = ({ children, className = "" }) => (
  <div className={`bg-gray-900/60 backdrop-blur-md border border-gray-700/50 rounded-xl p-4 shadow-xl ${className}`}>
    {children}
  </div>
);

const ThreadCard = ({ thread, type, dispatch }) => {
  const percent = ((thread.burstTime - thread.remainingTime) / thread.burstTime) * 100;

  return (
    <div className="group relative bg-gray-800/80 border-l-4 rounded-r-lg mb-2 p-2 transition-all hover:translate-x-1"
      style={{ borderLeftColor: thread.color }}>
      <div className="flex justify-between items-start mb-1">
        <div className="flex items-center gap-2">
          <span className="font-bold text-gray-100 text-xs">T{thread.id}</span>
          <span className="text-[10px] px-1 rounded bg-gray-700 text-gray-300">P{thread.processId}</span>
        </div>
        <span className="text-[10px] font-mono text-cyan-400">{thread.remainingTime}s</span>
      </div>

      <div className="h-1 w-full bg-gray-700 rounded-full overflow-hidden mb-1">
        <div className="h-full transition-all duration-300" style={{ width: `${percent}%`, backgroundColor: thread.color }} />
      </div>

      {/* Badges for Held Items */}
      <div className="flex flex-wrap gap-1">
        {thread.heldResources.map(r => (
          <span key={r} className="px-1 py-0.5 text-[8px] bg-red-900/50 text-red-300 rounded border border-red-800">{r}</span>
        ))}
        {thread.monitorHeld && (
          <span className="px-1 py-0.5 text-[8px] bg-purple-900/50 text-purple-300 rounded border border-purple-800">MON: {thread.monitorHeld}</span>
        )}
        {type === "BLOCKED" && (
          <span className="px-1 py-0.5 text-[8px] bg-gray-700 text-gray-400 border border-gray-600">
            {thread.blockedType} BLOCK
          </span>
        )}
      </div>

      {/* Action Menu (Only for Running) */}
      {type === "RUNNING" && (
        <div className="mt-2 grid grid-cols-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Sys Resource Actions */}
          <div className="col-span-2 flex gap-1">
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: 'Database', op: 'REQ' } })}
              className="flex-1 bg-blue-900/50 hover:bg-blue-800 text-[9px] text-blue-200 border border-blue-800 rounded px-1 py-0.5">
              Req DB
            </button>
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: 'Printer', op: 'REQ' } })}
              className="flex-1 bg-blue-900/50 hover:bg-blue-800 text-[9px] text-blue-200 border border-blue-800 rounded px-1 py-0.5">
              Req Prn
            </button>
          </div>

          {/* Monitor Actions */}
          <div className="col-span-2 border-t border-gray-700 pt-1 mt-1">
            {!thread.monitorHeld ? (
              <button onClick={() => dispatch({ type: 'MONITOR_OP', payload: { tid: thread.id, monName: 'Buffer', op: 'ENTER' } })}
                className="w-full bg-purple-900/50 hover:bg-purple-800 text-[9px] text-purple-200 border border-purple-800 rounded py-0.5">
                Enter Monitor
              </button>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                <button onClick={() => dispatch({ type: 'MONITOR_OP', payload: { tid: thread.id, monName: 'Buffer', op: 'WAIT', cvName: 'NotEmpty' } })}
                  className="bg-yellow-900/50 text-yellow-200 border border-yellow-800 rounded text-[9px]">
                  Wt Empty
                </button>
                <button onClick={() => dispatch({ type: 'MONITOR_OP', payload: { tid: thread.id, monName: 'Buffer', op: 'SIGNAL', cvName: 'NotEmpty' } })}
                  className="bg-green-900/50 text-green-200 border border-green-800 rounded text-[9px]">
                  Sig Empty
                </button>
                <button onClick={() => dispatch({ type: 'MONITOR_OP', payload: { tid: thread.id, monName: 'Buffer', op: 'EXIT' } })}
                  className="bg-red-900/50 text-red-200 border border-red-800 rounded text-[9px]">
                  Exit
                </button>
              </div>
            )}
          </div>

          {/* Release Actions */}
          {thread.heldResources.length > 0 && (
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: thread.heldResources[0], op: 'REL' } })}
              className="col-span-2 bg-emerald-900/50 hover:bg-emerald-800 text-emerald-200 border border-emerald-800 rounded py-0.5 text-[9px]">
              Release {thread.heldResources[0]}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// --- MAIN APP ---

export default function App() {
  const [state, dispatch] = useReducer(schedulerReducer, initialState);
  const [speed, setSpeed] = useState(1000);

  // Create Process Form
  const [procConfig, setProcConfig] = useState({ threads: 3, burst: 15, priority: 1 });

  useEffect(() => {
    let interval = null;
    if (state.isRunning) {
      interval = setInterval(() => { dispatch({ type: 'TICK' }); }, speed);
    }
    return () => clearInterval(interval);
  }, [state.isRunning, speed]);

  const createProcess = () => {
    dispatch({
      type: 'CREATE_PROCESS',
      payload: {
        threadCount: procConfig.threads,
        burst: procConfig.burst,
        priority: procConfig.priority,
        model: state.config.threadingModel
      }
    });
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-300 font-sans selection:bg-cyan-500/30 pb-20">
      {/* HEADER */}
      <header className="bg-gray-900/80 border-b border-gray-800 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="text-cyan-500 w-6 h-6" />
            <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-purple-500 bg-clip-text text-transparent">
              NEON OS <span className="text-xs text-gray-500 font-normal ml-2">Simulator</span>
            </h1>
          </div>
          <div className="flex gap-4 text-xs font-mono">
            <div className="flex flex-col items-end">
              <span className="text-gray-500">MODEL</span>
              <span className="text-cyan-400 font-bold">{state.config.threadingModel}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-gray-500">TIME</span>
              <span className="text-white font-bold text-lg">{String(state.time).padStart(3, '0')}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT COLUMN: Controls */}
        <div className="lg:col-span-3 space-y-4">
          <Card>
            <div className="flex gap-2 mb-4">
              <button onClick={() => dispatch({ type: 'TOGGLE_RUN' })}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg font-bold transition-all ${state.isRunning ? 'bg-amber-500/10 text-amber-500 border border-amber-500/50' : 'bg-emerald-600 text-white hover:bg-emerald-500'}`}>
                {state.isRunning ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button onClick={() => dispatch({ type: 'RESET' })} className="px-3 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700"><RotateCcw size={18} /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Threading Model</label>
                <select className="w-full bg-gray-900 border border-gray-700 rounded text-xs p-2 mt-1 focus:border-cyan-500 outline-none"
                  value={state.config.threadingModel}
                  onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', payload: { threadingModel: e.target.value } })}>
                  <option value="One-to-One">One-to-One (1:1)</option>
                  <option value="Many-to-One">Many-to-One (M:1)</option>
                  <option value="Many-to-Many">Many-to-Many (M:M)</option>
                </select>
                <p className="text-[9px] text-gray-500 mt-1 leading-tight">
                  {state.config.threadingModel === "Many-to-One" ? "Entire Process blocks if one thread enters System Block." :
                    state.config.threadingModel === "One-to-One" ? "Threads are independent. High concurrency." :
                      "Hybrid model. Pool of LWPs."}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-500">CPUs</label>
                  <input type="number" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-center text-xs"
                    value={state.config.cpuCount} onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', payload: { cpuCount: parseInt(e.target.value) } })} min="1" max="4" />
                </div>

                {/* SPEED CONTROLLER */}
                <div className="col-span-2 mt-2">
                  <label className="text-[10px] text-gray-500 flex justify-between">
                    <span>Sim Speed</span>
                    <span>{speed}ms</span>
                  </label>
                  <input type="range" min="100" max="2000" step="100"
                    value={speed} onChange={(e) => setSpeed(parseInt(e.target.value))}
                    className="w-full accent-cyan-500 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer mt-1"
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="text-xs font-bold text-gray-400 uppercase mb-3">Create Process</h3>
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[9px] text-gray-600">Threads</label>
                  <input type="number" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-xs text-center"
                    value={procConfig.threads} onChange={e => setProcConfig({ ...procConfig, threads: parseInt(e.target.value) })} min="1" />
                </div>
                <div>
                  <label className="text-[9px] text-gray-600">Burst</label>
                  <input type="number" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-xs text-center"
                    value={procConfig.burst} onChange={e => setProcConfig({ ...procConfig, burst: parseInt(e.target.value) })} />
                </div>
                <div>
                  <label className="text-[9px] text-gray-600">Prio</label>
                  <input type="number" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-xs text-center"
                    value={procConfig.priority} onChange={e => setProcConfig({ ...procConfig, priority: parseInt(e.target.value) })} />
                </div>
              </div>
              <button onClick={createProcess} className="w-full bg-cyan-900/40 border border-cyan-800 hover:bg-cyan-900/60 text-cyan-400 text-xs py-2 rounded flex items-center justify-center gap-2">
                <Plus size={14} /> Spawn Process
              </button>
            </div>
          </Card>
        </div>

        {/* MIDDLE COLUMN: Visualization */}
        <div className="lg:col-span-6 space-y-4">
          {/* CPUs */}
          <div className="grid grid-cols-2 gap-3">
            {state.runningThreads.map((tid, idx) => (
              <div key={idx} className="bg-gray-900 border border-gray-800 rounded-lg p-3 relative overflow-hidden h-32 flex flex-col">
                <div className="flex justify-between items-center mb-2 z-10">
                  <span className="text-xs font-bold text-gray-500 flex items-center gap-1"><Cpu size={12} /> CPU {idx}</span>
                  {tid && <Activity size={12} className="text-green-500 animate-pulse" />}
                </div>
                {tid ? (
                  <ThreadCard thread={state.threads.find(t => t.id === tid)} type="RUNNING" dispatch={dispatch} />
                ) : (
                  <div className="flex-1 flex items-center justify-center border-2 border-dashed border-gray-800 rounded">
                    <span className="text-[10px] text-gray-700">IDLE</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* QUEUES */}
          <div className="grid grid-cols-2 gap-3 h-80">
            <Card className="flex flex-col">
              <div className="flex justify-between border-b border-gray-800 pb-2 mb-2">
                <span className="text-xs font-bold text-cyan-500">READY</span>
                <span className="text-[10px] bg-cyan-900/30 text-cyan-400 px-1.5 rounded">{state.readyQueue.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin pr-1">
                {state.readyQueue.map(tid => (
                  <ThreadCard key={tid} thread={state.threads.find(t => t.id === tid)} type="READY" />
                ))}
              </div>
            </Card>
            <Card className="flex flex-col">
              <div className="flex justify-between border-b border-gray-800 pb-2 mb-2">
                <span className="text-xs font-bold text-pink-500">BLOCKED</span>
                <span className="text-[10px] bg-pink-900/30 text-pink-400 px-1.5 rounded">{state.blockedQueue.length}</span>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin pr-1">
                {state.blockedQueue.map(tid => (
                  <ThreadCard key={tid} thread={state.threads.find(t => t.id === tid)} type="BLOCKED" />
                ))}
              </div>
            </Card>
          </div>
        </div>

        {/* RIGHT COLUMN: Resources & Monitors */}
        <div className="lg:col-span-3 space-y-4">
          {/* MONITORS */}
          <Card className="bg-purple-900/10 border-purple-500/20">
            <div className="flex items-center gap-2 mb-3">
              <Box size={14} className="text-purple-400" />
              <h3 className="text-xs font-bold text-purple-400 uppercase">Monitor: Buffer</h3>
            </div>

            <div className="bg-gray-900/80 p-3 rounded border border-gray-800">
              <div className="flex justify-between items-center mb-2 border-b border-gray-800 pb-2">
                <span className="text-[10px] text-gray-400">LOCK (Mutex)</span>
                {state.monitors["Buffer"].lockedBy ? (
                  <span className="text-[10px] text-red-400 bg-red-900/20 px-1 rounded flex items-center gap-1">
                    <Lock size={8} /> T{state.monitors["Buffer"].lockedBy}
                  </span>
                ) : <span className="text-[10px] text-green-500">FREE</span>}
              </div>

              <div className="space-y-2">
                {/* Entry Queue */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">ENTRY Q</span>
                  <div className="flex gap-1">
                    {state.monitors["Buffer"].queue.length === 0 && <span className="text-[9px] text-gray-700">-</span>}
                    {state.monitors["Buffer"].queue.map(id => <span key={id} className="text-[9px] bg-gray-700 px-1 rounded">T{id}</span>)}
                  </div>
                </div>
                {/* CV: NotEmpty */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-yellow-600 w-12">NotEmpty</span>
                  <div className="flex gap-1">
                    {state.monitors["Buffer"].cvs["NotEmpty"].length === 0 && <span className="text-[9px] text-gray-700">-</span>}
                    {state.monitors["Buffer"].cvs["NotEmpty"].map(id => <span key={id} className="text-[9px] bg-yellow-900/30 text-yellow-500 px-1 rounded">T{id}</span>)}
                  </div>
                </div>
                {/* CV: NotFull */}
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-green-600 w-12">NotFull</span>
                  <div className="flex gap-1">
                    {state.monitors["Buffer"].cvs["NotFull"].length === 0 && <span className="text-[9px] text-gray-700">-</span>}
                    {state.monitors["Buffer"].cvs["NotFull"].map(id => <span key={id} className="text-[9px] bg-green-900/30 text-green-500 px-1 rounded">T{id}</span>)}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* SYSTEM RESOURCES */}
          <Card>
            <h3 className="text-xs font-bold text-gray-500 uppercase mb-3">Kernel Resources</h3>
            <div className="space-y-2">
              {Object.entries(state.resources).map(([name, res]) => (
                <div key={name} className="bg-gray-900 p-2 rounded border border-gray-800">
                  <div className="flex justify-between mb-1">
                    <span className="text-[10px] font-bold text-gray-300">{name}</span>
                    <span className={`text-[9px] px-1 rounded ${res.value > 0 ? 'text-green-400 bg-green-900/20' : 'text-red-400 bg-red-900/20'}`}>
                      {res.value}/{res.max}
                    </span>
                  </div>
                  {res.holders.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      <Lock size={8} className="text-red-500" />
                      {res.holders.map(h => <span key={h} className="text-[8px] bg-red-900/30 text-red-300 px-1 rounded">T{h}</span>)}
                    </div>
                  )}
                  {res.queue.length > 0 && (
                    <div className="flex gap-1 mt-1 border-t border-gray-800 pt-1">
                      <span className="text-[8px] text-gray-500">WAIT:</span>
                      {res.queue.map(q => <span key={q} className="text-[8px] bg-gray-800 text-gray-400 px-1 rounded">T{q}</span>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* LOGS */}
          <Card className="h-40 flex flex-col">
            <div className="flex-1 overflow-y-auto font-mono text-[9px] space-y-1 scrollbar-thin">
              {state.logs.map((log, i) => (
                <div key={i} className="text-gray-500 border-b border-gray-800/50 pb-0.5">
                  {log}
                </div>
              ))}
            </div>
          </Card>
        </div>

      </main>
    </div>
  );
} 