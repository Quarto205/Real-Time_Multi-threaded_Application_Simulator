
import React, { useState, useEffect, useReducer } from 'react';
import {
  Play, Pause, RotateCcw, Plus, Activity, Server, Database, Printer,
  Lock, Box, Cpu, Layers, AlertOctagon, Car, ArrowRight, Minus, Eye, EyeOff, BookOpen, X
} from 'lucide-react';

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
    data: 0 // Resource Count
  }
};

const initialState = {
  time: 0,
  isRunning: false,
  processes: {}, // { pid: { id, color, lwpCount, type } }
  threads: [],
  runningThreads: Array(2).fill(null),
  readyQueue: [],
  blockedQueue: [],
  terminatedQueue: [],
  resources: JSON.parse(JSON.stringify(INITIAL_RESOURCES)),
  monitors: JSON.parse(JSON.stringify(INITIAL_MONITORS)),
  logs: [],
  config: {
    algorithm: "RR",
    quantum: 4,
    cpuCount: 2,
    threadingModel: "One-to-One",
    defaultLWP: 2,
    resourceTimeLimit: 0 // 0 = Disabled
  },
  quantumCounters: {}
};

// --- TEST SCENARIOS ---
const TEST_SCENARIOS = {
  "RR": {
    config: { algorithm: "RR", cpuCount: 1, threadingModel: "One-to-One" },
    processes: [{ threads: 3, burst: 15, priority: 1, delay: 0 }]
  },
  "M2O": {
    config: { algorithm: "RR", cpuCount: 2, threadingModel: "Many-to-One" },
    processes: [{ threads: 2, burst: 20, priority: 1, delay: 0 }]
  },
  "121": {
    config: { algorithm: "RR", cpuCount: 2, threadingModel: "One-to-One" },
    processes: [{ threads: 2, burst: 20, priority: 1, delay: 0 }]
  },
  "MON": {
    config: { algorithm: "RR", cpuCount: 2, threadingModel: "One-to-One" },
    processes: [
      {
        threads: 1, burst: 30, priority: 1, delay: 0,
        instructions: [
          { at: 2, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'ENTER' } },
          { at: 4, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'MODIFY_DATA', value: 1 } }, // Produce
          { at: 5, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'SIGNAL', cvName: 'NotEmpty' } },
          { at: 8, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'EXIT' } }
        ]
      },
      {
        threads: 1, burst: 30, priority: 1, delay: 0,
        instructions: [
          { at: 2, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'ENTER' } },
          // Mesa Style: While (data == 0) Wait(NotEmpty)
          { at: 5, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'CHECK_AND_WAIT', cvName: 'NotEmpty', condition: '==0' } },
          { at: 6, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'MODIFY_DATA', value: -1 } }, // Consume
          { at: 10, type: 'MONITOR_OP', payload: { monName: 'Buffer', op: 'EXIT' } }
        ]
      }
    ]
  },
  "DL": {
    config: { algorithm: "RR", cpuCount: 2, threadingModel: "One-to-One" },
    processes: [
      {
        threads: 1, burst: 999, priority: 1, delay: 0,
        instructions: [
          { at: 0, type: 'RESOURCE_OP', payload: { resName: 'Database', op: 'REQ' } },
          { at: 1, type: 'RESOURCE_OP', payload: { resName: 'Printer', op: 'REQ' } }
        ]
      },
      {
        threads: 1, burst: 999, priority: 1, delay: 0,
        instructions: [
          { at: 0, type: 'RESOURCE_OP', payload: { resName: 'Printer', op: 'REQ' } },
          { at: 1, type: 'RESOURCE_OP', payload: { resName: 'Database', op: 'REQ' } }
        ]
      }
    ]
  }
};

// --- LOGIC ENGINE ---

// Helper: Process Resource Operation
const processResourceOp = (state, tid, resName, op) => {
  let nextState = { ...state, logs: [...state.logs] };
  let res = nextState.resources[resName];
  let t = nextState.threads.find(th => th.id === tid);
  if (!t) return nextState;

  if (op === 'REQ') {
    if (res.value > 0) {
      res.value--;
      res.holders.push(tid);
      t.heldResources.push({ name: resName, acquiredAt: state.time });
      nextState.logs.unshift(`[${state.time}] T${tid} Acquired ${resName}`);
    } else {
      res.queue.push(tid);
      t.state = "BLOCKED";
      t.blockedType = 'SYSTEM';
      const cpuIdx = nextState.runningThreads.indexOf(tid);
      if (cpuIdx !== -1) nextState.runningThreads[cpuIdx] = null;
      nextState.blockedQueue = [...nextState.blockedQueue, tid];
      nextState.logs.unshift(`[${state.time}] T${tid} Blocked on ${resName}`);
    }
  } else if (op === 'REL') {
    const heldRes = t.heldResources.find(r => r.name === resName);
    if (heldRes) {
      res.value++;
      res.holders = res.holders.filter(h => h !== tid);
      t.heldResources = t.heldResources.filter(r => r.name !== resName);
      nextState.logs.unshift(`[${state.time}] T${tid} Released ${resName}`);

      if (res.queue.length > 0) {
        const wokenId = res.queue.shift();
        const wokenT = nextState.threads.find(th => th.id === wokenId);
        if (wokenT) {
          res.value--;
          res.holders.push(wokenId);
          wokenT.heldResources.push({ name: resName, acquiredAt: state.time });
          wokenT.state = "READY";
          wokenT.blockedType = null;
          nextState.blockedQueue = nextState.blockedQueue.filter(id => id !== wokenId);
          nextState.readyQueue.push(wokenId);
          nextState.logs.unshift(`[${state.time}] T${wokenId} Woken up`);
        }
      }
    }
  }
  return nextState;
};

// Helper: Process Monitor Operation
const processMonitorOp = (state, tid, monName, op, cvName, value) => {
  let nextState = { ...state, logs: [...state.logs] };
  let mon = nextState.monitors[monName];
  let t = nextState.threads.find(th => th.id === tid);
  if (!t) return nextState;

  const cpuIdx = nextState.runningThreads.indexOf(tid);

  if (op === 'ENTER') {
    if (mon.lockedBy === null) {
      mon.lockedBy = tid;
      t.monitorHeld = monName;
      nextState.logs.unshift(`[${state.time}] T${tid} Entered Monitor`);
    } else if (mon.lockedBy === tid) {
      // Already held
    } else {
      mon.queue.push(tid);
      t.state = "BLOCKED";
      t.blockedType = 'USER';
      if (cpuIdx !== -1) nextState.runningThreads[cpuIdx] = null;
      nextState.blockedQueue = [...nextState.blockedQueue, tid];
      nextState.logs.unshift(`[${state.time}] T${tid} Waiting for Monitor`);
    }
  }
  else if (op === 'EXIT') {
    if (mon.lockedBy === tid) {
      mon.lockedBy = null;
      t.monitorHeld = null;
      nextState.logs.unshift(`[${state.time}] T${tid} Exited Monitor`);
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
    if (mon.lockedBy === tid) {
      mon.lockedBy = null;
      mon.cvs[cvName].push(tid);
      t.state = "BLOCKED";
      t.blockedType = 'USER';
      t.monitorHeld = null;
      if (cpuIdx !== -1) nextState.runningThreads[cpuIdx] = null;
      nextState.blockedQueue = [...nextState.blockedQueue, tid];

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
  }
  else if (op === 'SIGNAL') {
    if (mon.lockedBy === tid) {
      if (mon.cvs[cvName].length > 0) {
        const wokenId = mon.cvs[cvName].shift();
        mon.queue.push(wokenId); // Mesa: Move to Entry Queue
        nextState.logs.unshift(`[${state.time}] T${tid} Signaled ${cvName} -> T${wokenId} to Entry Q`);
      }
    }
  }
  else if (op === 'BROADCAST') {
    if (mon.lockedBy === tid) {
      let count = 0;
      while (mon.cvs[cvName].length > 0) {
        const wokenId = mon.cvs[cvName].shift();
        mon.queue.push(wokenId);
        count++;
      }
      if (count > 0) nextState.logs.unshift(`[${state.time}] T${tid} Broadcast ${cvName} -> ${count} threads to Entry Q`);
    }
  }
  else if (op === 'MODIFY_DATA') {
    if (mon.lockedBy === tid) {
      mon.data += value || 0;
      nextState.logs.unshift(`[${state.time}] T${tid} Modified Data: ${mon.data}`);
    }
  }
  return nextState;
};

function schedulerReducer(state, action) {
  // Helper: Check if a thread can be dispatched based on Threading Model
  const canDispatch = (thread, currentRun, currentBlock) => {
    if (state.config.threadingModel === "One-to-One") return true;

    const process = state.processes[thread.processId];
    if (!process) return true;

    // Count Active Threads (Running + System Blocked)
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
      let newThreads = [...state.threads];

      // 1. ARRIVAL
      newThreads.forEach(t => {
        if (t.state === "NEW" && t.arrivalTime <= newState.time) {
          t.state = "READY";
          newState.readyQueue.push(t.id);
          newLogs.unshift(`[${newState.time}] T${t.id} (P${t.processId}) Arrived -> Ready`);
        }
      });

      // 2. CPU EXECUTION
      let newRunning = [...newState.runningThreads];
      let newQuantum = { ...newState.quantumCounters };
      let newReady = [...newState.readyQueue];

      for (let i = 0; i < newState.config.cpuCount; i++) {
        let tid = newRunning[i];
        if (newQuantum[i] === undefined) newQuantum[i] = 0;

        if (tid !== null) {
          const tIndex = newThreads.findIndex(t => t.id === tid);
          if (tIndex === -1) {
            newRunning[i] = null; // Auto-correct stale/invalid ID
            continue;
          }
          const t = newThreads[tIndex];

          if (t.history.length > 0 && t.history[t.history.length - 1].state === "RUNNING") {
            t.history[t.history.length - 1].end = newState.time;
          } else {
            t.history.push({ start: newState.time - 1, end: newState.time, state: "RUNNING" });
          }

          // --- EXECUTE INSTRUCTIONS (AUTOMATION) ---
          if (t.instructions && t.instructions.length > 0) {
            const nextInstr = t.instructions[0];
            if ((newState.time - t.arrivalTime) >= nextInstr.at) {
              let instructionCompleted = true;

              if (nextInstr.type === 'RESOURCE_OP') {
                newState = processResourceOp(newState, t.id, nextInstr.payload.resName, nextInstr.payload.op);
              } else if (nextInstr.type === 'MONITOR_OP') {
                if (nextInstr.payload.op === 'CHECK_AND_WAIT') {
                  const mon = newState.monitors[nextInstr.payload.monName];
                  // Simple condition check: if data == 0 (for Consumer)
                  // In a real app, we'd parse the condition. Here we assume "Wait if data == 0"
                  if (mon.data === 0) {
                    newState = processMonitorOp(newState, t.id, nextInstr.payload.monName, 'WAIT', nextInstr.payload.cvName);
                    instructionCompleted = false; // Stay on this instruction (Loop)
                  } else {
                    // Condition met (data > 0), proceed to next instruction (Consume)
                    instructionCompleted = true;
                  }
                } else {
                  newState = processMonitorOp(newState, t.id, nextInstr.payload.monName, nextInstr.payload.op, nextInstr.payload.cvName, nextInstr.payload.value);
                }
              }

              // Re-fetch thread as state might have changed (blocked)
              const updatedT = newState.threads.find(th => th.id === tid);

              if (instructionCompleted) {
                t.instructions.shift(); // Remove instruction only if completed
              }

              if (updatedT.state !== "RUNNING") {
                newRunning[i] = null;
                newQuantum[i] = 0;
                continue; // Stop processing this thread for this tick
              }
            }
          }
          t.elapsedBurst += 1;
          // -----------------------------------------

          t.remainingTime -= 1;
          newQuantum[i] += 1;

          if (t.remainingTime <= 0) {
            t.state = "TERMINATED";

            // 1. Release Held Monitors (Wake up waiters)
            // 1. Release Held Monitors (Wake up waiters & CV waiters)
            if (t.monitorHeld) {
              const mon = newState.monitors[t.monitorHeld];
              mon.lockedBy = null;

              // Wake up Entry Queue
              if (mon.queue.length > 0) {
                const wokenId = mon.queue.shift();
                const wokenT = newThreads.find(th => th.id === wokenId);
                mon.lockedBy = wokenId;
                wokenT.monitorHeld = t.monitorHeld;
                wokenT.state = "READY";
                wokenT.blockedType = null;
                newState.blockedQueue = newState.blockedQueue.filter(id => id !== wokenId);
                newReady.push(wokenId);
                newLogs.unshift(`[${newState.time}] T${wokenId} Woken up (Monitor Exit by Term)`);
              }

              // Wake up ALL CV Waiters (Prevent Zombies)
              Object.keys(mon.cvs).forEach(cvName => {
                while (mon.cvs[cvName].length > 0) {
                  const wokenId = mon.cvs[cvName].shift();
                  const wokenT = newThreads.find(th => th.id === wokenId);
                  // Move to Entry Queue (Mesa) or Ready? 
                  // Since lock might be taken by Entry Queue waiter above, we should probably move them to Entry Queue
                  // But to be safe and ensure progress, let's just make them READY (they will try to acquire lock and block if needed, or just run)
                  // Actually, if they were WAITing, they expect to hold the lock when they wake up.
                  // But we just gave the lock to `mon.queue.shift()`.
                  // So we should push them to `mon.queue`.
                  mon.queue.push(wokenId);
                  // They are still BLOCKED (waiting for lock), but now in Entry Queue.
                  // They are NOT removed from blockedQueue yet.
                  newLogs.unshift(`[${newState.time}] T${wokenId} Moved from CV ${cvName} to Entry Q (Monitor Holder Terminated)`);
                }
              });
            }

            // 2. Release Held Resources (Wake up waiters)
            if (t.heldResources.length > 0) {
              t.heldResources.forEach(res => {
                const rObj = newState.resources[res.name];
                rObj.value++;
                rObj.holders = rObj.holders.filter(h => h !== t.id);

                if (rObj.queue.length > 0) {
                  const wokenId = rObj.queue.shift();
                  const wokenT = newThreads.find(th => th.id === wokenId);
                  if (wokenT) {
                    rObj.value--;
                    rObj.holders.push(wokenId);
                    wokenT.heldResources.push({ name: res.name, acquiredAt: newState.time });
                    wokenT.state = "READY";
                    wokenT.blockedType = null;
                    newState.blockedQueue = newState.blockedQueue.filter(id => id !== wokenId);
                    newReady.push(wokenId);
                    newLogs.unshift(`[${newState.time}] T${wokenId} Woken up (Resource ${res.name} Released by Term)`);
                  }
                }
              });
              t.heldResources = [];
            }

            newRunning[i] = null;
            newState.terminatedQueue.push(t.id);
            newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Terminated`);
            newQuantum[i] = 0;
          }
          else if (newState.config.algorithm === "RR" && newQuantum[i] >= newState.config.quantum) {
            t.state = "READY";
            newRunning[i] = null;
            newReady.push(t.id);
            newLogs.unshift(`[${newState.time}] CPU ${i}: T${t.id} Quantum Expired`);
            newQuantum[i] = 0;
          }
        }
      }

      // 2.5 RESOURCE TIMEOUT CHECK
      if (newState.config.resourceTimeLimit > 0) {
        newThreads.forEach(t => {
          if (t.heldResources.length > 0) {
            [...t.heldResources].forEach(res => {
              if (newState.time - res.acquiredAt >= newState.config.resourceTimeLimit) {
                // Force Release Logic
                const resName = res.name;
                const rObj = newState.resources[resName];

                rObj.value++;
                rObj.holders = rObj.holders.filter(h => h !== t.id);
                t.heldResources = t.heldResources.filter(r => r.name !== resName);
                newLogs.unshift(`[${newState.time}] System Force Released ${resName} from T${t.id} (Timeout)`);

                if (rObj.queue.length > 0) {
                  const wokenId = rObj.queue.shift();
                  const wokenT = newThreads.find(th => th.id === wokenId);
                  if (wokenT) {
                    rObj.value--;
                    rObj.holders.push(wokenId);
                    wokenT.heldResources.push({ name: resName, acquiredAt: newState.time });
                    wokenT.state = "READY";
                    wokenT.blockedType = null;
                    newState.blockedQueue = newState.blockedQueue.filter(id => id !== wokenId);
                    newReady.push(wokenId);
                    newLogs.unshift(`[${newState.time}] T${wokenId} Woken up (Resource ${resName})`);
                  }
                }
              }
            });
          }
        });
      }

      // 3. DISPATCH
      for (let i = 0; i < newState.config.cpuCount; i++) {
        if (newRunning[i] === null) {
          // Filter candidates based on LWP availability
          const candidates = newReady.filter(tid => {
            const t = newThreads.find(th => th.id === tid);
            return canDispatch(t, newRunning, newState.blockedQueue);
          });

          if (candidates.length > 0) {
            // Sort candidates based on Algorithm
            if (newState.config.algorithm === "SJF") {
              candidates.sort((a, b) => {
                const tA = newThreads.find(t => t.id === a);
                const tB = newThreads.find(t => t.id === b);
                return tA.remainingTime - tB.remainingTime;
              });
            } else if (newState.config.algorithm === "Priority") {
              candidates.sort((a, b) => {
                const tA = newThreads.find(t => t.id === a);
                const tB = newThreads.find(t => t.id === b);
                return tA.priority - tB.priority;
              });
            } else if (newState.config.algorithm === "FCFS") {
              candidates.sort((a, b) => {
                const tA = newThreads.find(t => t.id === a);
                const tB = newThreads.find(t => t.id === b);
                return tA.arrivalTime - tB.arrivalTime;
              });
            }

            const candidateId = candidates[0];
            const t = newThreads.find(th => th.id === candidateId);

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

      // 4. AUTO-PAUSE IF IDLE
      const isIdle = newRunning.every(t => t === null) && newReady.length === 0 && newState.blockedQueue.length === 0;
      if (isIdle && state.threads.length > 0) {
        newState.isRunning = false;
        newState.logs.unshift(`[${newState.time}] Simulation Auto-Paused (All Tasks Completed)`);
      }

      return newState;
    }

    case 'CREATE_PROCESS': {
      const { threadCount, burst, priority, model, arrivalDelay, instructions } = action.payload;
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
          arrivalTime: state.time + (arrivalDelay || 0),
          state: "NEW",
          color: color,
          history: [],
          heldResources: [],
          monitorHeld: null,
          blockedType: null,
          instructions: instructions ? JSON.parse(JSON.stringify(instructions)) : [],
          elapsedBurst: 0
        });
      }

      return {
        ...state,
        processes: { ...state.processes, [pid]: newProcess },
        threads: [...state.threads, ...newThreads],
        logs: [`[${state.time}] Created Process P${pid} with ${threadCount} Threads`, ...state.logs]
      };
    }

    case 'TOGGLE_RUN': return { ...state, isRunning: !state.isRunning };
    case 'RESET': return {
      ...initialState,
      resources: JSON.parse(JSON.stringify(INITIAL_RESOURCES)),
      monitors: JSON.parse(JSON.stringify(INITIAL_MONITORS)),
      config: state.config
    };

    case 'UPDATE_CONFIG':
      let resRunning = [...state.runningThreads];
      if (action.payload.cpuCount !== state.config.cpuCount) {
        resRunning = Array(action.payload.cpuCount).fill(null);
        state.runningThreads.forEach(tid => {
          if (tid) {
            const t = state.threads.find(th => th.id === tid);
            t.state = "READY";
            state.readyQueue.push(tid);
          }
        });
      }
      return { ...state, runningThreads: resRunning, config: { ...state.config, ...action.payload } };

    case 'RESOURCE_OP': {
      const { tid, resName, op } = action.payload;
      return processResourceOp(state, tid, resName, op);
    }

    case 'MONITOR_OP': {
      const { tid, monName, op, cvName, value } = action.payload;
      return processMonitorOp(state, tid, monName, op, cvName, value);
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
    <div className="group relative bg-gray-800/80 border-l-4 rounded-r-lg mb-2 p-2 transition-all duration-300 hover:translate-x-1 hover:bg-gray-800"
      style={{ borderLeftColor: thread.color }}>
      <div className="flex justify-between items-start mb-1">
        <div className="flex items-center gap-2">
          <span className="font-bold text-gray-100 text-xs">T{thread.id}</span>
          <span className="text-[10px] px-1 rounded bg-gray-700 text-gray-300">P{thread.processId}</span>
        </div>
        <span className="text-[10px] font-mono text-cyan-400">{thread.remainingTime}s</span>
      </div>

      <div className="h-1 w-full bg-gray-700 rounded-full overflow-hidden mb-1">
        <div className="h-full transition-all duration-500 ease-out" style={{ width: `${percent}%`, backgroundColor: thread.color }} />
      </div>

      <div className="flex flex-wrap gap-1">
        {thread.heldResources.map(r => (
          <span key={r.name} className="px-1 py-0.5 text-[8px] bg-red-900/50 text-red-300 rounded border border-red-800">{r.name}</span>
        ))}
        {thread.monitorHeld && (
          <span className="px-1 py-0.5 text-[8px] bg-purple-900/50 text-purple-300 rounded border border-purple-800">MON: {thread.monitorHeld}</span>
        )}
        {type === "BLOCKED" && (
          <span className="px-1 py-0.5 text-[8px] bg-gray-700 text-gray-400 border border-gray-600">
            {thread.blockedType}
          </span>
        )}
      </div>

      {type === "RUNNING" && (
        <div className="mt-2 grid grid-cols-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="col-span-2 flex gap-1">
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: 'Database', op: 'REQ' } })}
              className="flex-1 bg-blue-900/50 hover:bg-blue-800 text-[9px] text-blue-200 border border-blue-800 rounded px-1 py-0.5">
              Req DB
            </button>
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: 'Printer', op: 'REQ' } })}
              className="flex-1 bg-blue-900/50 hover:bg-blue-800 text-[9px] text-blue-200 border border-blue-800 rounded px-1 py-0.5">
              Req Prn
            </button>
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: 'Disk I/O', op: 'REQ' } })}
              className="flex-1 bg-blue-900/50 hover:bg-blue-800 text-[9px] text-blue-200 border border-blue-800 rounded px-1 py-0.5">
              Req Disk
            </button>
          </div>

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
                <button onClick={() => dispatch({ type: 'MONITOR_OP', payload: { tid: thread.id, monName: 'Buffer', op: 'BROADCAST', cvName: 'NotEmpty' } })}
                  className="col-span-3 bg-green-900/50 text-green-200 border border-green-800 rounded text-[9px] mt-1">
                  Broadcast
                </button>
              </div>
            )}
          </div>

          {thread.heldResources.length > 0 && (
            <button onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: thread.id, resName: thread.heldResources[0].name, op: 'REL' } })}
              className="col-span-2 bg-emerald-900/50 hover:bg-emerald-800 text-emerald-200 border border-emerald-800 rounded py-0.5 text-[9px]">
              Release {thread.heldResources[0].name}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// --- NEW COMPONENT: LWP HIGHWAY VISUALIZER ---
const HighwayVisualizer = ({ state }) => {
  return (
    <Card className="col-span-12 bg-gray-900/90 border-cyan-900/30">
      <div className="flex items-center gap-2 mb-4">
        <Car className="text-cyan-400" size={18} />
        <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Process Highway (LWP Visualization)</h2>
      </div>

      {Object.keys(state.processes).length === 0 && (
        <div className="text-center text-gray-600 text-xs py-4">No Active Processes on Highway</div>
      )}

      <div className="space-y-6">
        {Object.values(state.processes).map(proc => {
          // Get Threads for this process
          const procThreads = state.threads.filter(t => t.processId === proc.id && t.state !== "TERMINATED");
          if (procThreads.length === 0) return null;

          // Determine Occupants of LWPs
          // Threads that are RUNNING or SYSTEM BLOCKED are occupying an LWP
          const occupants = procThreads.filter(t =>
            t.state === "RUNNING" || (t.state === "BLOCKED" && t.blockedType === "SYSTEM")
          );

          // Threads waiting for LWP (Ready or User Blocked/Waiting)
          const waiting = procThreads.filter(t =>
            t.state === "READY" || (t.state === "BLOCKED" && t.blockedType === "USER")
          );

          // Create Lanes Array
          const lanes = Array(state.config.threadingModel === "Many-to-One" ? 1 :
            state.config.threadingModel === "One-to-One" ? Math.max(procThreads.length, 1) :
              proc.lwpCount).fill(null);

          // Fill Lanes with occupants
          occupants.forEach((t, idx) => {
            if (idx < lanes.length) lanes[idx] = t;
          });

          return (
            <div key={proc.id} className="grid grid-cols-12 gap-4 items-center">

              {/* Process Info */}
              <div className="col-span-2 flex flex-col items-center justify-center p-2 rounded border border-gray-800" style={{ borderColor: proc.color }}>
                <span className="text-xs font-bold text-white">Process {proc.id}</span>
                <span className="text-[9px] text-gray-500">{state.config.threadingModel}</span>
              </div>

              {/* User Space Queue (Parking Lot) */}
              <div className="col-span-3 flex flex-wrap gap-1 justify-end items-center p-2 border-r border-gray-800 border-dashed">
                {waiting.length === 0 && <span className="text-[9px] text-gray-700">User Space Empty</span>}
                {waiting.map(t => (
                  <div key={t.id} className="w-6 h-6 rounded flex items-center justify-center text-[9px] font-bold text-white relative" style={{ backgroundColor: t.color }}>
                    T{t.id}
                    {t.blockedType === 'USER' && <div className="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full"></div>}
                  </div>
                ))}
              </div>

              {/* The LWP Lanes (The Highway) */}
              <div className="col-span-6 flex flex-col gap-2 relative px-4">
                {/* Road Markings */}
                <div className="absolute left-0 top-0 bottom-0 w-px bg-gray-700 border-dashed"></div>
                <div className="absolute right-0 top-0 bottom-0 w-px bg-gray-700 border-dashed"></div>

                {lanes.map((occupant, i) => (
                  <div key={i} className="h-8 bg-gray-800 rounded flex items-center justify-between px-2 relative overflow-hidden group border border-gray-700">
                    <span className="text-[8px] text-gray-600 font-mono absolute left-1">LWP-{i}</span>

                    {/* The Car */}
                    {occupant ? (
                      <div className="flex items-center gap-2 w-full justify-center z-10">
                        <Car size={14} className={occupant.blockedType === 'SYSTEM' ? "text-red-500" : "text-green-500"} />
                        <div className={`px-2 py-0.5 rounded text-[9px] font-bold flex items-center gap-1 ${occupant.blockedType === 'SYSTEM' ? "bg-red-900 text-red-200" : "bg-green-900 text-green-200"}`}>
                          T{occupant.id}
                          {occupant.blockedType === 'SYSTEM' && <AlertOctagon size={10} />}
                        </div>
                      </div>
                    ) : (
                      <div className="w-full flex justify-center opacity-20">
                        <Minus size={14} />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Destination (Kernel/CPU) */}
              <div className="col-span-1 flex justify-center">
                <Cpu size={24} className="text-gray-600" />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

// --- NEW COMPONENT: GANTT CHART ---
const GanttChart = ({ state }) => {
  // Flatten history for visualization
  // We want to show a timeline. 
  // Let's just show the last 60 ticks or so to keep it manageable, or full history?
  // Let's show full history but scrollable.

  const maxTime = state.time;
  const threadsWithHistory = state.threads.filter(t => t.history.length > 0);

  return (
    <Card className="col-span-12 bg-gray-900/90 border-cyan-900/30 overflow-hidden">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="text-cyan-400" size={18} />
        <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Execution History (Gantt Chart)</h2>
      </div>

      <div className="overflow-x-auto pb-2 scrollbar-thin">
        <div className="min-w-[800px] relative" style={{ width: `${Math.max(100, maxTime * 20)}px` }}>
          {/* Time Axis */}
          <div className="border-b border-gray-700 mb-2 flex">
            {Array.from({ length: maxTime + 2 }).map((_, i) => (
              <div key={i} className="absolute text-[8px] text-gray-500 border-l border-gray-800 h-full pl-0.5" style={{ left: `${i * 20}px` }}>
                {i}
              </div>
            ))}
          </div>

          {/* Threads */}
          <div className="space-y-1 mt-6">
            {threadsWithHistory.map(t => (
              <div key={t.id} className="relative h-6 w-full flex items-center group">
                <div className="absolute left-0 w-16 text-[9px] text-gray-400 font-mono z-10 bg-gray-900/80 pr-2">
                  T{t.id} (P{t.processId})
                </div>
                {t.history.map((h, idx) => (
                  <div
                    key={idx}
                    className="absolute h-4 rounded-sm border border-white/10 hover:brightness-110 transition-all"
                    style={{
                      left: `${h.start * 20}px`,
                      width: `${(h.end - h.start) * 20}px`,
                      backgroundColor: t.color,
                      opacity: 0.8
                    }}
                    title={`T${t.id}: ${h.start}-${h.end}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
};

// --- NEW COMPONENT: TEST CASES / MANUAL ---
const TestCasesPanel = ({ onClose, onLoadScenario }) => (
  <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
    <Card className="w-full max-w-4xl max-h-[90vh] flex flex-col bg-gray-900 border-cyan-500/30 shadow-2xl relative">
      <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">
        <X size={24} />
      </button>

      <div className="flex items-center gap-3 mb-6 border-b border-gray-800 pb-4">
        <BookOpen className="text-cyan-400" size={24} />
        <h2 className="text-xl font-bold text-white">NEON OS Simulator User Manual</h2>
      </div>

      <div className="overflow-y-auto pr-2 space-y-6 text-gray-300 scrollbar-thin">

        {/* SECTION 1: HOW TO USE */}
        <section>
          <h3 className="text-lg font-bold text-cyan-400 mb-3">How to Use the Simulator</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-gray-800/50 p-3 rounded border border-gray-700">
              <h4 className="font-bold text-white mb-2">1. Control Panel</h4>
              <ul className="list-disc list-inside text-xs space-y-1 text-gray-400">
                <li><strong className="text-gray-200">Play/Pause:</strong> Starts or pauses the simulation clock.</li>
                <li><strong className="text-gray-200">Reset:</strong> Clears all threads, processes, and resources.</li>
                <li><strong className="text-gray-200">Threading Model:</strong> Select One-to-One, Many-to-One, or Many-to-Many.</li>
                <li><strong className="text-gray-200">CPUs:</strong> Set CPU cores (1-4).</li>
                <li><strong className="text-gray-200">Sim Speed:</strong> Drag slider (100ms = fast, 2000ms = slow).</li>
                <li><strong className="text-gray-200">Create Process:</strong> Spawn new process with N threads.</li>
              </ul>
            </div>
            <div className="bg-gray-800/50 p-3 rounded border border-gray-700">
              <h4 className="font-bold text-white mb-2">2. Visualizer & Resources</h4>
              <ul className="list-disc list-inside text-xs space-y-1 text-gray-400">
                <li><strong className="text-gray-200">CPU Cards:</strong> Shows running threads. Hover to interact.</li>
                <li><strong className="text-gray-200">Queues:</strong> Ready (waiting for CPU) & Blocked (waiting for I/O).</li>
                <li><strong className="text-gray-200">Monitor (Buffer):</strong> Visualizes Mutex Lock & CV Queues.</li>
                <li><strong className="text-gray-200">Kernel Resources:</strong> System semaphores (DB, Printer).</li>
              </ul>
            </div>
          </div>
        </section>

        {/* SECTION 2: TEST CASES */}
        <section>
          <h3 className="text-lg font-bold text-purple-400 mb-3">Test Cases & Concepts</h3>
          <div className="space-y-4">

            {/* TC 1 */}
            <div className="border border-gray-700 rounded p-4 hover:bg-gray-800/30 transition-colors">
              <h4 className="font-bold text-white flex items-center gap-2">
                <span className="bg-cyan-900 text-cyan-300 px-2 py-0.5 rounded text-xs">TC 1</span>
                Round Robin Scheduling
              </h4>
              <p className="text-xs text-gray-500 mt-1 mb-2">Concept: Time Slicing. CPU gives each thread a Quantum before switching.</p>
              <div className="bg-black/40 p-2 rounded text-xs font-mono text-green-400">
                1. Set CPUs to 1.<br />
                2. Set Threads to 3, Click Spawn.<br />
                3. Click Play.<br />
                Observation: T1, T2, T3 cycle through CPU. Logs show "Quantum Expired".
              </div>
              <button onClick={() => onLoadScenario("RR")} className="mt-2 w-full bg-cyan-900/50 hover:bg-cyan-800 text-cyan-200 text-xs font-bold py-1 rounded border border-cyan-700">
                Run Scenario
              </button>
            </div>

            {/* TC 2 */}
            <div className="border border-gray-700 rounded p-4 hover:bg-gray-800/30 transition-colors">
              <h4 className="font-bold text-white flex items-center gap-2">
                <span className="bg-cyan-900 text-cyan-300 px-2 py-0.5 rounded text-xs">TC 2</span>
                Many-to-One Blocking
              </h4>
              <p className="text-xs text-gray-500 mt-1 mb-2">Concept: Entire process blocks if one thread makes a System Call (holding the single LWP).</p>
              <div className="bg-black/40 p-2 rounded text-xs font-mono text-green-400">
                1. Reset. Set Model to "Many-to-One". Set CPUs to 2.<br />
                2. Spawn Process (2 Threads).<br />
                3. Wait for T1 to run. Hover T1 &rarr; Click "Req DB".<br />
                Observation: T1 blocks (System). T2 CANNOT run even if CPU is free (LWP held).
              </div>
              <button onClick={() => onLoadScenario("M2O")} className="mt-2 w-full bg-cyan-900/50 hover:bg-cyan-800 text-cyan-200 text-xs font-bold py-1 rounded border border-cyan-700">
                Run Scenario
              </button>
            </div>

            {/* TC 3 */}
            <div className="border border-gray-700 rounded p-4 hover:bg-gray-800/30 transition-colors">
              <h4 className="font-bold text-white flex items-center gap-2">
                <span className="bg-cyan-900 text-cyan-300 px-2 py-0.5 rounded text-xs">TC 3</span>
                One-to-One Concurrency
              </h4>
              <p className="text-xs text-gray-500 mt-1 mb-2">Concept: Each thread has its own LWP. One blocking does not affect others.</p>
              <div className="bg-black/40 p-2 rounded text-xs font-mono text-green-400">
                1. Reset. Set Model to "One-to-One".<br />
                2. Spawn Process (2 Threads).<br />
                3. T1 requests "Req DB".<br />
                Observation: T1 blocks, but T2 continues running immediately.
              </div>
              <button onClick={() => onLoadScenario("121")} className="mt-2 w-full bg-cyan-900/50 hover:bg-cyan-800 text-cyan-200 text-xs font-bold py-1 rounded border border-cyan-700">
                Run Scenario
              </button>
            </div>

            {/* TC 4 */}
            <div className="border border-gray-700 rounded p-4 hover:bg-gray-800/30 transition-colors">
              <h4 className="font-bold text-white flex items-center gap-2">
                <span className="bg-cyan-900 text-cyan-300 px-2 py-0.5 rounded text-xs">TC 4</span>
                Producer-Consumer (Monitor Logic)
              </h4>
              <p className="text-xs text-gray-500 mt-1 mb-2">Concept: Wait (sleep) and Signal (wake up) using Condition Variables.</p>
              <div className="bg-black/40 p-2 rounded text-xs font-mono text-green-400">
                1. Click "Run Scenario" below.<br />
                2. Click Play button.<br />
                Observation: The simulation automatically executes Monitor operations.<br />
                - T1 (Prod) enters, signals, and exits.<br />
                - T2 (Cons) enters, waits, and is woken up by T1.
              </div>
              <button onClick={() => onLoadScenario("MON")} className="mt-2 w-full bg-cyan-900/50 hover:bg-cyan-800 text-cyan-200 text-xs font-bold py-1 rounded border border-cyan-700">
                Run Scenario
              </button>
            </div>

            {/* TC 5 */}
            <div className="border border-gray-700 rounded p-4 hover:bg-gray-800/30 transition-colors">
              <h4 className="font-bold text-white flex items-center gap-2">
                <span className="bg-cyan-900 text-cyan-300 px-2 py-0.5 rounded text-xs">TC 5</span>
                Deadlock (Circular Wait)
              </h4>
              <p className="text-xs text-gray-500 mt-1 mb-2">Concept: T1 holds A wants B. T2 holds B wants A.</p>
              <div className="bg-black/40 p-2 rounded text-xs font-mono text-green-400">
                1. Click "Run Scenario" below.<br />
                2. Click Play button.<br />
                Observation: The simulation automatically executes Resource requests.<br />
                - T1 acquires DB, then requests Printer (Blocks).<br />
                - T2 acquires Printer, then requests DB (Blocks).<br />
                Result: Deadlock. Both stuck.
              </div>
              <button onClick={() => onLoadScenario("DL")} className="mt-2 w-full bg-cyan-900/50 hover:bg-cyan-800 text-cyan-200 text-xs font-bold py-1 rounded border border-cyan-700">
                Run Scenario
              </button>
            </div>

          </div>
        </section>
      </div>
    </Card>
  </div>
);

// --- MAIN APP ---

export default function App() {
  const [state, dispatch] = useReducer(schedulerReducer, initialState);
  const [speed, setSpeed] = useState(1000);
  const [procConfig, setProcConfig] = useState({ threads: 3, burst: 15, priority: 1, delay: 0 });
  const [showHighway, setShowHighway] = useState(false);
  const [showGantt, setShowGantt] = useState(true);
  const [showTestCases, setShowTestCases] = useState(false);

  useEffect(() => {
    let interval = null;
    if (state.isRunning) {
      interval = setInterval(() => { dispatch({ type: 'TICK' }); }, speed);
    }
    return () => clearInterval(interval);
  }, [state.isRunning, speed]);

  const loadScenario = (key) => {
    const scenario = TEST_SCENARIOS[key];
    if (!scenario) return;

    dispatch({ type: 'RESET' });
    dispatch({ type: 'UPDATE_CONFIG', payload: scenario.config });

    // Slight delay to allow reset to process before creating processes
    setTimeout(() => {
      scenario.processes.forEach(p => {
        dispatch({ type: 'CREATE_PROCESS', payload: { threadCount: p.threads, burst: p.burst, priority: p.priority, model: scenario.config.threadingModel, arrivalDelay: p.delay, instructions: p.instructions } });
      });
      setShowTestCases(false);
    }, 100);
  };

  const createProcess = () => {
    dispatch({
      type: 'CREATE_PROCESS',
      payload: {
        threadCount: procConfig.threads,
        burst: procConfig.burst,
        priority: procConfig.priority,
        arrivalDelay: procConfig.delay,
        model: state.config.threadingModel
      }
    });
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 font-sans selection:bg-cyan-500/30">
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
            <button
              onClick={() => setShowTestCases(true)}
              className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-cyan-400 px-3 py-1 rounded border border-gray-700 transition-colors"
            >
              <BookOpen size={14} />
              <span>Manual</span>
            </button>
          </div>
        </div>
      </header>

      {showTestCases && <TestCasesPanel onClose={() => setShowTestCases(false)} onLoadScenario={loadScenario} />}

      <main className="max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-12 gap-6">

        <div className="lg:col-span-3 space-y-4">
          <Card>
            <div className="flex gap-2 mb-4">
              <button onClick={() => dispatch({ type: 'TOGGLE_RUN' })}
                className={`flex - 1 flex items - center justify - center gap - 2 py - 3 rounded - lg font - bold transition - all ${state.isRunning ? 'bg-amber-500/10 text-amber-500 border border-amber-500/50' : 'bg-emerald-600 text-white hover:bg-emerald-500'} `}>
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
              </div>

              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Algorithm</label>
                <select className="w-full bg-gray-900 border border-gray-700 rounded text-xs p-2 mt-1 focus:border-cyan-500 outline-none"
                  value={state.config.algorithm}
                  onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', payload: { algorithm: e.target.value } })}>
                  <option value="RR">Round Robin (RR)</option>
                  <option value="FCFS">First-Come First-Serve (FCFS)</option>
                  <option value="SJF">Shortest Job First (SJF)</option>
                  <option value="Priority">Priority Scheduling</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-500">CPUs</label>
                  <input type="number" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-center text-xs"
                    value={state.config.cpuCount} onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', payload: { cpuCount: parseInt(e.target.value) } })} min="1" max="4" />
                </div>
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
                <div>
                  <label className="text-[9px] text-gray-600">Res Timeout (Ticks)</label>
                  <input type="number" min="0" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-xs text-center mt-1"
                    value={state.config.resourceTimeLimit}
                    onChange={(e) => dispatch({ type: 'UPDATE_CONFIG', payload: { resourceTimeLimit: parseInt(e.target.value) } })}
                  />
                </div>
              </div>
            </div>

            {/* TOGGLE VISUALIZER BUTTON */}
            <div className="pt-4 mt-2 border-t border-gray-800">
              <button
                onClick={() => setShowHighway(!showHighway)}
                className={`w-full py-2 rounded text-xs font-bold border transition-colors flex items-center justify-center gap-2 ${showHighway ? 'bg-cyan-900/40 border-cyan-500 text-cyan-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
              >
                {showHighway ? <EyeOff size={14} /> : <Eye size={14} />}
                {showHighway ? 'Hide Highway Visualizer' : 'Show Highway Visualizer'}
              </button>
              <button
                onClick={() => setShowGantt(!showGantt)}
                className={`w-full py-2 rounded text-xs font-bold border transition-colors flex items-center justify-center gap-2 mt-4 ${showGantt ? 'bg-purple-900/40 border-purple-500 text-purple-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
              >
                {showGantt ? <EyeOff size={14} /> : <Eye size={14} />}
                {showGantt ? 'Hide Gantt Chart' : 'Show Gantt Chart'}
              </button>
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
                <div>
                  <label className="text-[9px] text-gray-600">Delay</label>
                  <input type="number" className="w-full bg-gray-900 border border-gray-700 rounded p-1 text-xs text-center"
                    value={procConfig.delay} onChange={e => setProcConfig({ ...procConfig, delay: parseInt(e.target.value) })} min="0" />
                </div>
              </div>
              <button onClick={createProcess} className="w-full bg-cyan-900/40 border border-cyan-800 hover:bg-cyan-900/60 text-cyan-400 text-xs py-2 rounded flex items-center justify-center gap-2">
                <Plus size={14} /> Spawn Process
              </button>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-6 space-y-4">
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

        <div className="lg:col-span-3 space-y-4">
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
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-gray-500 w-12">ENTRY Q</span>
                  <div className="flex gap-1">
                    {state.monitors["Buffer"].queue.length === 0 && <span className="text-[9px] text-gray-700">-</span>}
                    {state.monitors["Buffer"].queue.map(id => <span key={id} className="text-[9px] bg-gray-700 px-1 rounded">T{id}</span>)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-yellow-600 w-12">NotEmpty</span>
                  <div className="flex gap-1">
                    {state.monitors["Buffer"].cvs["NotEmpty"].length === 0 && <span className="text-[9px] text-gray-700">-</span>}
                    {state.monitors["Buffer"].cvs["NotEmpty"].map(id => <span key={id} className="text-[9px] bg-yellow-900/30 text-yellow-500 px-1 rounded">T{id}</span>)}
                  </div>
                </div>
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
                    <div className="flex flex-wrap gap-1 mt-1">
                      {res.holders.map((h, i) => (
                        <div key={i} className="flex items-center gap-1 bg-gray-700 px-1.5 py-0.5 rounded text-[10px] text-gray-300">
                          <span>T{h}</span>
                          <button
                            onClick={() => dispatch({ type: 'RESOURCE_OP', payload: { tid: h, resName: name, op: 'REL' } })}
                            className="text-red-400 hover:text-red-300 ml-1"
                            title="Force Release"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
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

        {/* --- NEW SECTION: KERNEL HIGHWAY VISUALIZER --- */}
        {showHighway && <HighwayVisualizer state={state} />}

        {/* --- NEW SECTION: GANTT CHART --- */}
        {showGantt && <GanttChart state={state} />}

      </main>
    </div>
  );
}
