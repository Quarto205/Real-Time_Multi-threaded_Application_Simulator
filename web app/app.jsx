import React, { useState, useEffect, useRef, useReducer } from 'react';
import { Play, Pause, RotateCcw, Plus, Activity, Server, Database, Printer, Lock } from 'lucide-react';

// --- CONSTANTS & THEME ---
const COLORS = [
    "#3B82F6", "#EF4444", "#10B981", "#F59E0B",
    "#8B5CF6", "#EC4899", "#6366F1", "#14B8A6"
];

const INITIAL_RESOURCES = {
    "Database": { value: 1, max: 1, holders: [], queue: [] },
    "Printer": { value: 2, max: 2, holders: [], queue: [] },
    "I/O Device": { value: 1, max: 1, holders: [], queue: [] }
};

// --- LOGIC ENGINE (Ported from Python) ---
// We use a reducer to handle the complex state transitions atomically

const initialState = {
    time: 0,
    isRunning: false,
    threads: [],
    runningThreads: [null], // Array for CPU cores
    readyQueue: [], // IDs
    blockedQueue: [], // IDs
    terminatedQueue: [], // IDs
    resources: JSON.parse(JSON.stringify(INITIAL_RESOURCES)),
    logs: [],
    config: {
        algorithm: "RR", // FCFS, SJF, PRIORITY, RR
        quantum: 3,
        cpuCount: 1,
        isPreemptive: false
    },
    quantumCounters: {} // {cpuIndex: count}
};

function schedulerReducer(state, action) {
    switch (action.type) {
        case 'TICK': {
            if (!state.isRunning) return state;

            let newState = { ...state, time: state.time + 1 };
            let newLogs = [...state.logs];
            let newThreads = [...state.threads]; // Deep copy needed if modifying thread props

            // 1. ARRIVAL: Move NEW threads to READY if arrival time met
            newThreads.forEach(t => {
                if (t.state === "NEW" && t.arrivalTime <= newState.time) {
                    t.state = "READY";
                    newState.readyQueue = [...newState.readyQueue, t.id];
                    newLogs.unshift(`[${newState.time}] T${t.id} Arrived -> Ready`);
                }
            });

            // 2. CPU EXECUTION
            let newRunning = [...newState.runningThreads];
            let newQuantum = { ...newState.quantumCounters };

            // Helper: Get Best Candidate
            const getCandidate = (currentReady) => {
                if (currentReady.length === 0) return null;
                let candidates = currentReady.map(id => newThreads.find(t => t.id === id));

                // Algorithm Sorts
                if (newState.config.algorithm === "FCFS" || newState.config.algorithm === "RR") {
                    // Already sorted by insertion order (FIFO)
                    return candidates[0];
                } else if (newState.config.algorithm === "SJF") {
                    candidates.sort((a, b) => a.remainingTime - b.remainingTime);
                    return candidates[0];
                } else if (newState.config.algorithm === "PRIORITY") {
                    candidates.sort((a, b) => b.priority - a.priority); // Desc priority
                    return candidates[0];
                }
                return candidates[0];
            };

            // Process each CPU
            for (let i = 0; i < newState.config.cpuCount; i++) {
                let tid = newRunning[i];

                // Initialize quantum if missing
                if (newQuantum[i] === undefined) newQuantum[i] = 0;

                // A. EXECUTE CURRENT
                if (tid !== null) {
                    const tIndex = newThreads.findIndex(t => t.id === tid);
                    const t = newThreads[tIndex];

                    // Record History
                    if (t.history.length > 0 && t.history[t.history.length - 1].state === "RUNNING") {
                        t.history[t.history.length - 1].end = newState.time;
                    } else {
                        t.history.push({ start: newState.time - 1, end: newState.time, state: "RUNNING" });
                    }

                    t.remainingTime -= 1;
                    newQuantum[i] += 1;

                    // Check Termination
                    if (t.remainingTime <= 0) {
                        t.state = "TERMINATED";
                        t.turnaroundTime = newState.time - t.arrivalTime;
                        t.waitingTime = t.turnaroundTime - t.burstTime;
                        newRunning[i] = null;
                        newState.terminatedQueue.push(t.id);
                        newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Terminated`);
                        newQuantum[i] = 0;
                    }
                    // Check Quantum (RR Only)
                    else if (newState.config.algorithm === "RR" && newQuantum[i] >= newState.config.quantum) {
                        t.state = "READY";
                        newRunning[i] = null;
                        newState.readyQueue.push(t.id);
                        newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Quantum Expired`);
                        newQuantum[i] = 0;
                    }
                    // Check Preemption (SJF/Priority)
                    else if (newState.config.isPreemptive && ["SJF", "PRIORITY"].includes(newState.config.algorithm)) {
                        const candidate = getCandidate(newState.readyQueue);
                        let shouldPreempt = false;
                        if (candidate) {
                            if (newState.config.algorithm === "SJF" && candidate.remainingTime < t.remainingTime) shouldPreempt = true;
                            if (newState.config.algorithm === "PRIORITY" && candidate.priority > t.priority) shouldPreempt = true;
                        }

                        if (shouldPreempt) {
                            t.state = "READY";
                            newRunning[i] = null;
                            newState.readyQueue.push(t.id);
                            // Remove candidate from ready queue
                            newState.readyQueue = newState.readyQueue.filter(id => id !== candidate.id);
                            // Put candidate on CPU immediately (swapping)
                            candidate.state = "RUNNING";
                            newRunning[i] = candidate.id;
                            newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Preempted by T${candidate.id}`);
                            newQuantum[i] = 0;
                        }
                    }
                }

                // B. DISPATCH (If CPU is free)
                if (newRunning[i] === null) {
                    const candidate = getCandidate(newState.readyQueue);
                    if (candidate) {
                        // Remove from Ready
                        newState.readyQueue = newState.readyQueue.filter(id => id !== candidate.id);

                        // Assign to CPU
                        candidate.state = "RUNNING";
                        newRunning[i] = candidate.id;
                        newQuantum[i] = 0;
                        newLogs.unshift(`[${newState.time}] CPU ${i}: Dispatched T${candidate.id}`);
                    }
                }
            }

            return {
                ...newState,
                threads: newThreads,
                runningThreads: newRunning,
                quantumCounters: newQuantum,
                logs: newLogs.slice(0, 50) // Keep last 50 logs
            };
        }

        case 'ADD_THREAD': {
            const { burst, priority, arrival } = action.payload;
            const id = state.threads.length + 1;
            const newThread = {
                id,
                burstTime: burst,
                remainingTime: burst,
                priority,
                arrivalTime: arrival,
                state: "NEW",
                color: COLORS[(id - 1) % COLORS.length],
                history: [],
                waitingTime: 0,
                heldResources: []
            };

            return {
                ...state,
                threads: [...state.threads, newThread],
                logs: [`[${state.time}] Created T${id} (Burst: ${burst}, Prio: ${priority})`, ...state.logs]
            };
        }

        case 'TOGGLE_RUN':
            return { ...state, isRunning: !state.isRunning };

        case 'RESET':
            return { ...initialState, config: state.config };

        case 'UPDATE_CONFIG':
            // Handle CPU resize
            let newRunning = [...state.runningThreads];
            if (action.payload.cpuCount > state.runningThreads.length) {
                // Expanded: Add nulls
                const diff = action.payload.cpuCount - state.runningThreads.length;
                for (let k = 0; k < diff; k++) newRunning.push(null);
            } else if (action.payload.cpuCount < state.runningThreads.length) {
                // Shrinking: Eject threads back to ready
                for (let k = action.payload.cpuCount; k < state.runningThreads.length; k++) {
                    if (newRunning[k] !== null) {
                        const t = state.threads.find(th => th.id === newRunning[k]);
                        t.state = "READY";
                        state.readyQueue.push(t.id);
                    }
                }
                newRunning = newRunning.slice(0, action.payload.cpuCount);
            }

            return {
                ...state,
                runningThreads: newRunning,
                config: { ...state.config, ...action.payload }
            };

        case 'RESOURCE_REQUEST': {
            const { threadId, resourceName } = action.payload;
            const res = state.resources[resourceName];
            let newRes = { ...state.resources };
            let newThreads = [...state.threads];
            let newRunning = [...state.runningThreads];
            let newBlocked = [...state.blockedQueue];
            let newLogs = [...state.logs];

            if (res.value > 0) {
                // Acquire
                newRes[resourceName].value -= 1;
                newRes[resourceName].holders.push(threadId);
                const t = newThreads.find(th => th.id === threadId);
                t.heldResources.push(resourceName);
                newLogs.unshift(`[${state.time}] T${threadId} Acquired ${resourceName}`);
            } else {
                // Block
                newRes[resourceName].queue.push(threadId);
                const t = newThreads.find(th => th.id === threadId);
                t.state = "BLOCKED";
                // Remove from CPU
                const cpuIdx = newRunning.indexOf(threadId);
                if (cpuIdx !== -1) newRunning[cpuIdx] = null;
                newBlocked.push(threadId);
                newLogs.unshift(`[${state.time}] T${threadId} Blocked waiting for ${resourceName}`);
            }

            return {
                ...state,
                resources: newRes,
                threads: newThreads,
                runningThreads: newRunning,
                blockedQueue: newBlocked,
                logs: newLogs
            };
        }

        case 'RESOURCE_RELEASE': {
            const { threadId, resourceName } = action.payload;
            let newRes = { ...state.resources };
            let newThreads = [...state.threads];
            let newReady = [...state.readyQueue];
            let newBlocked = [...state.blockedQueue];
            let newLogs = [...state.logs];

            // 1. Remove holder
            newRes[resourceName].holders = newRes[resourceName].holders.filter(h => h !== threadId);
            const tHolder = newThreads.find(th => th.id === threadId);
            tHolder.heldResources = tHolder.heldResources.filter(r => r !== resourceName);

            newRes[resourceName].value += 1;
            newLogs.unshift(`[${state.time}] T${threadId} Released ${resourceName}`);

            // 2. Wake up waiting
            if (newRes[resourceName].queue.length > 0) {
                const wokenId = newRes[resourceName].queue.shift();
                newRes[resourceName].value -= 1; // Woken thread takes it
                newRes[resourceName].holders.push(wokenId);

                const tWoken = newThreads.find(th => th.id === wokenId);
                tWoken.heldResources.push(resourceName);
                tWoken.state = "READY";

                // Remove from blocked queue
                newBlocked = newBlocked.filter(id => id !== wokenId);
                newReady.push(wokenId);
                newLogs.unshift(`[${state.time}] T${wokenId} Woken up (Acquired ${resourceName})`);
            }

            return {
                ...state,
                resources: newRes,
                threads: newThreads,
                readyQueue: newReady,
                blockedQueue: newBlocked,
                logs: newLogs
            };
        }

        case 'DEADLOCK_DEMO': {
            // Hard reset first
            let dState = { ...initialState, config: state.config };
            // Create T1 & T2
            const t1 = { id: 1, burstTime: 20, remainingTime: 20, priority: 1, arrivalTime: 0, state: "BLOCKED", color: COLORS[0], history: [], heldResources: ["Database"], waitingTime: 0 };
            const t2 = { id: 2, burstTime: 20, remainingTime: 20, priority: 1, arrivalTime: 0, state: "BLOCKED", color: COLORS[1], history: [], heldResources: ["Printer"], waitingTime: 0 };

            dState.threads = [t1, t2];
            dState.blockedQueue = [1, 2];

            // Setup Resources
            dState.resources["Database"].value = 0;
            dState.resources["Database"].holders = [1];
            dState.resources["Database"].queue = [2]; // T2 wants DB

            dState.resources["Printer"].value = 1; // Initial 2, T2 takes 1
            dState.resources["Printer"].holders = [2];
            dState.resources["Printer"].queue = [1]; // T1 wants Printer

            dState.logs = ["Deadlock Scenario Established: T1 holds DB, wants Printer. T2 holds Printer, wants DB."];

            return dState;
        }

        default:
            return state;
    }
}

// --- UI COMPONENTS ---

const Card = ({ children, className = "" }) => (
    <div className={`bg-gray-900/60 backdrop-blur-md border border-gray-700/50 rounded-xl p-4 shadow-xl ${className}`}>
        {children}
    </div>
);

const ThreadCard = ({ thread, type, onAction, resources }) => {
    const percent = ((thread.burstTime - thread.remainingTime) / thread.burstTime) * 100;

    return (
        <div className="group relative bg-gray-800/80 border-l-4 rounded-r-lg mb-3 p-3 transition-all hover:translate-x-1"
            style={{ borderLeftColor: thread.color }}>
            <div className="flex justify-between items-start mb-2">
                <div>
                    <span className="font-bold text-gray-100 text-sm">T{thread.id}</span>
                    <span className="ml-2 text-xs text-gray-400">P{thread.priority}</span>
                </div>
                <span className="text-xs font-mono text-cyan-400">{thread.remainingTime}s left</span>
            </div>

            {/* Progress Bar */}
            <div className="h-1.5 w-full bg-gray-700 rounded-full overflow-hidden mb-2">
                <div
                    className="h-full transition-all duration-300 ease-out"
                    style={{ width: `${percent}%`, backgroundColor: thread.color }}
                />
            </div>

            {/* Held Resources Badges */}
            {thread.heldResources.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                    {thread.heldResources.map(r => (
                        <span key={r} className="px-1.5 py-0.5 text-[10px] bg-emerald-900 text-emerald-300 rounded border border-emerald-700">
                            {r.substring(0, 3)}
                        </span>
                    ))}
                </div>
            )}

            {/* Actions */}
            {type === "RUNNING" && (
                <div className="flex gap-2 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <select
                        className="bg-gray-900 text-[10px] text-white border border-gray-600 rounded px-1"
                        onChange={(e) => {
                            if (e.target.value) onAction('REQ', thread.id, e.target.value);
                            e.target.value = "";
                        }}
                    >
                        <option value="">Req Res...</option>
                        {Object.keys(resources).map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    {thread.heldResources.length > 0 && (
                        <button onClick={() => onAction('REL', thread.id, thread.heldResources[0])} className="bg-blue-600 hover:bg-blue-500 text-[10px] text-white px-2 rounded">Rel</button>
                    )}
                </div>
            )}
        </div>
    );
};

// --- MAIN APP COMPONENT ---

export default function App() {
    const [state, dispatch] = useReducer(schedulerReducer, initialState);
    const [speed, setSpeed] = useState(1000);

    // Inputs
    const [newThread, setNewThread] = useState({ burst: 10, priority: 1, arrival: 0 });

    useEffect(() => {
        let interval = null;
        if (state.isRunning) {
            interval = setInterval(() => {
                dispatch({ type: 'TICK' });
            }, speed);
        }
        return () => clearInterval(interval);
    }, [state.isRunning, speed]);

    const handleCreate = () => {
        dispatch({ type: 'ADD_THREAD', payload: newThread });
    };

    const handleConfigChange = (key, val) => {
        dispatch({ type: 'UPDATE_CONFIG', payload: { ...state.config, [key]: val } });
    };

    const handleResourceAction = (action, tid, res) => {
        if (action === 'REQ') dispatch({ type: 'RESOURCE_REQUEST', payload: { threadId: tid, resourceName: res } });
        if (action === 'REL') dispatch({ type: 'RESOURCE_RELEASE', payload: { threadId: tid, resourceName: res } });
    };

    return (
        <div className="min-h-screen bg-gray-950 text-gray-300 font-sans selection:bg-cyan-500/30">
            {/* HEADER */}
            <header className="bg-gray-900/80 border-b border-gray-800 backdrop-blur sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Activity className="text-cyan-500 w-6 h-6" />
                        <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 to-purple-500 bg-clip-text text-transparent">
                            NEON OS <span className="text-xs text-gray-500 font-normal ml-2">v2.0 Web Edition</span>
                        </h1>
                    </div>

                    <div className="flex items-center gap-4 bg-gray-800/50 rounded-full px-4 py-1.5 border border-gray-700">
                        <div className="text-xs font-mono text-gray-400">SYS TIME</div>
                        <div className="text-2xl font-mono font-bold text-white">{String(state.time).padStart(3, '0')}</div>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">

                {/* LEFT SIDEBAR - CONTROLS */}
                <div className="lg:col-span-3 space-y-6">
                    <Card>
                        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Kernel Control</h2>

                        <div className="flex gap-2 mb-6">
                            <button
                                onClick={() => dispatch({ type: 'TOGGLE_RUN' })}
                                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg font-bold transition-all ${state.isRunning
                                        ? 'bg-amber-500/10 text-amber-500 border border-amber-500/50 hover:bg-amber-500/20'
                                        : 'bg-emerald-500 text-gray-900 hover:bg-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.4)]'
                                    }`}
                            >
                                {state.isRunning ? <Pause size={18} /> : <Play size={18} />}
                                {state.isRunning ? 'PAUSE' : 'START'}
                            </button>

                            <button
                                onClick={() => dispatch({ type: 'RESET' })}
                                className="px-3 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400"
                            >
                                <RotateCcw size={18} />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-gray-500 mb-1 block">Algorithm</label>
                                <select
                                    className="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm focus:border-cyan-500 outline-none"
                                    value={state.config.algorithm}
                                    onChange={(e) => handleConfigChange('algorithm', e.target.value)}
                                >
                                    <option value="RR">Round Robin (RR)</option>
                                    <option value="FCFS">First Come First Serve</option>
                                    <option value="SJF">Shortest Job First</option>
                                    <option value="PRIORITY">Priority Scheduling</option>
                                </select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-gray-500 mb-1 block">CPU Cores</label>
                                    <input type="number" min="1" max="4"
                                        value={state.config.cpuCount}
                                        onChange={(e) => handleConfigChange('cpuCount', parseInt(e.target.value))}
                                        className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-2 text-sm text-center"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 mb-1 block">Quantum</label>
                                    <input type="number" min="1" max="20"
                                        value={state.config.quantum}
                                        onChange={(e) => handleConfigChange('quantum', parseInt(e.target.value))}
                                        className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-2 text-sm text-center"
                                    />
                                </div>
                            </div>

                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-gray-400">Preemptive</span>
                                <button
                                    onClick={() => handleConfigChange('isPreemptive', !state.config.isPreemptive)}
                                    className={`w-10 h-5 rounded-full relative transition-colors ${state.config.isPreemptive ? 'bg-cyan-600' : 'bg-gray-700'}`}
                                >
                                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${state.config.isPreemptive ? 'left-6' : 'left-1'}`} />
                                </button>
                            </div>

                            <div>
                                <label className="text-xs text-gray-500 mb-1 block">Tick Speed: {speed}ms</label>
                                <input type="range" min="100" max="2000" step="100"
                                    value={speed} onChange={(e) => setSpeed(Number(e.target.value))}
                                    className="w-full accent-cyan-500 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                />
                            </div>
                        </div>

                        <div className="mt-6 pt-6 border-t border-gray-800">
                            <button onClick={() => dispatch({ type: 'DEADLOCK_DEMO' })} className="w-full py-2 text-xs font-bold text-red-400 bg-red-500/10 border border-red-500/30 rounded hover:bg-red-500/20 transition-colors">
                                TRIGGER DEADLOCK DEMO
                            </button>
                        </div>
                    </Card>

                    {/* ADD THREAD */}
                    <Card>
                        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">New Process</h2>
                        <div className="grid grid-cols-3 gap-2 mb-4">
                            <div>
                                <label className="text-[10px] uppercase text-gray-500">Burst</label>
                                <input type="number" className="w-full bg-gray-950 border border-gray-700 rounded p-1 text-center text-sm"
                                    value={newThread.burst} onChange={e => setNewThread({ ...newThread, burst: parseInt(e.target.value) })}
                                />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase text-gray-500">Prio</label>
                                <input type="number" className="w-full bg-gray-950 border border-gray-700 rounded p-1 text-center text-sm"
                                    value={newThread.priority} onChange={e => setNewThread({ ...newThread, priority: parseInt(e.target.value) })}
                                />
                            </div>
                            <div>
                                <label className="text-[10px] uppercase text-gray-500">Arr</label>
                                <input type="number" className="w-full bg-gray-950 border border-gray-700 rounded p-1 text-center text-sm"
                                    value={newThread.arrival} onChange={e => setNewThread({ ...newThread, arrival: parseInt(e.target.value) })}
                                />
                            </div>
                        </div>
                        <button onClick={handleCreate} className="w-full flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded text-sm transition-colors">
                            <Plus size={14} /> Create Thread
                        </button>
                    </Card>
                </div>

                {/* MIDDLE - VISUALIZATION */}
                <div className="lg:col-span-6 space-y-6">

                    {/* CPUS */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {state.runningThreads.map((tid, idx) => (
                            <div key={idx} className="bg-gray-900 border border-gray-700 rounded-xl p-4 relative overflow-hidden">
                                <div className="absolute top-0 right-0 p-2 opacity-10">
                                    <Server size={64} />
                                </div>
                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="font-bold text-gray-400">CPU {idx}</h3>
                                    {tid && <Activity size={16} className="text-green-400 animate-pulse" />}
                                </div>

                                {tid ? (
                                    <ThreadCard
                                        thread={state.threads.find(t => t.id === tid)}
                                        type="RUNNING"
                                        onAction={handleResourceAction}
                                        resources={state.resources}
                                    />
                                ) : (
                                    <div className="h-24 flex items-center justify-center border-2 border-dashed border-gray-800 rounded-lg">
                                        <span className="text-gray-600 text-sm">IDLE</span>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* QUEUES */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[500px]">

                        {/* READY QUEUE */}
                        <Card className="flex flex-col h-full overflow-hidden">
                            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-700">
                                <h3 className="font-bold text-cyan-500">READY QUEUE</h3>
                                <span className="bg-cyan-900/50 text-cyan-300 text-xs px-2 py-0.5 rounded-full">{state.readyQueue.length}</span>
                            </div>
                            <div className="flex-1 overflow-y-auto pr-2 scrollbar-thin">
                                {state.readyQueue.length === 0 && <div className="text-center text-gray-600 mt-10">Queue Empty</div>}
                                {state.readyQueue.map(tid => (
                                    <ThreadCard key={tid} thread={state.threads.find(t => t.id === tid)} type="READY" />
                                ))}
                            </div>
                        </Card>

                        {/* BLOCKED/TERMINATED TABS */}
                        <Card className="flex flex-col h-full overflow-hidden">
                            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-700">
                                <h3 className="font-bold text-pink-500">BLOCKED & I/O</h3>
                                <span className="bg-pink-900/50 text-pink-300 text-xs px-2 py-0.5 rounded-full">{state.blockedQueue.length}</span>
                            </div>
                            <div className="flex-1 overflow-y-auto pr-2 scrollbar-thin">
                                {state.blockedQueue.length === 0 && <div className="text-center text-gray-600 mt-10">No Blocked Threads</div>}
                                {state.blockedQueue.map(tid => (
                                    <ThreadCard key={tid} thread={state.threads.find(t => t.id === tid)} type="BLOCKED" />
                                ))}
                            </div>

                            <div className="mt-4 pt-2 border-t border-gray-800">
                                <h4 className="text-xs text-gray-500 mb-2">Terminated: {state.terminatedQueue.length}</h4>
                                <div className="flex flex-wrap gap-1">
                                    {state.terminatedQueue.map(tid => (
                                        <span key={tid} className="text-[10px] bg-gray-800 text-gray-500 px-1.5 rounded">T{tid}</span>
                                    ))}
                                </div>
                            </div>
                        </Card>

                    </div>
                </div>

                {/* RIGHT - RESOURCES & LOGS */}
                <div className="lg:col-span-3 space-y-6">

                    {/* RESOURCES */}
                    <Card>
                        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">System Resources</h2>
                        <div className="space-y-3">
                            {Object.entries(state.resources).map(([name, res]) => (
                                <div key={name} className="bg-gray-950 p-3 rounded-lg border border-gray-800">
                                    <div className="flex justify-between items-center mb-2">
                                        <div className="flex items-center gap-2">
                                            {name === "Database" ? <Database size={14} className="text-blue-400" /> : name === "Printer" ? <Printer size={14} className="text-purple-400" /> : <Server size={14} className="text-orange-400" />}
                                            <span className="text-sm font-bold text-gray-300">{name}</span>
                                        </div>
                                        <span className={`text-xs px-2 rounded ${res.value > 0 ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
                                            {res.value} / {res.max}
                                        </span>
                                    </div>

                                    {/* Holders */}
                                    {res.holders.length > 0 && (
                                        <div className="flex gap-1 mb-1">
                                            <Lock size={10} className="text-red-500 mt-0.5" />
                                            {res.holders.map(h => (
                                                <span key={h} className="text-[10px] bg-red-500/10 text-red-400 px-1 rounded">T{h}</span>
                                            ))}
                                        </div>
                                    )}
                                    {/* Queue */}
                                    {res.queue.length > 0 && (
                                        <div className="flex gap-1">
                                            <span className="text-[10px] text-gray-500">Wait:</span>
                                            {res.queue.map(q => (
                                                <span key={q} className="text-[10px] bg-gray-800 text-gray-400 px-1 rounded">T{q}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </Card>

                    {/* LOGS */}
                    <Card className="h-[400px] flex flex-col">
                        <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Kernel Logs</h2>
                        <div className="flex-1 overflow-y-auto font-mono text-[11px] space-y-1 pr-2 scrollbar-thin">
                            {state.logs.map((log, i) => (
                                <div key={i} className="text-gray-400 border-b border-gray-800/50 pb-1">
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