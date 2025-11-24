# scheduler.py
# Part of OS Simulator Module
from app.models.thread_model import ThreadModel

COLORS = [
    "#3B82F6", "#EF4444", "#10B981", "#F59E0B", 
    "#8B5CF6", "#EC4899", "#6366F1", "#14B8A6"
]

class Scheduler:
    def __init__(self):
        self.threads = []
        self.current_time = 0
        self.logs = []
        
        # Configurable settings
        self.algorithm = "RR" # FCFS, SJF, PRIORITY, RR
        self.is_preemptive = False
        self.time_quantum = 3
        self.cpu_count = 1
        
        # Runtime State
        # List of None (idle) or ThreadModel objects, indexed by CPU ID
        self.running_threads = [None] * self.cpu_count 
        # Dictionary to track quantum usage per CPU: {cpu_id: counter}
        self.cpu_quantum_counters = {} 
        self.queue_counter = 0 # Monotonic counter for FIFO ordering

    def update_config(self, algorithm, cpu_count, is_preemptive, quantum):
        """Updates settings from UI"""
        self.algorithm = algorithm
        self.is_preemptive = is_preemptive
        self.time_quantum = quantum
        
        # If CPU count changed, resize the running list
        if cpu_count != self.cpu_count:
            old_count = self.cpu_count
            self.cpu_count = cpu_count
            # Resize running list (handling expansion or reduction)
            if cpu_count > old_count:
                self.running_threads.extend([None] * (cpu_count - old_count))
            else:
                # If reducing, force detach extra threads back to ready
                for i in range(cpu_count, old_count):
                    t = self.running_threads[i]
                    if t:
                        t.state = "READY"
                        t.cpu_id = -1
                        self.log(f"CPU {i} Removed. T{t.id} -> Ready")
                self.running_threads = self.running_threads[:cpu_count]

    def log(self, message):
        entry = f"[{self.current_time:03d}] {message}"
        self.logs.insert(0, entry)

    def create_thread(self, burst, priority, arrival_time):
        t_id = len(self.threads) + 1
        color = COLORS[(t_id - 1) % len(COLORS)]
        new_thread = ThreadModel(t_id, burst, priority, arrival_time, color)
        self.threads.append(new_thread)
        self.log(f"Thread T{t_id} Created (Burst: {burst}, Prio: {priority}, Arr: {arrival_time})")

    def force_block(self, t_id):
        """User manually blocks a running thread"""
        for cpu_id, t in enumerate(self.running_threads):
            if t and t.id == t_id:
                t.state = "BLOCKED"
                t.cpu_id = -1
                self.running_threads[cpu_id] = None
                self.cpu_quantum_counters[cpu_id] = 0
                self.log(f"Thread T{t.id} Blocked (Manual I/O)")
                return

    def unblock(self, t_id):
        for t in self.threads:
            if t.id == t_id and t.state == "BLOCKED":
                t.state = "READY"
                t.queue_sequence = self.queue_counter
                self.queue_counter += 1
                self.log(f"Thread T{t.id} Unblocked -> Ready")
                return

    def reset(self):
        self.threads = []
        self.current_time = 0
        self.logs = []
        self.running_threads = [None] * self.cpu_count
        self.cpu_quantum_counters = {}
        self.queue_counter = 0

    # --- CORE ALGORITHMS ---

    def get_best_ready_thread(self):
        """Selects the next thread based on the active Algorithm"""
        ready_candidates = [t for t in self.threads if t.state == "READY"]
        if not ready_candidates:
            return None

        if self.algorithm == "FCFS":
            # First Come First Serve: Sort by Arrival Time, then ID
            return sorted(ready_candidates, key=lambda x: (x.arrival_time, x.id))[0]
        
        elif self.algorithm == "RR":
             # RR uses FIFO for the queue part based on queue_sequence
            return sorted(ready_candidates, key=lambda x: x.queue_sequence)[0]
        
        elif self.algorithm == "SJF":
            # Shortest Job First: Sort by Remaining Burst Time
            return sorted(ready_candidates, key=lambda x: (x.remaining_time, x.arrival_time))[0]
            
        elif self.algorithm == "PRIORITY":
            # Priority: Higher number = Higher Priority
            # Sort by Priority (Desc), then Arrival (Asc)
            return sorted(ready_candidates, key=lambda x: (-x.priority, x.arrival_time))[0]
            
        return ready_candidates[0]

    def check_preemption(self, current_thread, candidate_thread):
        """Returns True if candidate should replace current based on algo"""
        if not self.is_preemptive:
            return False
        
        if self.algorithm == "SJF":
            return candidate_thread.remaining_time < current_thread.remaining_time
        
        if self.algorithm == "PRIORITY":
            return candidate_thread.priority > current_thread.priority
            
        return False # FCFS and RR generally handled by Quantum or Completion

    # --- TICK LOGIC ---

    def next_tick(self):
        self.current_time += 1
        
        # 1. Admit New Threads
        for t in self.threads:
            if t.state == "NEW" and t.arrival_time <= self.current_time:
                t.state = "READY"
                t.queue_sequence = self.queue_counter
                self.queue_counter += 1

        # 2. Process Each CPU Core
        for cpu_id in range(self.cpu_count):
            
            # Initialize Quantum counter if needed
            if cpu_id not in self.cpu_quantum_counters:
                self.cpu_quantum_counters[cpu_id] = 0

            running_t = self.running_threads[cpu_id]

            # --- A. IF CPU HAS A THREAD ---
            if running_t:
                # Update History
                if running_t.history and running_t.history[-1][2] == "RUNNING":
                    start, _, state = running_t.history.pop()
                    running_t.history.append((start, self.current_time, state))
                else:
                    running_t.history.append((self.current_time - 1, self.current_time, "RUNNING"))

                # Execute
                running_t.remaining_time -= 1
                self.cpu_quantum_counters[cpu_id] += 1

                # 1. Check Termination
                if running_t.remaining_time <= 0:
                    running_t.state = "TERMINATED"
                    running_t.turnaround_time = self.current_time - running_t.arrival_time
                    running_t.waiting_time = running_t.turnaround_time - running_t.burst_time
                    running_t.cpu_id = -1
                    self.running_threads[cpu_id] = None
                    self.log(f"CPU {cpu_id}: T{running_t.id} Terminated")
                    self.cpu_quantum_counters[cpu_id] = 0
                
                # 2. Check Quantum (RR Only)
                elif self.algorithm == "RR" and self.cpu_quantum_counters[cpu_id] >= self.time_quantum:
                    running_t.state = "READY"
                    running_t.queue_sequence = self.queue_counter
                    self.queue_counter += 1
                    running_t.cpu_id = -1
                    self.running_threads[cpu_id] = None
                    self.log(f"CPU {cpu_id}: T{running_t.id} Quantum Expired")
                    self.cpu_quantum_counters[cpu_id] = 0
                
                # 3. Check Preemption (SJF / Priority)
                elif self.is_preemptive and (self.algorithm in ["SJF", "PRIORITY"]):
                    candidate = self.get_best_ready_thread()
                    if candidate and self.check_preemption(running_t, candidate):
                        running_t.state = "READY"
                        running_t.queue_sequence = self.queue_counter
                        self.queue_counter += 1
                        running_t.cpu_id = -1
                        self.running_threads[cpu_id] = None
                        self.log(f"CPU {cpu_id}: T{running_t.id} Preempted by T{candidate.id}")
                        self.cpu_quantum_counters[cpu_id] = 0

            # --- B. IF CPU IS FREE (Or just became free) ---
            if self.running_threads[cpu_id] is None:
                next_thread = self.get_best_ready_thread()
                if next_thread:
                    next_thread.state = "RUNNING"
                    next_thread.cpu_id = cpu_id
                    self.running_threads[cpu_id] = next_thread
                    self.cpu_quantum_counters[cpu_id] = 0
                    self.log(f"CPU {cpu_id}: Dispatched T{next_thread.id} ({self.algorithm})")